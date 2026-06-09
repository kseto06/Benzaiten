import re
import os
from pathlib import Path
from typing import Union, List, Dict, Optional
import time

from kubernetes import client, config
from kubernetes.client.rest import ApiException

GCS_BUCKET = os.environ.get("GCS_BUCKET", "benzaiten-outputs")
IMAGE = os.environ.get(
    "IMAGE",
    "northamerica-northeast2-docker.pkg.dev/project-0c6e9a84-c914-4d2f-ace/benzaiten/benzaiten-inference:latest",
)
K8S_NAMESPACE = os.environ.get("K8S_NAMESPACE", "default")
CPU_INFERENCE_NODE_POOL = os.environ.get(
    "CPU_INFERENCE_NODE_POOL", "cpu-inference-pool"
)
GPU_INFERENCE_NODE_POOL = os.environ.get("GPU_INFERENCE_NODE_POOL", "gpu-pool")


def _ensure_safe_k8s_name(name: str) -> str:
    """
    Function to ensure K8 has a valid resource name

    Args:
        name: String input of the name to validate and convert
    Returns:
        A string that is a valid K8 resource name
    """
    name = name.lower()
    name = re.sub(r"[^a-z0-9-]+", "-", name)
    name = name.strip("-")
    name = name[:63].strip("-")
    return name or "benzaiten-job"


def get_k8s_api_client() -> client.ApiClient:
    token_path = "/var/run/secrets/kubernetes.io/serviceaccount/token"
    ca_path = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"

    # inside k8s/gke
    if os.path.exists(token_path) and os.path.exists(ca_path):
        with open(token_path) as f:
            token = f.read().strip()

        configuration = client.Configuration()
        configuration.host = "https://kubernetes.default.svc"
        configuration.ssl_ca_cert = ca_path
        configuration.verify_ssl = True

        api_client = client.ApiClient(configuration)
        api_client.default_headers["Authorization"] = "Bearer " + token

        return api_client

    # local dev
    config.load_kube_config()
    return client.ApiClient()


def _env(name: str, value: Optional[str] = None) -> client.V1EnvVar:
    return client.V1EnvVar(name=name, value="" if value is None else str(value))


def _stage_blob(job_id: str, stage: str, filename: str) -> str:
    return f"outputs/{job_id}/{filename}"


def create_k8s_inference_job(
    job_id: str,
    input_gcs_path: str,
    input_blob_name: str,
    filename: str,
    should_decrowd: bool,
    language: Union[str, None] = "mul",
    content_type: Union[str, None] = "video/mp4",
):
    """
    Function to create a K8s job for Benzaiten inference with the specified parameters.

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job name; generated in fastapi app
        input_gcs_path: GCS path to the input file (e.g. gs://bucket/path/to/file).
        input_blob_name: The blob name of the input file in GCS.
        filename: The original filename of the input file.
        should_decrowd: Boolean indicating whether to run decrowding during inference.
    """
    api_client = get_k8s_api_client()
    batch_v1 = client.BatchV1Api(api_client=api_client)
    job_name = _ensure_safe_k8s_name(f"benzaiten-inference-{job_id}")

    env_vars = [
        client.V1EnvVar(name="JOB_ID", value=job_id),
        client.V1EnvVar(name="GCS_BUCKET", value=GCS_BUCKET),
        client.V1EnvVar(name="INPUT_GCS_PATH", value=input_gcs_path),
        client.V1EnvVar(name="INPUT_BLOB_NAME", value=input_blob_name),
        client.V1EnvVar(name="FILENAME", value=filename),
        client.V1EnvVar(name="SHOULD_DECROWD", value=str(should_decrowd).lower()),
        client.V1EnvVar(name="LANGUAGE", value=language),
        client.V1EnvVar(name="CONTENT_TYPE", value=content_type),
    ]

    container = client.V1Container(
        name="benzaiten-inference",
        image=IMAGE,
        image_pull_policy="Always",
        command=["python", "-m", "backend.scripts.run_inference_job"],
        env=env_vars,
        resources=client.V1ResourceRequirements(
            requests={
                "cpu": "4",
                "memory": "12Gi",
            },
            limits={
                "cpu": "6",
                "memory": "24Gi",
            },
        ),
    )

    pod_spec = client.V1PodSpec(
        restart_policy="Never",
        service_account_name="benzaiten-backend-sa",
        node_selector={"cloud.google.com/gke-nodepool": CPU_INFERENCE_NODE_POOL},
        tolerations=[
            client.V1Toleration(
                key="inference", operator="Equal", value="true", effect="NoSchedule"
            )
        ],
        containers=[container],
    )

    template = client.V1PodTemplateSpec(
        metadata=client.V1ObjectMeta(
            labels={"app": "benzaiten-inference-job", "job-id": job_id}
        ),
        spec=pod_spec,
    )

    job_spec = client.V1JobSpec(
        template=template, backoff_limit=1, ttl_seconds_after_finished=600
    )

    output_video_filename = f"{Path(filename).stem}.mp4"
    job = client.V1Job(
        api_version="batch/v1",
        kind="Job",
        metadata=client.V1ObjectMeta(
            name=job_name,
            labels={
                "app": "benzaiten-inference-job",
                "job_id": job_id,
            },
            annotations={
                "benzaiten/output_video_filename": output_video_filename,
                "benzaiten/output_subtitle_filename": "vocals.vtt",
            },
        ),
        spec=job_spec,
    )

    batch_v1.create_namespaced_job(namespace=K8S_NAMESPACE, body=job)

    return job_name


