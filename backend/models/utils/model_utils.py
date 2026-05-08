import torch
import torch.nn as nn
from torch import distributed as dist
from ml_collections import ConfigDict
import numpy as np
from tqdm.auto import tqdm

from typing import List, Dict, Union

def bigshifts_wrapper(
    config: ConfigDict,
    model: torch.nn.Module,
    mix: torch.Tensor,
    device: torch.device,
    model_type: str,
    pbar: bool = False,
    bigshifts: int = 1
) -> Union[Dict[str, np.ndarray], np.ndarray]:
    '''
    BigShifts wrapper for inference-time demixing.

    Args:
        config (ConfigDict): The configuration dictionary for the model.
        model (torch.nn.Module): The loaded PyTorch model for source separation.
        mix (torch.Tensor): The input mixture audio tensor of shape (channels, samples).
        device (torch.device): The device to run inference on (e.g., 'cpu' or 'cuda').
        model_type (str): A string identifier for the type of model being used (e.g., "bs-roformer" or "decrowd").
        pbar (bool, optional): Whether to display a progress bar during processing. Defaults to False.
        bigshifts (int, optional): The number of BigShifts passes to perform. Defaults to 1.

    Returns:
        Union[Dict[str, np.ndarray], np.ndarray]: The separated sources as a dictionary of numpy arrays (if the model outputs a dict) or a single numpy array (if the model outputs a tensor).
    '''

    should_print = not dist.is_initialized() or dist.get_rank() == 0

    if bigshifts <= 0:
        bigshifts = 1

    if isinstance(mix, torch.Tensor):
        mix = mix.detach().cpu().numpy()

    shift_in_samples = mix.shape[1] // bigshifts
    shifts = [x * shift_in_samples for x in range(bigshifts)]
    results = []

    if pbar and should_print:
        shifts_iterator = tqdm(shifts, desc="BigShifts passes...", leave=False)
    else:
        shifts_iterator = shifts

    for shift in shifts_iterator:
        shifted_mix = np.concatenate((mix[:, -shift:], mix[:, :-shift]), axis=-1)
        sources = demix(config, model, shifted_mix, device, model_type, pbar)

        if isinstance(sources, dict):
            unshifted = {
                k: np.concatenate((v[..., shift:], v[..., :shift]), axis=-1)
                for k, v in sources.items()
            }
            results.append(unshifted)
        elif isinstance(sources, np.ndarray):
            unshifted = np.concatenate((sources[..., shift:], sources[..., :shift]), axis=-1)
            results.append(unshifted)
        else:
            raise ValueError("Unsupported return type from demix")

    if isinstance(results[0], dict):
        avg_result = {}
        for k in results[0]:
            avg_result[k] = np.mean([r[k] for r in results], axis=0)
        return avg_result
    return np.mean(results, axis=0)

