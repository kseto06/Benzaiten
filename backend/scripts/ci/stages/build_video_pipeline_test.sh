#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
OUTPUT_ROOT="${BENZAITEN_SMOKE_OUTPUT_DIR:-$ROOT_DIR/test_outputs/local_pipeline_smoke}"
VIDEO_INPUT="$OUTPUT_ROOT/source_separation/i_miss_you_cut_test_video.mp4"
AUDIO_INPUT="$OUTPUT_ROOT/decrowd/instrumental_(decrowd).mp3"
SRT_INPUT="$OUTPUT_ROOT/transcription/i_miss_you_cut_test.srt"
OUTPUT_DIR="$OUTPUT_ROOT/build_video"

for input_path in "$VIDEO_INPUT" "$AUDIO_INPUT" "$SRT_INPUT"; do
  if [[ ! -f "$input_path" ]]; then
    echo "Expected pipeline input is missing: $input_path" >&2
    exit 1
  fi
done

mkdir -p "$OUTPUT_ROOT"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

cd "$ROOT_DIR"

python - "$VIDEO_INPUT" "$AUDIO_INPUT" "$SRT_INPUT" "$OUTPUT_DIR" <<'PY'
import subprocess
import sys
from pathlib import Path

from backend.scripts.ffmpeg import build_video


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


video_input = Path(sys.argv[1]).resolve()
audio_input = Path(sys.argv[2]).resolve()
srt_input = Path(sys.argv[3]).resolve()
output_dir = Path(sys.argv[4]).resolve()

final_video = output_dir / "final_video.mp4"
build_video(
    video_path=str(video_input),
    audio_path=str(audio_input),
    srt_path=str(srt_input),
    output_path=str(final_video),
)

require_file(final_video)
final_duration = probe_duration(final_video)

if final_duration <= 0:
    raise RuntimeError(f"Expected a non-zero video duration, got {final_duration}")

print("Build video stage outputs verified successfully")
print(f"final_video={final_video}")
print(f"final_video_duration_seconds={final_duration:.3f}")
PY