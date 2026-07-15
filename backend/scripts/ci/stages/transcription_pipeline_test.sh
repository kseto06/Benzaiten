#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
OUTPUT_ROOT="${BENZAITEN_SMOKE_OUTPUT_DIR:-$ROOT_DIR/test_outputs/local_pipeline_smoke}"
INPUT_AUDIO="$OUTPUT_ROOT/source_separation/vocals.mp3"
OUTPUT_DIR="$OUTPUT_ROOT/transcription"
OUTPUT_FILE="$OUTPUT_DIR/i_miss_you_cut_test.srt"
RUN_TRANSLATION="${BENZAITEN_RUN_TRANSLATION:-true}"
RUN_ROMANIZATION="${BENZAITEN_RUN_ROMANIZATION:-true}"

if [[ "$RUN_TRANSLATION" != "true" && "$RUN_TRANSLATION" != "false" ]]; then
  echo "BENZAITEN_RUN_TRANSLATION must be 'true' or 'false', got: $RUN_TRANSLATION" >&2
  exit 1
fi

if [[ "$RUN_ROMANIZATION" != "true" && "$RUN_ROMANIZATION" != "false" ]]; then
  echo "BENZAITEN_RUN_ROMANIZATION must be 'true' or 'false', got: $RUN_ROMANIZATION" >&2
  exit 1
fi

if [[ ! -f "$INPUT_AUDIO" ]]; then
  echo "Expected vocals audio is missing: $INPUT_AUDIO" >&2
  exit 1
fi

mkdir -p "$OUTPUT_ROOT"
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"

cd "$ROOT_DIR"

python - "$INPUT_AUDIO" "$OUTPUT_FILE" "$RUN_TRANSLATION" "$RUN_ROMANIZATION" <<'PY'
import sys
from pathlib import Path

from backend.language_models.transcribe import run_srt_inference
from backend.scripts.ffmpeg import convert_srt_to_vtt


def require_file(path: Path) -> None:
    if not path.exists():
        raise FileNotFoundError(f"Expected output file missing: {path}")

    if path.stat().st_size <= 0:
        raise RuntimeError(f"Expected output file is empty: {path}")


input_audio = Path(sys.argv[1]).resolve()
output_file = Path(sys.argv[2]).resolve()
should_translate = sys.argv[3] == "true"
should_romanize = sys.argv[4] == "true"

require_file(input_audio)
output_file.parent.mkdir(parents=True, exist_ok=True)

srt_output = Path(
    run_srt_inference(
        audio_path=str(input_audio),
        language="ko",
        target_language="en",
        should_translate=should_translate,
        should_romanize=should_romanize,
        model_size="large-v3-turbo",
        output_path=str(output_file),
    )
)

require_file(srt_output)

blocks = [block.strip() for block in srt_output.read_text(encoding="utf-8").split("\n\n") if block.strip()]
if not blocks:
    raise RuntimeError("Expected at least one SRT cue")

first_block_lines = blocks[0].splitlines()
cue_text_lines = first_block_lines[2:]
expected_line_count = 1 + int(should_romanize) + int(should_translate)
if len(cue_text_lines) != expected_line_count:
    raise RuntimeError(
        "Unexpected subtitle line count: "
        f"expected {expected_line_count}, got {len(cue_text_lines)}"
    )

vtt_output = output_file.with_suffix(".vtt")
convert_srt_to_vtt(srt_path=str(srt_output), vtt_path=str(vtt_output))
require_file(vtt_output)

print("Transcription stage outputs verified successfully")
print(f"should_translate={should_translate}")
print(f"should_romanize={should_romanize}")
print(f"input_audio={input_audio}")
print(f"srt_output={srt_output}")
print(f"vtt_output={vtt_output}")
PY
