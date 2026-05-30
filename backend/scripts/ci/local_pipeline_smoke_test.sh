#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
INPUT_AUDIO="$ROOT_DIR/backend/tests/audio_files/i_miss_you_cut_test.mp3"
OUTPUT_DIR="${BENZAITEN_SMOKE_OUTPUT_DIR:-$ROOT_DIR/test_outputs/local_pipeline_smoke}"

if [[ ! -f "$INPUT_AUDIO" ]]; then
  echo "Expected input audio is missing: $INPUT_AUDIO" >&2
  exit 1
fi

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

python -m compileall "$ROOT_DIR/backend"

python - "$INPUT_AUDIO" "$OUTPUT_DIR" <<'PY'
import subprocess
import sys
from pathlib import Path

from backend.language_models.transcribe import run_srt_inference
from backend.scripts.ffmpeg import build_video, convert_srt_to_vtt
from backend.scripts.process import run_karaoke_inference


def require_file(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"Expected output file missing: {path}")

    if path.stat().st_size <= 0:
        raise RuntimeError(f"Expected output file is empty: {path}")


def probe_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )

    return float(result.stdout.strip())


input_audio = Path(sys.argv[1]).resolve()
output_dir = Path(sys.argv[2]).resolve()

bs_output_dir = output_dir / "bs_roformer"
decrowd_output_dir = output_dir / "decrowd"
media_output_dir = output_dir / "media"

bs_output_dir.mkdir(parents=True, exist_ok=True)
decrowd_output_dir.mkdir(parents=True, exist_ok=True)
media_output_dir.mkdir(parents=True, exist_ok=True)

print("Running source separation stage: bs-roformer")
run_karaoke_inference(
    model_name="bs-roformer",
    audio_path=str(input_audio),
    output_path=str(bs_output_dir),
)

vocals_path = bs_output_dir / "vocals.mp3"
instrumental_path = bs_output_dir / "instrumental.mp3"
require_file(vocals_path)
require_file(instrumental_path)

print("Running source separation stage: decrowd")
run_karaoke_inference(
    model_name="decrowd",
    audio_path=str(instrumental_path),
    output_path=str(decrowd_output_dir),
)

crowd_path = decrowd_output_dir / "crowd.mp3"
decrowd_instrumental_path = decrowd_output_dir / "instrumental_(decrowd).mp3"
require_file(crowd_path)
require_file(decrowd_instrumental_path)

print("Running transcription and translation stage")
srt_output = Path(
    run_srt_inference(
        audio_path=str(vocals_path),
        language=None,
        model_size="base",
        output_path=str(media_output_dir),
    )
)
require_file(srt_output)

vtt_output = media_output_dir / f"{srt_output.stem}.vtt"
convert_srt_to_vtt(srt_path=str(srt_output), vtt_path=str(vtt_output))
require_file(vtt_output)

print("Generating placeholder video for the build_video stage")
audio_duration = max(probe_duration(decrowd_instrumental_path), 1.0)
placeholder_video = media_output_dir / "placeholder_video.mp4"

subprocess.run(
    [
        "ffmpeg",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=1280x720:r=30",
        "-t",
        f"{audio_duration:.3f}",
        "-pix_fmt",
        "yuv420p",
        str(placeholder_video),
    ],
    check=True,
)
require_file(placeholder_video)

print("Running final build_video stage")
final_video = media_output_dir / "final_video.mp4"
build_video(
    video_path=str(placeholder_video),
    audio_path=str(decrowd_instrumental_path),
    srt_path=str(srt_output),
    output_path=str(final_video),
)
require_file(final_video)

final_duration = probe_duration(final_video)
if final_duration <= 0:
    raise RuntimeError(f"Expected a non-zero video duration, got {final_duration}")

print("Smoke test outputs verified successfully")
print(f"final_video_duration_seconds={final_duration:.3f}")
PY