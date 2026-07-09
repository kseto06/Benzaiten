import os
import sys
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Callable, Iterable


PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from backend.scripts.orchestration_jobs.status import (  # noqa: E402
    try_write_inference_job_status,
    write_inference_job_status,
)
from backend.scripts.run_inference_job import (  # noqa: E402
    _stage_blob,
    run_build_video_job,
    run_decrowding_job,
    run_source_separation_job,
    run_transcription_job,
)


def _bool_env(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes"}


def _run_parallel_stages(stages: Iterable[Callable[[], object]]) -> None:
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(stage) for stage in stages]
        for future in as_completed(futures):
            future.result()


def run_local_hosted_inference() -> None:
    job_id = os.environ["JOB_ID"]
    filename = os.environ["FILENAME"]
    content_type = os.environ.get("CONTENT_TYPE", "video/mp4")
    should_decrowd = _bool_env("SHOULD_DECROWD")
    is_video = content_type.startswith("video/")

    try:
        write_inference_job_status(job_id=job_id, status="running")

        run_source_separation_job()

        parallel_stages = [run_transcription_job]
        if should_decrowd:
            parallel_stages.append(run_decrowding_job)
        _run_parallel_stages(parallel_stages)

        final_audio_blob = (
            _stage_blob(job_id, "decrowd", "instrumental_(decrowd).mp3")
            if should_decrowd
            else _stage_blob(job_id, "source_separation", "instrumental.mp3")
        )
        output_name = (
            f"{Path(filename).stem}.mp4" if is_video else f"{Path(filename).stem}.mp3"
        )

        os.environ["IS_VIDEO"] = str(is_video).lower()
        os.environ["VIDEO_BLOB_NAME"] = _stage_blob(
            job_id, "source_separation", "input_video.mp4"
        )
        os.environ["AUDIO_BLOB_NAME"] = final_audio_blob
        os.environ["SRT_BLOB_NAME"] = _stage_blob(job_id, "transcription", "vocals.srt")
        os.environ["VTT_BLOB_NAME"] = _stage_blob(job_id, "transcription", "vocals.vtt")
        if is_video:
            os.environ["OUTPUT_VIDEO_BLOB_NAME"] = _stage_blob(
                job_id, "final_output", output_name
            )
        else:
            os.environ["OUTPUT_AUDIO_BLOB_NAME"] = _stage_blob(
                job_id, "final_output", output_name
            )

        run_build_video_job()

    except Exception as error:
        traceback.print_exc()
        try_write_inference_job_status(
            job_id=job_id,
            status="failed",
            error=str(error),
        )
        raise


if __name__ == "__main__":
    run_local_hosted_inference()
