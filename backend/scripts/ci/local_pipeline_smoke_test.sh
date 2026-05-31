#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
INPUT_VIDEO="$ROOT_DIR/backend/tests/input_files/i_miss_you_cut_test.mp4"
OUTPUT_DIR="${BENZAITEN_SMOKE_OUTPUT_DIR:-$ROOT_DIR/test_outputs/local_pipeline_smoke}"

if [[ ! -f "$INPUT_VIDEO" ]]; then
  echo "Expected input video is missing: $INPUT_VIDEO" >&2
  exit 1
fi

export BENZAITEN_SMOKE_INPUT_VIDEO="$INPUT_VIDEO"

rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

python -m compileall "$ROOT_DIR/backend"

bash "$ROOT_DIR/backend/scripts/ci/stages/source_separation_pipeline_test.sh"
bash "$ROOT_DIR/backend/scripts/ci/stages/decrowd_pipeline_test.sh"
bash "$ROOT_DIR/backend/scripts/ci/stages/transcription_pipeline_test.sh"
bash "$ROOT_DIR/backend/scripts/ci/stages/build_video_pipeline_test.sh"