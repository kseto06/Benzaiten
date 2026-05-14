import numpy as np
import torch
import torchaudio
import librosa
import soundfile
import os
import yaml
import typing
from ml_collections import ConfigDict

from huggingface_hub import hf_hub_download
from ..models.BSRoformer import BSRoformer
from ..models.MelBandRoformer import MelBandRoformer
from ..models.utils.model_utils import bigshifts_wrapper

def dict_to_configdict(d: dict):
    """
    Convert a dictionary to a ConfigDict (nested dictionaries).

    Args:
        d (dict): The input dictionary to convert.
    Returns:
        dict: A new dictionary where nested dictionaries are converted to ConfigDicts.
    """
    if isinstance(d, dict):
        return ConfigDict({
            k: dict_to_configdict(v) for k, v in d.items()
        })
    
    return d

def run_karaoke_inference(model_name: str, audio_path: str, output_path: str = "./backend/tests/audio_outputs/") -> typing.IO[str]:
    '''
    Run inference with the specified model. Current models supported are:
    - "bs-roformer": BS-RoFormer model (by Becruily) for high-quality music source separation 
    - "decrowd": MelBand-RoFormer model for decrowding separation 
    '''
    models = {
        "bs-roformer": ("./backend/models/BS-RoFormer/bs_roformer_karaoke.ckpt", "./backend/models/BS-RoFormer/bs_roformer_config_karaoke.yaml"),
        "decrowd": ("./backend/models/MelBand-RoFormer-DeCrowd/mel_band_roformer_decrowd.ckpt", "./backend/models/MelBand-RoFormer-DeCrowd/model_mel_band_roformer_decrowd.yaml")
    }

    if model_name not in models:
        raise ValueError(f"Model '{model_name}' is not supported. Supported models are: {list(models.keys())}")

    if model_name == "bs-roformer":
        # download models from hugging face repo
        ckpt = torch.load(
            hf_hub_download(
                repo_id="kseto06/benzaiten",
                filename="bs_roformer_karaoke.ckpt"
            ),
            map_location="cpu"
        )
        
        with open(
            hf_hub_download(
                repo_id="kseto06/benzaiten",
                filename="bs_roformer_config_karaoke.yaml"
            ), 
        "r") as f:
            cfg = yaml.load(f, Loader=yaml.FullLoader)

        model_cfg = cfg["model"]

        model = BSRoformer(
            dim=model_cfg["dim"],
            depth=model_cfg["depth"],

            stereo=model_cfg["stereo"],
            num_stems=model_cfg["num_stems"],

            time_transformer_depth=model_cfg["time_transformer_depth"],
            freq_transformer_depth=model_cfg["freq_transformer_depth"],
            linear_transformer_depth=model_cfg["linear_transformer_depth"],

            freqs_per_bands=tuple(model_cfg["freqs_per_bands"]),

            dim_head=model_cfg["dim_head"],
            heads=model_cfg["heads"],

            attn_dropout=model_cfg["attn_dropout"],
            ff_dropout=model_cfg["ff_dropout"],
            flash_attn=model_cfg["flash_attn"],

            dim_freqs_in=model_cfg["dim_freqs_in"],

            stft_n_fft=model_cfg["stft_n_fft"],
            stft_hop_length=model_cfg["stft_hop_length"],
            stft_win_length=model_cfg["stft_win_length"],
            stft_normalized=model_cfg["stft_normalized"],

            zero_dc=False,

            mask_estimator_depth=model_cfg["mask_estimator_depth"],

            multi_stft_resolution_loss_weight=model_cfg["multi_stft_resolution_loss_weight"],
            multi_stft_resolutions_window_sizes=tuple(
                model_cfg["multi_stft_resolutions_window_sizes"]
            ),
            multi_stft_hop_size=model_cfg["multi_stft_hop_size"],
            multi_stft_normalized=model_cfg["multi_stft_normalized"],

            mlp_expansion_factor=model_cfg["mlp_expansion_factor"],

            use_torch_checkpoint=False,
            skip_connection=False,
            use_pope=False,
        )

        missing, unexpected = model.load_state_dict(ckpt, strict=True)

        if missing or unexpected:
            raise ValueError(f"State dict keys mismatch. Missing keys: {missing}, Unexpected keys: {unexpected}")

        # init of audio and configs
        device = torch.device(
            "cuda" if torch.cuda.is_available()
            else "mps" if torch.backends.mps.is_available()
            else "cpu"
        )

        config = dict_to_configdict(cfg)

        # locally-ran configs, due to high memory allocation.
        # might be able to delete if cloud inference can be setup
        config.audio.chunk_size = 44100 * 5
        config.inference.batch_size = 1
        config.inference.num_overlap = 2

        model = model.to(device)
        model.eval()
        
        sample_rate = config.audio.sample_rate
        mix, sr = librosa.load(audio_path, sr=sample_rate, mono=False)

        # shape fixing
        if mix.ndim == 1:
            mix = np.expand_dims(mix, axis=0)

        # ensure stereo
        if mix.shape[0] == 1 and config.audio.num_channels == 2:
            mix = np.concatenate([mix, mix], axis=0)
        elif mix.shape[0] > 2:
            mix = mix[:2]

        # save original mixed audio so we can extract instrumentals later
        mix_orig = mix.copy()

        # inference with inference-time demixing
        with torch.inference_mode():
            waveform = bigshifts_wrapper(
                config=config,
                model=model,
                mix=mix,
                device=device,
                model_type="bs_roformer",
                pbar=True,
                bigshifts=1
            )
        
        # extract outputs
        vocals = waveform[config.training.target_instrument]
            
        if mix_orig.shape != vocals.shape:
            print("NOTE: mixed audio and vocals shape are not equal")
            min_length = min(mix_orig.shape[-1], vocals.shape[-1])
            mix_orig, vocals = mix_orig[:, :min_length], vocals[:, :min_length]

        instrumental = mix_orig - vocals

        # output paths
        os.makedirs(output_path, exist_ok=True)   
        soundfile.write(os.path.join(output_path, "vocals.mp3"), vocals.T, sample_rate)
        soundfile.write(os.path.join(output_path, "instrumental.mp3"), instrumental.T, sample_rate)     

    elif model_name == "decrowd":
        # download models from hugging face repo
        ckpt = torch.load(
            hf_hub_download(
                repo_id="kseto06/benzaiten",
                filename="mel_band_roformer_decrowd.ckpt"
            ),
            map_location="cpu"
        )
        
        with open(
            hf_hub_download(
                repo_id="kseto06/benzaiten",
                filename="mel_band_roformer_decrowd.yaml"
            ), 
        "r") as f:
            cfg = yaml.load(f, Loader=yaml.FullLoader)

        model_cfg = cfg["model"]
    
        model = MelBandRoformer(
            dim=model_cfg["dim"],
            depth=model_cfg["depth"],
            stereo=model_cfg["stereo"],
            num_stems=model_cfg["num_stems"],
            time_transformer_depth=model_cfg["time_transformer_depth"],
            freq_transformer_depth=model_cfg["freq_transformer_depth"],
            num_bands=model_cfg["num_bands"],
            dim_head=model_cfg["dim_head"],
            heads=model_cfg["heads"],
            attn_dropout=model_cfg["attn_dropout"],
            ff_dropout=model_cfg["ff_dropout"],
            flash_attn=model_cfg["flash_attn"],
            dim_freqs_in=model_cfg["dim_freqs_in"],
            sample_rate=model_cfg["sample_rate"],
            stft_n_fft=model_cfg["stft_n_fft"],
            stft_hop_length=model_cfg["stft_hop_length"],
            stft_win_length=model_cfg["stft_win_length"],
            stft_normalized=model_cfg["stft_normalized"],
            mask_estimator_depth=model_cfg["mask_estimator_depth"],
            multi_stft_resolution_loss_weight=model_cfg["multi_stft_resolution_loss_weight"],
            multi_stft_resolutions_window_sizes=tuple(
                model_cfg["multi_stft_resolutions_window_sizes"]
            ),
            multi_stft_hop_size=model_cfg["multi_stft_hop_size"],
            multi_stft_normalized=model_cfg["multi_stft_normalized"],
        )

        missing, unexpected = model.load_state_dict(ckpt, strict=False)

        if missing or unexpected:
            raise ValueError(f"State dict keys mismatch. Missing keys: {missing}, Unexpected keys: {unexpected}")

        # init of audio and configs. mps doesn't support complex tensors so this config is removed here
        device = torch.device(
            "cuda" if torch.cuda.is_available() else "cpu"
        )

        config = dict_to_configdict(cfg)

        # locally-ran configs, due to high memory allocation.
        # might be able to delete if cloud inference can be setup
        config.audio.chunk_size = 44100 * 5
        config.inference.batch_size = 1
        config.inference.num_overlap = 2

        model = model.to(device)
        model.eval()
        
        sample_rate = config.audio.sample_rate
        mix, sr = librosa.load(audio_path, sr=sample_rate, mono=False)

        # shape fixing
        if mix.ndim == 1:
            mix = np.expand_dims(mix, axis=0)

        # ensure stereo
        if mix.shape[0] == 1 and config.audio.num_channels == 2:
            mix = np.concatenate([mix, mix], axis=0)
        elif mix.shape[0] > 2:
            mix = mix[:2]

        # save original mixed audio so we can extract instrumentals later
        mix_orig = mix.copy()

        # inference with inference-time demixing
        with torch.inference_mode():
            waveform = bigshifts_wrapper(
                config=config,
                model=model,
                mix=mix,
                device=device,
                model_type="melband-roformer",
                pbar=True,
                bigshifts=1
            )
        
        # extract outputs
        crowd = waveform[config.training.target_instrument]
            
        if mix_orig.shape != crowd.shape:
            print("NOTE: mixed audio and vocals shape are not equal")
            min_length = min(mix_orig.shape[-1], crowd.shape[-1])
            mix_orig, crowd = mix_orig[:, :min_length], crowd[:, :min_length]

        decrowd = mix_orig - crowd

        # output paths
        os.makedirs(output_path, exist_ok=True)   
        soundfile.write(os.path.join(output_path, "crowd.mp3"), crowd.T, sample_rate)
        soundfile.write(os.path.join(output_path, "instrumental_(decrowd).mp3"), decrowd.T, sample_rate)
    
if __name__ == "__main__":
    # extract_audio("input_video.mp4", "output_audio.mp3")
    run_karaoke_inference(model_name="bs-roformer", audio_path="./backend/tests/audio_files/i_miss_you.mp3")
    # run_karaoke_inference(model_name="decrowd", audio_path="./backend/tests/audio_files/instrumental.wav")