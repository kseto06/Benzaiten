import subprocess
import threading
from pathlib import Path
from typing import Dict, Optional, Sequence, Set, Tuple


_ACTIVE_FFMPEG_PROCESSES: Dict[str, subprocess.Popen] = {}
_CANCELLED_FFMPEG_PROCESS_IDS: Set[str] = set()
_ACTIVE_FFMPEG_LOCK = threading.Lock()


def cancel_ffmpeg_process(process_id: str) -> bool:
    with _ACTIVE_FFMPEG_LOCK:
        _CANCELLED_FFMPEG_PROCESS_IDS.add(process_id)
        process = _ACTIVE_FFMPEG_PROCESSES.get(process_id)
    if process is None or process.poll() is not None:
        return False
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    return True


def is_ffmpeg_process_cancelled(process_id: Optional[str]) -> bool:
    if process_id is None:
        return False
    with _ACTIVE_FFMPEG_LOCK:
        return process_id in _CANCELLED_FFMPEG_PROCESS_IDS


def clear_ffmpeg_process_cancelled(process_id: Optional[str]) -> None:
    if process_id is None:
        return
    with _ACTIVE_FFMPEG_LOCK:
        _CANCELLED_FFMPEG_PROCESS_IDS.discard(process_id)


def get_media_duration(media_path: str) -> float:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(media_path),
    ]

    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffprobe duration check failed: {e}") from e

    duration = float(result.stdout.strip())
    if duration <= 0:
        raise ValueError(f"Expected positive media duration, got {duration}")

    return duration


def get_media_frame_rate(media_path: str) -> float:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=avg_frame_rate",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        str(media_path),
    ]

    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffprobe frame-rate check failed: {e}") from e

    numerator, _, denominator = result.stdout.strip().partition("/")
    if not numerator:
        return 24.0
    frame_rate = float(numerator) / max(1.0, float(denominator or "1"))
    if frame_rate <= 0:
        return 24.0
    return frame_rate


def get_media_dimensions(media_path: str) -> Tuple[int, int]:
    command = [
        "ffprobe",
        "-v",
        "error",
        "-select_streams",
        "v:0",
        "-show_entries",
        "stream=width,height",
        "-of",
        "csv=p=0:s=x",
        str(media_path),
    ]

    try:
        result = subprocess.run(
            command,
            check=True,
            capture_output=True,
            text=True,
        )
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffprobe dimension check failed: {e}") from e

    width_text, _, height_text = result.stdout.strip().partition("x")
    width = int(width_text or "0")
    height = int(height_text or "0")
    if width <= 0 or height <= 0:
        raise ValueError(f"Expected positive media dimensions, got {width}x{height}")
    return width, height


def extract_audio_segment(
    audio_path: str,
    output_path: str,
    *,
    start_seconds: float,
    duration_seconds: float,
) -> Path:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    command = [
        "ffmpeg",
        "-y",
        "-ss",
        str(start_seconds),
        "-i",
        str(audio_path),
        "-t",
        str(duration_seconds),
        "-vn",
        "-c:a",
        "libmp3lame",
        "-ar",
        "44100",
        "-ac",
        "2",
        str(output),
    ]

    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg audio segment extraction failed: {e}") from e

    return output


def concatenate_audio_files(audio_paths: Sequence[str], output_path: str) -> Path:
    if not audio_paths:
        raise ValueError("At least one audio path is required")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    command = ["ffmpeg", "-y"]
    for audio_path in audio_paths:
        command.extend(["-i", str(audio_path)])

    filter_inputs = "".join(f"[{index}:a]" for index in range(len(audio_paths)))
    command.extend(
        [
            "-filter_complex",
            f"{filter_inputs}concat=n={len(audio_paths)}:v=0:a=1[outa]",
            "-map",
            "[outa]",
            "-c:a",
            "libmp3lame",
            "-ar",
            "44100",
            "-ac",
            "2",
            str(output),
        ]
    )

    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg audio concatenation failed: {e}") from e

    return output


def _escape_ass_filter_path(path: Path) -> str:
    return str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")


def extract_audio_from_video(video_path: str, output_path: str) -> Path:
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-vn",
        "-c:a",
        "libmp3lame",
        "-ar",
        "44100",
        "-ac",
        "2",
        str(output),
    ]

    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg audio extraction failed: {e}") from e

    return output


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
        "-i",
        str(video_path),
        "-an",
        "-c:v",
        "copy",
        str(video_output_path),
    ]

    # Extract audio and re-encode to mp3
    audio_command = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-vn",
        "-acodec",
        "libmp3lame",
        "-ar",
        "44100",
        "-ac",
        "2",
        str(audio_output_path),
    ]

    try:
        subprocess.run(video_command, check=True)
        subprocess.run(audio_command, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg source splitting failed: {e}")

    return video_output_path, audio_output_path


def build_video(
    video_path: str, audio_path: str, srt_path: str, output_path: str
) -> Path:
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
        "-i",
        str(video_path),
        "-i",
        str(audio_path),
        "-i",
        str(srt_path),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map",
        "2:s:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-c:s",
        "mov_text",
        "-disposition:s:0",
        "default",
        # "-shortest",
        str(output_path),
    ]

    try:
        subprocess.run(command, check=True)
    except subprocess.CalledProcessError as e:
        raise RuntimeError(f"ffmpeg video building failed: {e}")

    return output_path


