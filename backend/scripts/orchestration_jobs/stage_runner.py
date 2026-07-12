import os
import traceback
from typing import Callable, TypeVar

from backend.scripts.orchestration_jobs.status import try_write_inference_job_status

T = TypeVar("T")


def run_stage_with_status(stage_name: str, stage_fn: Callable[[], T]) -> T:
    """
    Run one split-pipeline stage and persist a useful failure message before the
    pod exits
    Kubernetes may clean failed pods quickly, so status.json is the
    durable debugging surface for the frontend and backend poll path

    Args:
        stage_name: Name of the stage for logging purposes.
        stage_fn: A callable that runs the stage and returns a result.

    Returns:
        The result of the stage_fn callable.
    """
    try:
        return stage_fn()
    except Exception as exc:
        job_id = os.environ.get("JOB_ID")
        if job_id:
            try_write_inference_job_status(
                job_id=job_id,
                status="failed",
                error=f"{stage_name} failed: {exc}\n{traceback.format_exc()}",
            )
        raise
