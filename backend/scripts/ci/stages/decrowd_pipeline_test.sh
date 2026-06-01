#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)
OUTPUT_ROOT="${BENZAITEN_SMOKE_OUTPUT_DIR:-$ROOT_DIR/test_outputs/local_pipeline_smoke}"
INPUT_AUDIO="$OUTPUT_ROOT/source_separation/instrumental.mp3"
OUTPUT_DIR="$OUTPUT_ROOT/decrowd"

if [[ ! -f "$INPUT_AUDIO" ]]; then
  echo "Expected source-separation instrumental audio is missing: $INPUT_AUDIO" >&2
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


AUDIO_EXTENSIONS = {".wav", ".mp3", ".flac", ".m4a", ".aac", ".ogg"}


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


def convert_audio_to_mp3(source: Path, destination: Path) -> None:
    if source.resolve() == destination.resolve():
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-codec:a",
            "libmp3lame",
            "-b:a",
            "192k",
            str(destination),
        ],
        check=True,
    )


def find_audio_output(output_dir: Path, keywords: list[str]) -> Path:
    candidates = []

    for path in output_dir.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in AUDIO_EXTENSIONS:
            continue

        stem = path.stem.lower()
        if all(keyword.lower() in stem for keyword in keywords):
            candidates.append(path)

    if not candidates:
        all_audio = sorted(
            str(path.relative_to(output_dir))
            for path in output_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS
        )
        raise FileNotFoundError(
            f"Could not find audio output containing keywords {keywords} in {output_dir}. "
            f"Audio files found: {all_audio}"
        )

    candidates.sort(key=lambda path: path.stat().st_size, reverse=True)
    return candidates[0]


def maybe_find_audio_output(output_dir: Path, keywords: list[str]) -> Path | None:
    try:
        return find_audio_output(output_dir, keywords)
    except FileNotFoundError:
        return None


input_audio = Path(sys.argv[1]).resolve()
output_dir = Path(sys.argv[2]).resolve()

require_file(input_audio)

run_karaoke_inference(
    model_name="decrowd",
    audio_path=str(input_audio),
    output_path=str(output_dir),
)

raw_decrowd_instrumental = (
    maybe_find_audio_output(output_dir, ["instrumental", "decrowd"])
    or maybe_find_audio_output(output_dir, ["instrumental"])
)

if raw_decrowd_instrumental is None:
    raise FileNotFoundError(
        f"Could not find decrowded instrumental output in {output_dir}"
    )

canonical_decrowd_instrumental = output_dir / "instrumental_decrowd.mp3"
convert_audio_to_mp3(raw_decrowd_instrumental, canonical_decrowd_instrumental)

raw_crowd = maybe_find_audio_output(output_dir, ["crowd"])
if raw_crowd is not None:
    canonical_crowd = output_dir / "crowd.mp3"
    convert_audio_to_mp3(raw_crowd, canonical_crowd)
    require_file(canonical_crowd)

require_file(canonical_decrowd_instrumental)

instrumental_duration = probe_duration(canonical_decrowd_instrumental)
if instrumental_duration <= 0:
    raise RuntimeError(
        f"Expected a non-zero decrowd instrumental duration, got {instrumental_duration}"
    )

print("Decrowd stage outputs verified successfully")
print(f"input_audio={input_audio}")
print(f"raw_decrowd_instrumental={raw_decrowd_instrumental}")
print(f"canonical_decrowd_instrumental={canonical_decrowd_instrumental}")
if raw_crowd is not None:
    print(f"raw_crowd={raw_crowd}")
    print(f"canonical_crowd={output_dir / 'crowd.mp3'}")
else:
    print("crowd_output=None")
PY