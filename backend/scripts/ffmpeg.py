import subprocess
from pathlib import Path
from typing import Tuple

def split_sources(video_path: str, output_dir: str) -> Tuple[Path, Path]:
    """
    Splits audio and video sources from a video file and saves it to the specified output path.

    Args:
        video_path (str): The path to the input video file.
        output_dir (str): The dir where the extracted video and audio files will be saved.

    Returns:
        None
    """
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    video_path = Path(video_path)
    filename = video_path.stem

    video_output_path = output_dir / f"{filename}_video.mp4"
    audio_output_path = output_dir / f"{filename}_audio.mp3"

    # Extract video without audio
    video_command = [
        "ffmpeg",
        "-y",
        "-i", str(video_path),
        "-an",
        "-c:v", "copy",
        str(video_output_path),
    ]

    # Extract audio and re-encode to mp3
    audio_command = [
        "ffmpeg",
        "-y",
        "-i", str(video_path),
        "-vn",
        "-acodec", "libmp3lame",
        "-ar", "44100",
        "-ac", "2",
        str(audio_output_path),
    ]

    try:
        subprocess.run(video_command, check=True)
        subprocess.run(audio_command, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg source splitting failed: {e}")

    return video_output_path, audio_output_path

def build_video(video_path: str, audio_path: str, srt_path: str, output_path: str) -> Path:
    """
    Combines video and audio sources into a single video file with subtitles.

    Args:
        video_path (str): The path to the input video file (without audio).
        audio_path (str): The path to the input audio file.
        srt_path (str): The path to the input subtitle file (.srt).
        output_path (str): The path where the output video file will be saved.

    Returns:
        Output path of the combined video file
    """
    video_path = Path(video_path)
    audio_path = Path(audio_path)
    srt_path = Path(srt_path)
    output_path = Path(output_path)

    output_path.parent.mkdir(parents=True, exist_ok=True)

    command = [
        "ffmpeg",
        "-y",

        "-i", str(video_path),
        "-i", str(audio_path),
        "-i", str(srt_path),

        "-map", "0:v:0",
        "-map", "1:a:0",
        "-map", "2:s:0",

        "-c:v", "copy",
        "-c:a", "aac",
        "-c:s", "mov_text",

        "-disposition:s:0", "default",

        "-shortest",
        str(output_path),
    ]

    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg video building failed: {e}")
    
    return output_path

def convert_srt_to_vtt(srt_path: str, vtt_path: str) -> Path:
    vtt_path = Path(vtt_path)
    vtt_path.parent.mkdir(parents=True, exist_ok=True)

    command = [
        "ffmpeg",
        "-y",
        "-i", str(srt_path),
        str(vtt_path),
    ]

    subprocess.run(command, check=True)
    return vtt_path