# ------------------------
#  Split pipeline orchestration integration for jobs


def create_k8s_orchestration_job(
    job_id: str,
    input_blob_name: str,
    filename: str,
    should_decrowd: bool,
    fast_decrowd: bool = False,
    content_type: Union[str, None] = "video/mp4",
    language: Union[str, None] = "mul",
) -> str:
    """
    Function to create a lightweight k8s job solely for coordinating job orchestration in the pipeline
    - Doesn't run inference directly. Serves as a job to create and wait for the k8 stage jobs to host the inference backend
    - This aims to allow for pushing to production where there are several users running inference jobs at once

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job name; generated in fastapi app
        input_blob_name: The blob name of the input file in GCS.
        filename: The original filename of the input file.
        should_decrowd: Boolean indicating whether to run decrowding during inference.
        content_type: The content type of the input file (e.g. "video/mp4")

    Returns:
        The name of the created K8s job
    """
    api_client = get_k8s_api_client()
    batch_v1 = client.BatchV1Api(api_client=api_client)
    job_name = _ensure_safe_k8s_name(f"benzaiten-orchestration-{job_id}")

    env_vars = [
        _env("JOB_ID", job_id),
        _env("INPUT_BLOB_NAME", input_blob_name),
        _env("FILENAME", filename),
        _env("CONTENT_TYPE", content_type),
        _env("SHOULD_DECROWD", str(should_decrowd).lower()),
        _env("FAST_DECROWD", str(fast_decrowd).lower()),
        _env("LANGUAGE", language),
    ]

    container = client.V1Container(
        name="benzaiten-orchestrator",
        image=IMAGE,
        image_pull_policy="Always",
        command=["python", "-m", "backend.scripts.run_orchestration_job"],
        env=env_vars,
        resources=client.V1ResourceRequirements(
            requests={
                "cpu": "100m",
                "memory": "512Mi",
            },
            limits={
                "cpu": "1",
                "memory": "1Gi",
            },
        ),
    )

    pod_spec = client.V1PodSpec(
        restart_policy="Never",
        service_account_name="benzaiten-backend-sa",
        node_selector={"cloud.google.com/gke-nodepool": "default-pool"},
        containers=[container],
    )

    template = client.V1PodTemplateSpec(
        metadata=client.V1ObjectMeta(
            labels={
                "app": "benzaiten-orchestrator-job",
                "job_id": job_id,
                "stage": "orchestration",
            }
        ),
        spec=pod_spec,
    )

    job_spec = client.V1JobSpec(
        template=template,
        backoff_limit=1,
        ttl_seconds_after_finished=600,
    )

    job = client.V1Job(
        api_version="batch/v1",
        kind="Job",
        metadata=client.V1ObjectMeta(
            name=job_name,
            labels={
                "app": "benzaiten-orchestrator_job",
                "job_id": job_id,
                "stage": "orchestrator",
            },
        ),
        spec=job_spec,
    )

    batch_v1.create_namespaced_job(namespace=K8S_NAMESPACE, body=job)
    return job_name