def render_video_with_ass_subtitles(
    video_path: str,
    ass_path: str,
    output_path: str,
    fonts_dir: Optional[str] = None,
    process_id: Optional[str] = None,
) -> Path:
    """
    Re-encode a video with the edited ASS subtitle track burned into its frames.
    """
    video_path = Path(video_path)
    ass_path = Path(ass_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    escaped_ass_path = _escape_ass_filter_path(ass_path)
    ass_filter = f"filename='{escaped_ass_path}'"
    if fonts_dir:
        fonts_dir_path = Path(fonts_dir)
        if fonts_dir_path.exists():
            ass_filter += f":fontsdir='{_escape_ass_filter_path(fonts_dir_path)}'"
    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-vf",
        f"ass={ass_filter}",
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        str(output_path),
    ]

    if process_id is None:
        try:
            subprocess.run(command, check=True)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"ffmpeg edited video rendering failed: {e}") from e
    else:
        with _ACTIVE_FFMPEG_LOCK:
            if process_id in _CANCELLED_FFMPEG_PROCESS_IDS:
                _CANCELLED_FFMPEG_PROCESS_IDS.discard(process_id)
                raise RuntimeError("ffmpeg edited video rendering cancelled")
        process = subprocess.Popen(command)
        with _ACTIVE_FFMPEG_LOCK:
            _ACTIVE_FFMPEG_PROCESSES[process_id] = process
        try:
            return_code = process.wait()
            if return_code != 0:
                with _ACTIVE_FFMPEG_LOCK:
                    was_cancelled = process_id in _CANCELLED_FFMPEG_PROCESS_IDS
                if was_cancelled:
                    raise RuntimeError("ffmpeg edited video rendering cancelled")
                raise RuntimeError(
                    f"ffmpeg edited video rendering failed with code {return_code}"
                )
        finally:
            with _ACTIVE_FFMPEG_LOCK:
                _ACTIVE_FFMPEG_PROCESSES.pop(process_id, None)
                _CANCELLED_FFMPEG_PROCESS_IDS.discard(process_id)

    return output_path


def render_video_with_png_overlay(
    video_path: str,
    overlay_frame_pattern: str,
    output_path: str,
    *,
    frame_rate: float,
    process_id: Optional[str] = None,
) -> Path:
    video_path = Path(video_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(video_path),
        "-framerate",
        f"{frame_rate:.6f}",
        "-start_number",
        "1",
        "-i",
        overlay_frame_pattern,
        "-filter_complex",
        "[0:v][1:v]overlay=0:0:format=auto[v]",
        "-map",
        "[v]",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-movflags",
        "+faststart",
        "-shortest",
        str(output_path),
    ]

    if process_id is None:
        try:
            subprocess.run(command, check=True)
        except subprocess.CalledProcessError as e:
            raise RuntimeError(f"ffmpeg browser-overlay rendering failed: {e}") from e
    else:
        with _ACTIVE_FFMPEG_LOCK:
            if process_id in _CANCELLED_FFMPEG_PROCESS_IDS:
                _CANCELLED_FFMPEG_PROCESS_IDS.discard(process_id)
                raise RuntimeError("ffmpeg browser-overlay rendering cancelled")
        process = subprocess.Popen(command)
        with _ACTIVE_FFMPEG_LOCK:
            _ACTIVE_FFMPEG_PROCESSES[process_id] = process
        try:
            return_code = process.wait()
            if return_code != 0:
                with _ACTIVE_FFMPEG_LOCK:
                    was_cancelled = process_id in _CANCELLED_FFMPEG_PROCESS_IDS
                if was_cancelled:
                    raise RuntimeError("ffmpeg browser-overlay rendering cancelled")
                raise RuntimeError(
                    f"ffmpeg browser-overlay rendering failed with code {return_code}"
                )
        finally:
            with _ACTIVE_FFMPEG_LOCK:
                _ACTIVE_FFMPEG_PROCESSES.pop(process_id, None)
                _CANCELLED_FFMPEG_PROCESS_IDS.discard(process_id)

    return output_path


def convert_srt_to_vtt(srt_path: str, vtt_path: str) -> Path:
    vtt_path = Path(vtt_path)
    vtt_path.parent.mkdir(parents=True, exist_ok=True)

    command = [
        "ffmpeg",
        "-y",
        "-i",
        str(srt_path),
        str(vtt_path),
    ]

    subprocess.run(command, check=True)
    return vtt_path
