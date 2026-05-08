from __future__ import annotations

import torch
import torch.nn.functional as F

from collections import namedtuple
from math import pi

import torch
from torch import arange, cat, stack, is_tensor, Tensor
from torch.nn import Module, Parameter
from torch.amp import autocast

from einops import einsum, rearrange, repeat

# helper functions
def exists(v):
    return v is not None

def default(v, d):
    return v if exists(v) else d

def divisible_by(num, den):
    return (num % den) == 0

def slice_at_dim(t, slc, dim = -1):
    dims = t.ndim
    dim = (dim + dims) if dim < 0 else dim

    full_slice = [slice(None)] * dims
    full_slice[dim] = slc

    return t[tuple(full_slice)]

def slice_right_at_dim(t, length, dim = -1):
    if length == 0:
        return slice_at_dim(t, slice(0, 0), dim = dim)

    return slice_at_dim(t, slice(-length, None), dim = dim)

# triton available
TRITON_AVAILABLE = False
# try:
#     from .triton_pope import triton_compute_qk_similarity
#     from .triton_pope_flash_attn import flash_attn
#     TRITON_AVAILABLE = True
# except ImportError:
#     TRITON_AVAILABLE = False

# constants
PolarEmbedReturn = namedtuple('PolarEmbedReturn', ('freqs', 'bias'))

# helper functions
def exists(v):
    return v is not None

def default(v, d):
    return v if exists(v) else d

# applying pope to qk
@autocast('cuda', enabled = False)
def apply_pope_to_qk(
    pope: PolarEmbedReturn,
    q, k,
    to_magnitude = F.softplus,
    return_complex = False
):
    freqs, bias = pope

    q_len, k_len, qk_dim, rotate_dim = q.shape[-2], k.shape[-2], q.shape[-1], freqs.shape[-1]

    assert q_len <= k_len and rotate_dim <= qk_dim

    is_partial_rotate = rotate_dim < qk_dim

    if is_partial_rotate:
        q, q_rest = q[..., :rotate_dim], q[..., rotate_dim:]
        k, k_rest = k[..., :rotate_dim], k[..., rotate_dim:]

        if return_complex:
            q_rest = torch.polar(q_rest, torch.zeros_like(q_rest))
            k_rest = torch.polar(k_rest, torch.zeros_like(k_rest))

    if freqs.ndim == 3:
        freqs = rearrange(freqs, 'b n d -> b 1 n d')

    freqs_with_bias = freqs + rearrange(bias, 'h d -> h 1 d')

    # convert q and k to polar magnitudes with activation
    q, k = to_magnitude(q), to_magnitude(k)

    # apply rotations
    freqs = slice_right_at_dim(freqs, q_len, dim = -2)

    if return_complex:
        q = torch.polar(q, freqs)
    else:
        qcos, qsin = freqs.cos(), freqs.sin()
        q = rearrange([q * qcos, q * qsin], 'two ... d -> ... (d two)')

    # handle inference
    if return_complex:
        k = torch.polar(k, freqs_with_bias)
    else:
        kcos, ksin = freqs_with_bias.cos(), freqs_with_bias.sin()
        k = rearrange([k * kcos, k * ksin], 'two ... d -> ... (d two)')

    # concat
    if is_partial_rotate:
        q = cat((q, q_rest), dim = -1)
        k = cat((k, k_rest), dim = -1)

    return q, k

# main pope class
class PoPE(Module):
    apply_pope_to_qk = staticmethod(apply_pope_to_qk)

    def __init__(
        self,
        dim,
        *,
        heads,
        theta = 10000,
        bias_uniform_init = False,
        inv_freqs: Tensor | list[float] | None = None
    ):
        super().__init__()

        # freqs

        if not exists(inv_freqs):
            inv_freqs = theta ** -(arange(dim).float() / dim)

        self.register_buffer('inv_freqs', inv_freqs)

        # the learned bias on the keys
        self.bias = Parameter(torch.zeros(heads, dim))

        if bias_uniform_init:
            self.bias.uniform_(-2. * pi, 0.)

    @property
    def device(self):
        return self.inv_freqs.device

    @autocast('cuda', enabled = False)
    def forward(
        self,
        pos_or_seq_len: Tensor | int,
        offset = 0
    ):
        # get positions depending on input
        if is_tensor(pos_or_seq_len):
            pos = pos_or_seq_len
        else:
            seq_len = pos_or_seq_len
            pos = arange(seq_len, device = self.device, dtype = self.inv_freqs.dtype)

        pos = pos + offset

        # freqs
        freqs = einsum(pos, self.inv_freqs, '... i, j -> ... i j')

        # the bias, with clamping
        bias = self.bias.clamp(-2. * pi, 0.)

        return PolarEmbedReturn(freqs, bias)