def _create_k8s_pipeline_stage_job(
    *,
    job_id: str,
    stage: str,
    sh_cmd_module: str,
    env_vars: List[client.V1EnvVar],
    cpu_request: str = "2",
    memory_request: str = "8Gi",
    cpu_limit: str = "4",
    memory_limit: str = "16Gi",
    gpu_count: int = 1,
    node_pool: str = "gpu-pool",
    ttl_seconds_after_finished: int = 600,
    backoff_limit: int = 1,
    annotations: Optional[Dict[str, str]] = None,
) -> str:
    api_client = get_k8s_api_client()
    batch_v1 = client.BatchV1Api(api_client=api_client)

    job_name = _ensure_safe_k8s_name(f"benzaiten-inference-{stage}-{job_id}")

    resource_limits = {
        "cpu": cpu_limit,
        "memory": memory_limit,
    }

    if gpu_count > 0:
        resource_limits["nvidia.com/gpu"] = str(gpu_count)

    common_env_vars = [
        client.V1EnvVar(name="JOB_ID", value=job_id),
        client.V1EnvVar(name="PIPELINE_STAGE", value=stage),
        client.V1EnvVar(name="GCS_BUCKET", value=GCS_BUCKET),
    ]

    container = client.V1Container(
        name=f"benzaiten-inference-{stage}",
        image=IMAGE,
        image_pull_policy="Always",
        command=["python", "-m", sh_cmd_module],
        env=common_env_vars + env_vars,
        resources=client.V1ResourceRequirements(
            requests={
                "cpu": cpu_request,
                "memory": memory_request,
            },
            limits=resource_limits,
        ),
    )

    pod_spec = client.V1PodSpec(
        restart_policy="Never",
        service_account_name="benzaiten-backend-sa",
        node_selector={"cloud.google.com/gke-nodepool": node_pool},
        tolerations=[
            client.V1Toleration(
                key="inference",
                operator="Equal",
                value="true",
                effect="NoSchedule",
            )
        ],
        containers=[container],
    )

    template = client.V1PodTemplateSpec(
        metadata=client.V1ObjectMeta(
            labels={
                "app": "benzaiten-inference-job",
                "job_id": job_id,
                "stage": stage,
            }
        ),
        spec=pod_spec,
    )

    job_spec = client.V1JobSpec(
        template=template,
        backoff_limit=backoff_limit,
        ttl_seconds_after_finished=ttl_seconds_after_finished,
    )

    job = client.V1Job(
        api_version="batch/v1",
        kind="Job",
        metadata=client.V1ObjectMeta(
            name=job_name,
            labels={
                "app": "benzaiten-inference-job",
                "job_id": job_id,
                "stage": stage,
            },
            annotations=annotations or {},
        ),
        spec=job_spec,
    )

    batch_v1.create_namespaced_job(namespace=K8S_NAMESPACE, body=job)
    return job_name


def create_k8s_source_separation_inference_job(
    job_id: str,
    input_gcs_path: str,
    input_blob_name: str,
    filename: str,
    content_type: Union[str, None] = "video/mp4",
) -> str:
    """
    Do a vocal/instrumental source separation and write those to GCS bucket

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job
        input_gcs_path: GCS path to the input file (e.g. gs://bucket/path/to/file).
        input_blob_name: The blob name of the input file in GCS.
        filename: The original filename of the input file.
        content_type: The content type of the input file (e.g. "video/mp4

    Returns:
        The name of the created K8s job
    """
    return _create_k8s_pipeline_stage_job(
        job_id=job_id,
        stage="source-separation",
        sh_cmd_module="backend.scripts.orchestration_jobs.run_source_separation_job",
        env_vars=[
            _env("INPUT_GCS_PATH", input_gcs_path),
            _env("INPUT_BLOB_NAME", input_blob_name),
            _env("FILENAME", filename),
            _env("CONTENT_TYPE", content_type),
        ],
        annotations={
            "benzaiten/output_vocals_filename": "vocals.mp3",
            "benzaiten/source_separation_output_prefix": f"outputs/{job_id}/",
        },
        node_pool=GPU_INFERENCE_NODE_POOL,
        gpu_count=1,
    )


