"""
This file contains the models and inference code for transcribing audio into text with timestamps (for karaoke lyric generation)
"""

# for transcription, using faster whisper implementation library
from faster_whisper import WhisperModel
import torch

from pathlib import Path
from typing import List, Dict, Optional, Any

from backend.language_models.translate import init, translate, romanize


def seconds_to_srt_time(seconds: float) -> str:
    """
    Helper function to convert seconds to SRT time format (HH:MM:SS,mmm).
    Args:
        seconds: Time in seconds to convert.
    Returns:
        A string representing the time in SRT format.
    """
    milliseconds = int((seconds % 1) * 1000)
    total_seconds = int(seconds)

    hours = total_seconds // 3600
    minutes = (total_seconds % 3600) // 60
    secs = total_seconds % 60

    return f"{hours:02}:{minutes:02}:{secs:02},{milliseconds:03}"


def transcribe(
    audio_path: str,
    language: Optional[str] = None,
    model_size: str = "large-v3-turbo",
    batch_size: int = 8,
) -> List[Dict[str, Any]]:
    """
    Run inference on the Whisper model. Transcribes input data and outputs segments with timestamps into .srt file.
    If language is different than English, model will save in the .srt file three lines per timestamp:
        1. Original transcription in the original language
        2. Romanization of the original transcription (if applicable)
        3. English translation of the original transcription

    Args:
        audio_path:
            Path to the input audio file.
        model_size_or_path:
            Size of the model to use (tiny, tiny.en, base, base.en,
            small, small.en, distil-small.en, medium, medium.en, distil-medium.en, large-v1,
            large-v2, large-v3, large, distil-large-v2, distil-large-v3, large-v3-turbo, or turbo),
            a path to a converted model directory, or a CTranslate2-converted Whisper model ID from
            the HF Hub. When a size or a model ID is configured, the converted model is downloaded
            from the Hugging Face Hub.
        batch_size:
            Batch size to use for inference, default = 8. Larger batch sizes will be faster but require more VRAM
        language:
            Language code (e.g. "en", "fr", "de") for the input audio. If not specified, the language will be detected
            automatically within the first 30s of the audio.
    """
    results = []
    device = "cuda" if torch.cuda.is_available() else "auto"

    # int8, float16, float32
    if device == "cuda":
        compute_type = "float16"
    else:
        compute_type = "float32"  # float32 > int8 for cpu, because want more accurate transcription

    model = WhisperModel(model_size, device=device, compute_type=compute_type)
    # batched_model = BatchedInferencePipeline(model=model)

    segments, info = model.transcribe(
        audio_path,
        language=language
        if language != "mul"
        else None,  # if language is multilingual, let the model detect the language
        task="transcribe",
        beam_size=5,
        vad_filter=False,  # vad filter might be bad for singing audio
        condition_on_previous_text=False,
        # batch_size=batch_size
    )

    print(
        "Detected language '%s' with probability %f"
        % (info.language, info.language_probability)
    )

    # language settings for translation model init
    if language is None:
        language = info.language
    init(translate_language_code=language)

    for segment in segments:
        # print("[%.2fs -> %.2fs] %s" % (segment.start, segment.end, segment.text))
        text = segment.text.strip()

        results.append(
            {
                "start": seconds_to_srt_time(segment.start),
                "end": seconds_to_srt_time(segment.end),
                "text": {  # text, romanized, translated
                    "original": text,
                    "romanization": romanize(
                        text=text, translate_language_code=language
                    ),
                    "translation": translate(text=text),
                },
            }
        )

    return results


def run_srt_inference(
    audio_path: str,
    language: Optional[str] = None,
    model_size: str = "large-v3-turbo",
    output_path: str = "./backend/tests/transcription_outputs",
) -> str:
    """
    Helper function to save segments with timestamps into .srt file.
    Args:
        segments: List of dictionaries containing 'start', 'end', and 'text' for each segment.
        language: Language code (e.g. "en", "fr", "de") for the input audio.
        output_path: Path to save the output .srt file.
    """
    output_path = Path(output_path)

    # if directory
    if output_path.is_dir():
        output_path = output_path / (Path(audio_path).stem + ".srt")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    segments = transcribe(
        audio_path=audio_path, model_size=model_size, language=language
    )

    with open(output_path, "w", encoding="utf-8") as f:
        for i, segment in enumerate(segments, start=1):
            f.write(f"{i}\n")
            f.write(f"{segment['start']} --> {segment['end']}\n")
            f.write(
                f"{segment['text']['original']}\n"
                f"{segment['text']['romanization']}\n"
                f"{segment['text']['translation']}\n\n"
            )

    return str(output_path)


if __name__ == "__main__":
    # run test on vocals; this may provide better transcription quality than the original audio with instrumental mixture
    run_srt_inference(
        audio_path="./backend/tests/audio_outputs/vocals.mp3", language="mul"
    )
