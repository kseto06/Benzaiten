import os
from backend.scripts.orchestration_jobs.orchestrator import (
    run_orchestration_inference_pipeline,
)

if __name__ == "__main__":
    job_id = os.getenv("JOB_ID")
    input_blob_name = os.getenv("INPUT_BLOB_NAME")
    filename = os.environ["FILENAME"]
    content_type = os.environ.get("CONTENT_TYPE")
    should_decrowd = os.environ.get("SHOULD_DECROWD", "false").lower() == "true"
    fast_decrowd = os.environ.get("FAST_DECROWD", "false").lower() == "true"
    should_transcribe = os.environ.get("SHOULD_TRANSCRIBE", "true").lower() == "true"
    should_translate = os.environ.get("SHOULD_TRANSLATE", "true").lower() == "true"
    language = os.environ.get("LANGUAGE") or None
    target_language = os.environ.get("TARGET_LANGUAGE") or "en"

    run_orchestration_inference_pipeline(
        job_id=job_id,
        input_blob_name=input_blob_name,
        filename=filename,
        content_type=content_type,
        should_decrowd=should_decrowd,
        fast_decrowd=fast_decrowd,
        should_transcribe=should_transcribe,
        should_translate=should_translate,
        language=language,
        target_language=target_language,
    )
