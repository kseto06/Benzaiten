#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
OUTPUT_ROOT="${BENZAITEN_SMOKE_OUTPUT_DIR:-$ROOT_DIR/test_outputs/local_pipeline_smoke}"
INPUT_AUDIO="$OUTPUT_ROOT/source_separation/i_miss_you_cut_test_audio.mp3"
OUTPUT_DIR="$OUTPUT_ROOT/decrowd"

if [[ ! -f "$INPUT_AUDIO" ]]; then
  echo "Expected source-separation audio is missing: $INPUT_AUDIO" >&2
  exit 1
fi

mkdir -p "$OUTPUT_ROOT"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

cd "$ROOT_DIR"

python - "$INPUT_AUDIO" "$OUTPUT_DIR" <<'PY'
import subprocess
import sys
from pathlib import Path

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

run_karaoke_inference(
    model_name="decrowd",
    audio_path=str(input_audio),
    output_path=str(output_dir),
)

crowd_path = output_dir / "crowd.mp3"
instrumental_path = output_dir / "instrumental_(decrowd).mp3"
require_file(crowd_path)
require_file(instrumental_path)

crowd_duration = probe_duration(crowd_path)
instrumental_duration = probe_duration(instrumental_path)

if crowd_duration <= 0:
    raise RuntimeError(f"Expected a non-zero crowd duration, got {crowd_duration}")

if instrumental_duration <= 0:
    raise RuntimeError(
        f"Expected a non-zero decrowd instrumental duration, got {instrumental_duration}"
    )

print("Decrowd stage outputs verified successfully")
print(f"crowd_output={crowd_path}")
print(f"instrumental_output={instrumental_path}")
PY