def create_k8s_decrowd_inference_job(
    job_id: str, filename: str, fast_decrowd: bool = False
) -> str:
    """
    do a decrowding operation on the input audio and write the decrowded instrumentals to GCS bucket

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job name; generated in fastapi app
        filename: The original filename of the input file.

    Returns:
        The name of the created K8s job
    """
    return _create_k8s_pipeline_stage_job(
        job_id=job_id,
        stage="decrowd",
        sh_cmd_module="backend.scripts.orchestration_jobs.run_decrowd_job",
        env_vars=[
            _env("FILENAME", filename),
            _env(
                "INPUT_AUDIO_BLOB_NAME",
                _stage_blob(job_id, "source_separation", "instrumental.mp3"),
            ),
            _env(
                "OUTPUT_AUDIO_BLOB_NAME",
                _stage_blob(job_id, "decrowd", "instrumental_(decrowd).mp3"),
            ),
            _env("SHOULD_DECROWD", "true"),
            _env("FAST_DECROWD", str(fast_decrowd).lower()),
        ],
        annotations={
            "benzaiten/decrowd_output_prefix": f"outputs/{job_id}/",
        },
        node_pool=GPU_INFERENCE_NODE_POOL,
        gpu_count=1,
    )


def create_k8s_transcription_inference_job(
    job_id: str,
    filename: str,
    language: Union[str, None] = "mul",
) -> str:
    """
    do a transcription operation on the input audio and write the transcriptions and translations as the srt/vtt to GCS bucket

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job name; generated in fastapi app
        filename: The original filename of the input file.
        language: The language code for the transcription (e.g. "en", "ko"; "mul" for multilingual)
    Returns:
        The name of the created K8s job
    """
    return _create_k8s_pipeline_stage_job(
        job_id=job_id,
        stage="transcription",
        sh_cmd_module="backend.scripts.orchestration_jobs.run_transcription_job",
        env_vars=[
            _env("FILENAME", filename),
            _env("LANGUAGE", language),
            _env(
                "INPUT_AUDIO_BLOB_NAME",
                _stage_blob(job_id, "source_separation", "vocals.mp3"),
            ),
            _env(
                "OUTPUT_SRT_BLOB_NAME",
                _stage_blob(job_id, "transcription", "vocals.srt"),
            ),
            _env(
                "OUTPUT_VTT_BLOB_NAME",
                _stage_blob(job_id, "transcription", "vocals.vtt"),
            ),
        ],
        annotations={
            "benzaiten/output_subtitle_filename": "vocals.vtt",
            "benzaiten/transcription_output_prefix": f"outputs/{job_id}/",
        },
        node_pool=GPU_INFERENCE_NODE_POOL,
        gpu_count=1,
    )