# functions

def compute_attn_similarity_non_fused(
    q,
    k,
    pope,
    head_dimension_at_first = True
):
    if not head_dimension_at_first:
        q = rearrange(q, 'b n h d -> b h n d')
        k = rearrange(k, 'b n h d -> b h n d')
    
    q, k = apply_pope_to_qk(pope, q, k, to_magnitude = F.softplus)

    # group query attention support

    groups = q.shape[1] // k.shape[1]
    k = repeat(k, 'b h ... -> b (g h) ...', g = groups)

    return torch.einsum('b h i d, b h j d -> b h i j', q, k)

def compute_attn_similarity(
    q,
    k,
    pope,
    allow_tf32 = True,
    head_dimension_at_first = True
):
    assert divisible_by(q.shape[1 if head_dimension_at_first else 2], k.shape[1 if head_dimension_at_first else 2])

    freqs, bias = pope
    head_dim = q.shape[-1]

    assert head_dim in {32, 48, 64, 128, 256}, f"head_dim {head_dim} not in common sizes"

    is_cuda = q.is_cuda and k.is_cuda and freqs.is_cuda and bias.is_cuda

    if TRITON_AVAILABLE and is_cuda:
        if not head_dimension_at_first:
            q = rearrange(q, 'b n h d -> b h n d')
            k = rearrange(k, 'b n h d -> b h n d')

        rotate_dim = freqs.shape[-1]
        return triton_compute_qk_similarity(q, k, freqs, bias, rotate_dim, allow_tf32 = allow_tf32)

    return compute_attn_similarity_non_fused(q, k, pope, head_dimension_at_first = head_dimension_at_first)

def flash_attn_with_pope(
    q,
    k,
    v,
    pos_emb = None,
    mask = None,
    causal = False,
    softmax_scale = None,
    fused = None,
    head_dimension_at_first = True
):
    fused = default(fused, TRITON_AVAILABLE and q.is_cuda)

    softmax_scale = default(softmax_scale, q.shape[-1] ** -0.5)

    if fused:
        # fused kernel expects (batch, seq, heads, dim)
        if head_dimension_at_first:
            q = rearrange(q, 'b h n d -> b n h d')
            k = rearrange(k, 'b h n d -> b n h d')
            v = rearrange(v, 'b h n d -> b n h d')

        freqs, bias = pos_emb
        out = flash_attn(q, k, v, freqs = freqs, pope_bias = bias, mask = mask, causal = causal, softmax_scale = softmax_scale)

        if head_dimension_at_first:
            out = rearrange(out, 'b n h d -> b h n d')

        return out

    # non-fused manual path
    # standardize to (batch, heads, seq, dim)
    if not head_dimension_at_first:
        q = rearrange(q, 'b n h d -> b h n d')
        k = rearrange(k, 'b n h d -> b h n d')
        v = rearrange(v, 'b n h d -> b h n d')

    q, k = apply_pope_to_qk(pos_emb, q, k, to_magnitude = F.softplus)
    
    # group query attention support

    groups = q.shape[1] // k.shape[1]
    k = repeat(k, 'b h ... -> b (g h) ...', g = groups)
    v = repeat(v, 'b h ... -> b (g h) ...', g = groups)

    # manual attention path using SDPA
    # ensure dtypes match for SDPA (apply_pope_to_qk might have upcasted to float32)

    v_dtype = v.dtype
    if q.dtype != v.dtype:
        v = v.to(q.dtype)

    attn_mask = None
    if exists(mask):
        attn_mask = rearrange(mask, 'b j -> b 1 1 j')

    out = F.scaled_dot_product_attention(
        q, k, v,
        attn_mask = attn_mask,
        is_causal = causal,
        scale = softmax_scale
    )

    out = out.to(v_dtype)

    if not head_dimension_at_first:
        out = rearrange(out, 'b h n d -> b n h d')

    return out

def triton_compute_qk_similarity():
    raise NotImplementedError("Triton compute_qk_similarity is not implemented in this environment")

def flash_attn():
    raise NotImplementedError("Triton flash_attn is not implemented in this environment")