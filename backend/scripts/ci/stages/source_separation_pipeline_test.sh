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

python -u - "$INPUT_VIDEO" "$OUTPUT_DIR" <<'PY'
import shutil
import subprocess
import sys
from pathlib import Path

from backend.scripts.ffmpeg import split_sources
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


def copy_video(source: Path, destination: Path) -> None:
    if source.resolve() == destination.resolve():
        return

    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def find_audio_output(output_dir: Path, keyword: str) -> Path:
    candidates = [
        path
        for path in output_dir.rglob("*")
        if path.is_file()
        and path.suffix.lower() in AUDIO_EXTENSIONS
        and keyword.lower() in path.stem.lower()
    ]

    if not candidates:
        all_audio = sorted(
            str(path.relative_to(output_dir))
            for path in output_dir.rglob("*")
            if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS
        )
        raise FileNotFoundError(
            f"Could not find an audio output containing '{keyword}' in {output_dir}. "
            f"Audio files found: {all_audio}"
        )

    candidates.sort(key=lambda path: path.stat().st_size, reverse=True)
    return candidates[0]


input_video = Path(sys.argv[1]).resolve()
output_dir = Path(sys.argv[2]).resolve()
bs_output_dir = output_dir / "bs_roformer"

video_output_path, audio_output_path = split_sources(
    video_path=str(input_video),
    output_dir=str(output_dir),
)

video_output_path = Path(video_output_path).resolve()
audio_output_path = Path(audio_output_path).resolve()

require_file(video_output_path)
require_file(audio_output_path)

bs_output_dir.mkdir(parents=True, exist_ok=True)

canonical_video_path = output_dir / "input_video.mp4"
canonical_audio_path = output_dir / "input_audio.mp3"

copy_video(video_output_path, canonical_video_path)
convert_audio_to_mp3(audio_output_path, canonical_audio_path)

require_file(canonical_video_path)
require_file(canonical_audio_path)

print("Running bs-roformer source separation", flush=True)
run_karaoke_inference(
    model_name="bs-roformer",
    audio_path=str(canonical_audio_path),
    output_path=str(bs_output_dir),
)
print("Finished bs-roformer source separation", flush=True)

raw_vocals_path = find_audio_output(bs_output_dir, "vocal")
raw_instrumental_path = find_audio_output(bs_output_dir, "instrumental")

canonical_vocals_path = output_dir / "vocals.mp3"
canonical_instrumental_path = output_dir / "instrumental.mp3"

convert_audio_to_mp3(raw_vocals_path, canonical_vocals_path)
convert_audio_to_mp3(raw_instrumental_path, canonical_instrumental_path)

for path in [
    canonical_video_path,
    canonical_audio_path,
    canonical_vocals_path,
    canonical_instrumental_path,
]:
    require_file(path)
    duration = probe_duration(path)
    if duration <= 0:
        raise RuntimeError(f"Expected a non-zero duration for {path}, got {duration}")

print("Source separation stage outputs verified successfully")
print(f"input_video={input_video}")
print(f"canonical_video={canonical_video_path}")
print(f"canonical_audio={canonical_audio_path}")
print(f"raw_vocals={raw_vocals_path}")
print(f"raw_instrumental={raw_instrumental_path}")
print(f"canonical_vocals={canonical_vocals_path}")
print(f"canonical_instrumental={canonical_instrumental_path}")
PY