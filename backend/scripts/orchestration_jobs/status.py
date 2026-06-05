import json
import os
from pathlib import Path
from typing import Optional

from backend.gcp_utils.gcs_bucket import upload_file_to_gcs


def write_inference_job_status(
    *, job_id: str, status: str, error: Optional[str] = None
) -> None:
    """
    Function to write the status of the inference job to a json file and upload to GCS bucket.
    Used for tracking job status in the get_inference_job_status endpoint

    Args:
        job_id: the unique identifier for the inference job, generated in the create_inference_job
        status: the current status of the job, can be "queued", "running", "failed", "completed"
        error: optional error message if the job failed
    """
    gcs_bucket = os.environ.get("GCS_BUCKET", "benzaiten-outputs")

    status_dir = Path(f"/tmp/outputs/{job_id}")
    status_dir.mkdir(parents=True, exist_ok=True)
    status_path = status_dir / "status.json"

    payload = {"job_id": job_id, "status": status}
    if error:
        payload["error"] = error

    with open(status_path, "w") as f:
        json.dump(payload, f)

    upload_file_to_gcs(
        local_path=str(status_path),
        bucket_name=gcs_bucket,
        destination_blob_name=f"outputs/{job_id}/status.json",
    )
