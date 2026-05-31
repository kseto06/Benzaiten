#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
INPUT_VIDEO="${BENZAITEN_SMOKE_INPUT_VIDEO:-$ROOT_DIR/backend/tests/input_files/i_miss_you_cut_test.mp4}"
OUTPUT_ROOT="${BENZAITEN_SMOKE_OUTPUT_DIR:-$ROOT_DIR/test_outputs/local_pipeline_smoke}"
OUTPUT_DIR="$OUTPUT_ROOT/source_separation"

if [[ ! -f "$INPUT_VIDEO" ]]; then
  echo "Expected input video is missing: $INPUT_VIDEO" >&2
  exit 1
fi

mkdir -p "$OUTPUT_ROOT"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

cd "$ROOT_DIR"

python - "$INPUT_VIDEO" "$OUTPUT_DIR" <<'PY'
import subprocess
import sys
from pathlib import Path

from backend.scripts.ffmpeg import split_sources


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


input_video = Path(sys.argv[1]).resolve()
output_dir = Path(sys.argv[2]).resolve()

video_output_path, audio_output_path = split_sources(
    video_path=str(input_video), output_dir=str(output_dir)
)

require_file(video_output_path)
require_file(audio_output_path)

video_duration = probe_duration(video_output_path)
audio_duration = probe_duration(audio_output_path)

if video_duration <= 0:
    raise RuntimeError(f"Expected a non-zero split video duration, got {video_duration}")

if audio_duration <= 0:
    raise RuntimeError(f"Expected a non-zero split audio duration, got {audio_duration}")

print("Source separation stage outputs verified successfully")
print(f"video_output={video_output_path}")
print(f"audio_output={audio_output_path}")
PY