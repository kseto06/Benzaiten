import re
import os
from pathlib import Path
from typing import Union
from kubernetes import client, config
from kubernetes.config.config_exception import ConfigException

GCS_BUCKET = os.environ.get("GCS_BUCKET", "benzaiten-outputs")
IMAGE = os.environ.get("IMAGE", "northamerica-northeast2-docker.pkg.dev/project-0c6e9a84-c914-4d2f-ace/benzaiten/benzaiten-inference:latest")
K8S_NAMESPACE = os.environ.get("K8S_NAMESPACE", "default")

def _ensure_safe_k8s_name(name: str) -> str:
    '''
    Function to ensure K8 has a valid resource name

    Args:
        name: String input of the name to validate and convert
    Returns:
        A string that is a valid K8 resource name
    '''
    name = name.lower()
    name = re.sub(r'[^a-z0-9-]+', '-', name)
    name = name.strip('-')
    return name[:63]

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

def _load_k8s_config():
    '''
    Function to load K8s config. If running in-cluster, load in-cluster config. Otherwise, load kubeconfig from default location.
    '''
    try:
        config.load_incluster_config()
    except ConfigException:
        config.load_kube_config()

def create_k8s_inference_job(
    job_id: str,
    input_gcs_path: str,
    input_blob_name: str,
    filename: str,
    should_decrowd: bool,
    language: Union[str, None] = "mul",
    content_type: Union[str, None] = "video/mp4"
):
    '''
    Function to create a K8s job for Benzaiten inference with the specified parameters.

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job name; generated in fastapi app
        input_gcs_path: GCS path to the input file (e.g. gs://bucket/path/to/file).
        input_blob_name: The blob name of the input file in GCS.
        filename: The original filename of the input file.
        should_decrowd: Boolean indicating whether to run decrowding during inference.
    '''
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
        client.V1EnvVar(name="CONTENT_TYPE", value=content_type)
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
        )
    )

    pod_spec = client.V1PodSpec(
        restart_policy="Never",
        service_account_name="benzaiten-backend-sa",
        node_selector={
            "cloud.google.com/gke-nodepool": "cpu-inference-pool"
        },
        tolerations=[
            client.V1Toleration(
                key="inference",
                operator="Equal",
                value="true",
                effect="NoSchedule"
            )
        ],
        containers=[container]
    )

    template = client.V1PodTemplateSpec(
        metadata=client.V1ObjectMeta(
            labels = {
                "app": "benzaiten-inference-job",
                "job-id": job_id
            }
        ),
        spec=pod_spec
    )

    job_spec = client.V1JobSpec(
        template=template,
        backoff_limit=1,
        ttl_seconds_after_finished=600
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
                "benzaiten/output_subtitle_filename": "vocals.vtt"
            }
        ),
        spec=job_spec
    )

    batch_v1.create_namespaced_job(
        namespace=K8S_NAMESPACE,
        body=job
    )

    return job_name

# ------------------------
#  Split pipeline orchestration integration for jobs

def create_k8s_source_separation_inference_job(
    job_id: str,
    input_gcs_path: str,
    input_blob_name: str,
    filename: str
) -> str:
    '''
    do a vocal/instrumental source separation and write those to GCS bucket
    '''
    return NotImplementedError("Source separation job creation not implemented yet")

def create_k8s_decrowd_inference_job(
    job_id: str,
    filename: str
) -> str:
    '''
    do a decrowding operation on the input audio and write the decrowded instrumentals to GCS bucket

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job name; generated in fastapi app
    '''
    return NotImplementedError("Decrowding job creation not implemented yet")

def create_k8s_transcription_inference_job(
    job_id: str,
    filename: str,
    language: Union[str, None] = "mul",
) -> str:
    '''
    do a transcription operation on the input audio and write the transcriptions and translations as the srt/vtt to GCS bucket

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job name; generated in fastapi app
    '''
    return NotImplementedError("Transcription job creation not implemented yet")

def create_k8s_build_video_job(
    job_id: str,
    filename: str,
    video_gcs_path: Union[str, None],
    audio_gcs_path: Union[str, None],
    srt_gcs_path: Union[str, None]
) -> str:
    '''
    do a build video operation that takes in the separated/decrowded audio, original video, and generated subtitles to create the final output video and write it to GCS bucket

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job name; generated in fastapi app
    '''
    return NotImplementedError("Build video job creation not implemented yet")

def wait_for_jobs():
    raise NotImplementedError("function to wait for the completion of multiple k8s jobs to ensure outputs are computed before moving to next stages (in the split pipeline orchestration integration)")