def demix(
    config: ConfigDict,
    model: torch.nn.Module,
    mix: torch.Tensor,
    device: torch.device,
    model_type: str,
    pbar: bool = False
) -> Union[Dict[str, np.ndarray], np.ndarray]:
    """
    Perform audio source separation with a given model.

    Supports both Demucs-specific and generic processing modes, including
    overlapping chunk-based inference with optional progress bar display.
    Handles padding, fading, and batching to reduce artifacts during separation.

    Args:
        config (ConfigDict): Configuration object with audio and inference
            parameters (chunk size, overlap, batch size, etc.).
        model (torch.nn.Module): Source separation model for inference.
        mix (torch.Tensor): Input audio tensor of shape (channels, time).
        device (torch.device): Device on which to run inference (CPU or CUDA).
        model_type (str): Type of model (e.g., 'htdemucs', 'mdx23c') that
            determines processing mode.
        pbar (bool, optional): If True, show a progress bar during chunk
            processing. Defaults to False.

    Returns:
        Union[Dict[str, np.ndarray], np.ndarray]:
            - Dictionary mapping instrument names to separated waveforms if
              multiple instruments are predicted.
            - NumPy array of separated audio if only a single instrument is
              present (Demucs mode).
    """

    should_print = not dist.is_initialized() or dist.get_rank() == 0

    mix = torch.tensor(mix, dtype=torch.float32)

    if model_type == 'htdemucs':
        mode = 'demucs'
    else:
        mode = 'generic'
    # Define processing parameters based on the mode
    if mode == 'demucs':
        chunk_size = config.training.samplerate * config.training.segment
        num_instruments = len(config.training.instruments)
        num_overlap = config.inference.num_overlap
        step = chunk_size // num_overlap
    else:
        if 'chunk_size' in config.inference:
            chunk_size = config.inference.chunk_size
        else:
            chunk_size = config.audio.chunk_size
        num_instruments = len(prefer_target_instrument(config))
        num_overlap = config.inference.num_overlap

        fade_size = chunk_size // 10
        step = chunk_size // num_overlap
        border = chunk_size - step
        length_init = mix.shape[-1]
        windowing_array = _getWindowingArray(chunk_size, fade_size)
        # Add padding for generic mode to handle edge artifacts
        if length_init > 2 * border and border > 0:
            mix = nn.functional.pad(mix, (border, border), mode="reflect")

    batch_size = config.inference.batch_size

    use_amp = getattr(config.training, 'use_amp', True)

    with torch.cuda.amp.autocast(enabled=use_amp):
        with torch.inference_mode():
            # Initialize result and counter tensors
            req_shape = (num_instruments,) + mix.shape
            result = torch.zeros(req_shape, dtype=torch.float32)
            counter = torch.zeros(req_shape, dtype=torch.float32)

            i = 0
            batch_data = []
            batch_locations = []
            if pbar and should_print:
                progress_bar = tqdm(
                    total=mix.shape[1], desc="Processing audio chunks", leave=False
                )
            else:
                progress_bar = None

            while i < mix.shape[1]:
                # Extract chunk and apply padding if necessary
                part = mix[:, i:i + chunk_size].to(device)
                chunk_len = part.shape[-1]
                if mode == "generic" and chunk_len > chunk_size // 2:
                    pad_mode = "reflect"
                else:
                    pad_mode = "constant"
                part = nn.functional.pad(part, (0, chunk_size - chunk_len), mode=pad_mode, value=0)

                batch_data.append(part)
                batch_locations.append((i, chunk_len))
                i += step

                # Process batch if it's full or the end is reached
                if len(batch_data) >= batch_size or i >= mix.shape[1]:
                    arr = torch.stack(batch_data, dim=0)
                    x = model(arr)

                    if mode == "generic":
                        window = windowing_array.clone() # using clone() fixes the clicks at chunk edges when using batch_size=1
                        if i - step == 0:  # First audio chunk, no fadein
                            window[:fade_size] = 1
                        elif i >= mix.shape[1]:  # Last audio chunk, no fadeout
                            window[-fade_size:] = 1

                    for j, (start, seg_len) in enumerate(batch_locations):
                        if mode == "generic":
                            result[..., start:start + seg_len] += x[j, ..., :seg_len].cpu() * window[..., :seg_len]
                            counter[..., start:start + seg_len] += window[..., :seg_len]
                        else:
                            result[..., start:start + seg_len] += x[j, ..., :seg_len].cpu()
                            counter[..., start:start + seg_len] += 1.0

                    batch_data.clear()
                    batch_locations.clear()

                if progress_bar:
                    progress_bar.update(step)

            if progress_bar:
                progress_bar.close()

            # Compute final estimated sources
            estimated_sources = result / counter
            estimated_sources = estimated_sources.cpu().numpy()
            np.nan_to_num(estimated_sources, copy=False, nan=0.0)

            # Remove padding for generic mode
            if mode == "generic":
                if length_init > 2 * border and border > 0:
                    estimated_sources = estimated_sources[..., border:-border]

    # Return the result as a dictionary or a single array
    if mode == "demucs":
        instruments = config.training.instruments
    else:
        instruments = prefer_target_instrument(config)

    ret_data = {k: v for k, v in zip(instruments, estimated_sources)}

    if mode == "demucs" and num_instruments <= 1:
        return estimated_sources
    else:
        return ret_data
    
def _getWindowingArray(window_size: int, fade_size: int) -> torch.Tensor:
    """
    Generate a windowing array with a linear fade-in at the beginning and a fade-out at the end.

    This function creates a window of size `window_size` where the first `fade_size` elements
    linearly increase from 0 to 1 (fade-in) and the last `fade_size` elements linearly decrease
    from 1 to 0 (fade-out). The middle part of the window is filled with ones.

    Parameters:
    ----------
    window_size : int
        The total size of the window.
    fade_size : int
        The size of the fade-in and fade-out regions.

    Returns:
    -------
    torch.Tensor
        A tensor of shape (window_size,) containing the generated windowing array.

    Example:
    -------
    If `window_size=10` and `fade_size=3`, the output will be:
    tensor([0.0000, 0.5000, 1.0000, 1.0000, 1.0000, 1.0000, 1.0000, 1.0000, 0.5000, 0.0000])
    """

    fadein = torch.linspace(0, 1, fade_size)
    fadeout = torch.linspace(1, 0, fade_size)

    window = torch.ones(window_size)
    window[-fade_size:] = fadeout
    window[:fade_size] = fadein
    return window

def prefer_target_instrument(config: ConfigDict) -> List[str]:
    """
    Return the list of target instruments based on the configuration.
    If a specific target instrument is specified in the configuration,
    it returns a list with that instrument. Otherwise, it returns the list of instruments.

    Parameters:
    ----------
    config : ConfigDict
        Configuration object containing the list of instruments or the target instrument.

    Returns:
    -------
    List[str]
        A list of target instruments.
        """
    if getattr(config.training, 'target_instrument', None):
        return [config.training.target_instrument]
    else:
        return config.training.instruments