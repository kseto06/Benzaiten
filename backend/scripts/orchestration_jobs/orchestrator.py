from typing import Union

from backend.scripts.benzaiten_inference.k8s.kubernetes_utils import (
    GCS_BUCKET,
    create_k8s_source_separation_inference_job,
    create_k8s_decrowd_inference_job,
    create_k8s_transcription_inference_job,
    create_k8s_build_video_job,
    wait_for_jobs,
)
from backend.scripts.orchestration_jobs.status import try_write_inference_job_status


def run_orchestration_inference_pipeline(
    job_id: str,
    input_blob_name: str,
    filename: str,
    content_type: Union[str, None],
    should_decrowd: bool,
    fast_decrowd: bool,
    should_transcribe: bool,
    should_translate: bool,
    should_romanize: bool,
    language: Union[str, None],
    target_language: str = "en",
) -> None:
    """
    The structure of the orchestration pipeline is:

    audio --> vocal/instrumental source separation
            |--> decrowding job if chosen
            |--> transcription/translation job if chosen
          --> combine both job outputs to build the final video

    This attempts to make the pipeline more modular and efficient via parallelizing k8 jobs
    """
    try:
        # 1. create k8s job for source separation
        source_separation_job_name = create_k8s_source_separation_inference_job(
            job_id=job_id,
            input_gcs_path=f"gs://{GCS_BUCKET}/{input_blob_name}",
            input_blob_name=input_blob_name,
            filename=filename,
            content_type=content_type,
        )
        wait_for_jobs([source_separation_job_name])

        # init parallel jobs list to run decrowding and transcription simultaneously
        parallel_jobs = []

        # 2. create k8s job for decrowding if chosen
        if should_decrowd:
            decrowd_job_name = create_k8s_decrowd_inference_job(
                job_id=job_id,
                filename=filename,
                fast_decrowd=fast_decrowd,
            )
            parallel_jobs.append(decrowd_job_name)

        # 3. create k8s job for transcription/translation/romanization if chosen
        if should_transcribe:
            transcription_job_name = create_k8s_transcription_inference_job(
                job_id=job_id,
                filename=filename,
                language=language,
                target_language=target_language,
                should_translate=should_translate,
                should_romanize=should_romanize,
            )
            parallel_jobs.append(transcription_job_name)

        if parallel_jobs:
            wait_for_jobs(parallel_jobs)

        # 4. building the final video
        build_video_job = create_k8s_build_video_job(
            job_id=job_id,
            filename=filename,
            should_decrowd=should_decrowd,
            should_transcribe=should_transcribe,
            input_blob_name=input_blob_name,
            content_type=content_type,
        )
        wait_for_jobs([build_video_job])

    except Exception as e:
        try_write_inference_job_status(job_id=job_id, status="failed", error=str(e))
        raise