def create_k8s_build_video_job(
    job_id: str,
    filename: str,
    should_decrowd: bool,
    input_blob_name: str,
    content_type: Union[str, None] = "video/mp4",
    video_gcs_path: Union[str, None] = None,
    audio_gcs_path: Union[str, None] = None,
    srt_gcs_path: Union[str, None] = None,
) -> str:
    """
    do a build video operation that takes in the separated/decrowded audio, original video, and generated subtitles to create the final output video and write it to GCS bucket

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job name; generated in fastapi app
        filename: The original filename of the input file.
        should_decrowd: Boolean indicating whether to run decrowding during inference to determine which audio to use an input
        video_gcs_path: Optional GCS path to the input video file; if not provided, will default to source separation output path
        audio_gcs_path: Optional GCS path to the input audio file; if not provided, defaults to decrowd output path/source separation output path
        srt_gcs_path: Optional GCS path to the input srt file; if not provided, will default to transcription output path

    Returns:
        The name of the created K8s job
    """
    is_video = content_type is not None and content_type.startswith("video/")
    output_video_filename = f"{Path(filename).stem}.mp4"
    output_audio_filename = f"{Path(filename).stem}.mp3"

    default_audio_gcs_path = (
        _stage_blob(job_id, "decrowd", "instrumental_(decrowd).mp3")
        if should_decrowd
        else _stage_blob(job_id, "source_separation", "instrumental.mp3")
    )

    return _create_k8s_pipeline_stage_job(
        job_id=job_id,
        stage="build-video",
        sh_cmd_module="backend.scripts.orchestration_jobs.run_build_video_job",
        env_vars=[
            _env("FILENAME", filename),
            _env("IS_VIDEO", str(is_video).lower()),
            _env("INPUT_BLOB_NAME", input_blob_name),
            _env(
                "VIDEO_BLOB_NAME",
                video_gcs_path
                or _stage_blob(job_id, "source_separation", "input_video.mp4"),
            ),
            _env(
                "AUDIO_BLOB_NAME",
                audio_gcs_path or default_audio_gcs_path,
            ),
            _env(
                "SRT_BLOB_NAME",
                srt_gcs_path or _stage_blob(job_id, "transcription", "vocals.srt"),
            ),
            _env(
                "VTT_BLOB_NAME",
                _stage_blob(job_id, "transcription", "vocals.vtt"),
            ),
            _env(
                "OUTPUT_VIDEO_BLOB_NAME",
                _stage_blob(job_id, "final_output", output_video_filename),
            ),
            _env(
                "OUTPUT_AUDIO_BLOB_NAME",
                _stage_blob(job_id, "final_output", output_audio_filename),
            ),
        ],
        annotations={
            "benzaiten/final_output_video_filename": output_video_filename,
            "benzaiten/final_output_audio_filename": output_audio_filename,
            "benzaiten/final_output_prefix": f"outputs/{job_id}/",
        },
        node_pool="default-pool",
        gpu_count=0,
        cpu_request="100m",
        memory_request="2Gi",
        cpu_limit="2",
        memory_limit="4Gi",
    )


def wait_for_jobs(
    job_names: List[str],
    namespace: str = K8S_NAMESPACE,
    poll_interval_seconds: int = 30,
    timeout_seconds: int = 60 * 60,
) -> None:
    """
    Function to wait for a list of K8s jobs to complete, with a timeout.

    Args:
        job_names: List of K8s job names to wait for.
        namespace: The Kubernetes namespace where the jobs are running.
        poll_interval_seconds: How often to check the status of the jobs.
        timeout_seconds: Maximum time to wait for the jobs to complete before raising a TimeoutError.
    """
    api_client = get_k8s_api_client()
    batch_v1 = client.BatchV1Api(api_client=api_client)

    remaining_jobs = set(job_names)
    start_time = time.monotonic()

    while remaining_jobs:
        if time.monotonic() - start_time > timeout_seconds:
            raise TimeoutError(
                f"Timeout while waiting for jobs: {sorted(remaining_jobs)}"
            )

        finished_jobs = set()

        for job_name in remaining_jobs:
            try:
                job = batch_v1.read_namespaced_job_status(
                    name=job_name,
                    namespace=namespace,
                )
            except ApiException as e:
                raise RuntimeError(
                    f"Error while fetching job status for {job_name}: {e}"
                )

            status = job.status
            conditions = status.conditions or []

            for condition in conditions:
                if condition.type == "Complete" and condition.status == "True":
                    finished_jobs.add(job_name)
                    break

                if condition.type == "Failed" and condition.status == "True":
                    raise RuntimeError(f"K8s job {job_name} failed: {status}")

        remaining_jobs -= finished_jobs

        if remaining_jobs:
            time.sleep(poll_interval_seconds)
