from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

import json
import os
import uuid
import warnings
from typing import Tuple, Dict, Union
from pathlib import Path

from backend.scripts.ffmpeg import split_sources, build_video, convert_srt_to_vtt
from backend.gcp_utils.gcs_bucket import (
    upload_file_to_gcs,
    download_file_from_gcs,
    remove_file_from_gcs,
    upload_input_file_to_gcs,
)
from backend.scripts.benzaiten_inference.k8s.kubernetes_utils import (
    get_k8s_api_client,
    create_k8s_inference_job,
    create_k8s_orchestration_job,
)

app = FastAPI()
GCS_BUCKET = os.environ.get("GCS_BUCKET", "benzaiten-outputs")
IMAGE = os.environ.get(
    "IMAGE",
    "northamerica-northeast2-docker.pkg.dev/project-0c6e9a84-c914-4d2f-ace/benzaiten/benzaiten-inference:latest",
)
K8S_NAMESPACE = os.environ.get("K8S_NAMESPACE", "default")


@app.get("/")
def root():
    """
    Note: this is basically only here for testing if the server is running successfully with curl
    """
    return {"status": "ok", "message": "inference server is running"}


def create_job_id() -> str:
    """
    Function to create a unique job id for each inference job, used for tracking and file management in GCS bucket
    Returns:
        job_id string
    """
    return str(uuid.uuid4())


@app.post("/inference")
async def run_inference(
    file: UploadFile = File(...),
    # model_name: Literal["bs-roformer", "decrowd"] = Form("bs-roformer"),
    should_decrowd: bool = Form(False),
) -> Tuple[Dict, str]:
    """
    Endpoint running inference of music source separation
    """
    # emit deprecation warning
    warnings.warn(
        "run_inference endpoint is deprecated with the new k8s job pipeline. Keep only for the old pipeline."
    )

    from backend.scripts.process import run_karaoke_inference

    job_id = create_job_id()

    input_dir = Path(f"/tmp/{job_id}")
    input_dir.mkdir(parents=True, exist_ok=True)

    output_dir = Path(f"/tmp/outputs/{job_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    input_path = input_dir / file.filename

    with open(input_path, "wb") as f:
        f.write(await file.read())

    is_video = file.content_type is not None and file.content_type.startswith("video/")
    model_name = "bs-roformer"

    try:
        if is_video:
            video_path, audio_path = split_sources(
                video_path=str(input_path), output_dir=str(input_dir)
            )
            inference_input_path = str(audio_path)
        else:
            video_path = None
            inference_input_path = str(input_path)

        run_karaoke_inference(
            model_name=model_name,
            audio_path=inference_input_path,
            output_path=str(output_dir),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    output_dict = dict()

    # if model_name == "bs-roformer":
    output_dict = {
        "status": "done",
        "model": "bs-roformer",
        "vocals": "vocals.mp3",
        "instrumental": "instrumental.mp3",
    }
    output_dict["gcs_links"] = {}

    # push files to gcs bucket
    for output_type in ["vocals", "instrumental"]:
        local_path = output_dir / output_dict[output_type]
        if not os.path.exists(local_path):
            raise HTTPException(
                status_code=500, detail=f"Expected output file missing: {local_path}"
            )

        destination_blob_name = f"outputs/{job_id}/{output_dict[output_type]}"

        gcs_link = upload_file_to_gcs(
            local_path=local_path,
            bucket_name=GCS_BUCKET,
            destination_blob_name=destination_blob_name,
        )

        output_dict["gcs_links"][output_type] = gcs_link

    if should_decrowd:  # model_name == "decrowd":
        # run another inference with the decrowd model
        model_name = "decrowd"
        decrowd_input_path = output_dir / "instrumental.mp3"
        if not decrowd_input_path.exists():
            raise HTTPException(
                status_code=500,
                detail="instrumental.mp3 not found; first inference may have failed",
            )

        try:
            run_karaoke_inference(
                model_name=model_name,
                audio_path=str(decrowd_input_path),
                output_path=str(output_dir),
            )
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

        output_dict["model"] = "bs-roformer+decrowd"
        output_dict["crowd"] = "crowd.mp3"
        output_dict["instrumental_(decrowd)"] = "instrumental_(decrowd).mp3"

        # push files to gcs bucket. only want to push the decrowded instrumental output, crowd output is useless
        output_type = "instrumental_(decrowd)"
        local_path = output_dir / output_dict[output_type]
        if not os.path.exists(local_path):
            raise HTTPException(
                status_code=500, detail=f"Expected output file missing: {local_path}"
            )

        destination_blob_name = f"outputs/{job_id}/{output_dict[output_type]}"

        gcs_link = upload_file_to_gcs(
            local_path=local_path,
            bucket_name=GCS_BUCKET,
            destination_blob_name=destination_blob_name,
        )

        output_dict["gcs_links"][output_type] = gcs_link

    if is_video and video_path is not None:
        output_dict["video"] = video_path.name

        # upload video to gcs bucket as well for user access
        destination_blob_name = f"outputs/{job_id}/{video_path.name}"

        gcs_link = upload_file_to_gcs(
            local_path=str(video_path),
            bucket_name=GCS_BUCKET,
            destination_blob_name=destination_blob_name,
        )

        output_dict["gcs_links"]["video"] = gcs_link

    return output_dict, job_id


@app.get("/download/{job_id}/{filename}")
def download_file(job_id: str, filename: str):
    file_path = f"/tmp/outputs/{job_id}/{filename}"

    if os.path.exists(file_path):
        return FileResponse(path=file_path, media_type="audio/mpeg", filename=filename)
    else:
        return {"status": "error", "message": "file not found"}


@app.post("/transcribe")
async def run_transcription(
    job_id: str, filename: str = "vocals.mp3", language: str = None
) -> Dict:
    """
    Run transcription on a vocals file given the job id, returning the srt file which is saved to GCS bucket
    """
    from backend.language_models.transcribe import run_srt_inference

    input_dir = Path(f"/tmp/{job_id}")
    input_dir.mkdir(parents=True, exist_ok=True)
    input_path = input_dir / filename

    source_blob = f"outputs/{job_id}/{filename}"

    try:
        local_audio_path = download_file_from_gcs(
            bucket_name=GCS_BUCKET,
            source_blob_name=source_blob,
            local_path=str(input_path),
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"file download from GCS failed: {str(e)}"
        )

    output_dir = Path(f"/tmp/outputs/{job_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    try:
        srt_output_path = run_srt_inference(
            audio_path=str(local_audio_path),
            output_path=str(output_dir),
            language=language,
        )

        # upload srt output to gcs bucket
        destination_blob_name = f"outputs/{job_id}/{Path(srt_output_path).name}"

        gcs_link = upload_file_to_gcs(
            local_path=str(srt_output_path),
            bucket_name=GCS_BUCKET,
            destination_blob_name=destination_blob_name,
        )

        return {
            "status": "done",
            "job_id": job_id,
            "srt_link": gcs_link,
            "gcs_blob": destination_blob_name,
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"transcription failed: {str(e)}")


@app.post("/full_inference")
async def run_full_inference(
    file: UploadFile = File(...),
    should_decrowd: bool = Form(False),
    language: Union[str, None] = Form(None),
) -> Dict:
    """
    Runs the full inference pipeline: source separation -> transcription -> translation -> romanization -> remove (temp) GCS files -> construct video with subtitles
    Automate all GCS uploads and downloads in the process.

    Args:
        file: the input file from the user, either video or audio, uploaded through the FastAPI endpoint
        should_decrowd: whether to run the decrowding model after source separation
        language: input file audio language
    Returns:
        dict containing job_id and status message
    """
    print("full_inference language:", language, flush=True)

    video_name = Path(file.filename).stem
    output_dict, job_id = await run_inference(file=file, should_decrowd=should_decrowd)

    # if model_name == "bs-roformer":
    transcription_res = await run_transcription(job_id=job_id, language=language)
    # after transcription, we can remove the temp vocals file from gcs bucket
    output_dict["srt_link"] = transcription_res["srt_link"]
    remove_file_from_gcs(
        bucket_name=GCS_BUCKET,
        blob_name=output_dict["gcs_links"]["vocals"].replace(f"gs://{GCS_BUCKET}/", ""),
    )

    if should_decrowd:  # model_name == "decrowd":
        # choose the correct audio path
        audio_path = download_file_from_gcs(
            bucket_name=GCS_BUCKET,
            source_blob_name=output_dict["gcs_links"]["instrumental_(decrowd)"].replace(
                f"gs://{GCS_BUCKET}/", ""
            ),
            local_path=f"/tmp/{job_id}/{output_dict['instrumental_(decrowd)']}",
        )
        # decrowd model inputs the audio with crowd noise, so this original input can be removed
        remove_file_from_gcs(
            bucket_name=GCS_BUCKET,
            blob_name=output_dict["gcs_links"]["instrumental"].replace(
                f"gs://{GCS_BUCKET}/", ""
            ),
        )
    else:
        audio_path = download_file_from_gcs(
            bucket_name=GCS_BUCKET,
            source_blob_name=output_dict["gcs_links"]["instrumental"].replace(
                f"gs://{GCS_BUCKET}/", ""
            ),
            local_path=f"/tmp/{job_id}/{output_dict['instrumental']}",
        )

    # build the video
    if "video" in output_dict["gcs_links"]:
        build_video(
            video_path=download_file_from_gcs(
                bucket_name=GCS_BUCKET,
                source_blob_name=output_dict["gcs_links"]["video"].replace(
                    f"gs://{GCS_BUCKET}/", ""
                ),
                local_path=f"/tmp/{job_id}/{output_dict['video']}",
            ),
            audio_path=audio_path,
            srt_path=download_file_from_gcs(
                bucket_name=GCS_BUCKET,
                source_blob_name=output_dict["srt_link"].replace(
                    f"gs://{GCS_BUCKET}/", ""
                ),
                local_path=f"/tmp/{job_id}/subtitles.srt",
            ),
            output_path=f"/tmp/outputs/{job_id}/final_video.mp4",
        )

        # now that the final video is built, the instrumental and video file can be removed from the gcs bucket
        if should_decrowd:  # model_name == "decrowd":
            remove_file_from_gcs(
                bucket_name=GCS_BUCKET,
                blob_name=output_dict["gcs_links"]["instrumental_(decrowd)"].replace(
                    f"gs://{GCS_BUCKET}/", ""
                ),
            )
        else:
            remove_file_from_gcs(
                bucket_name=GCS_BUCKET,
                blob_name=output_dict["gcs_links"]["instrumental"].replace(
                    f"gs://{GCS_BUCKET}/", ""
                ),
            )

        remove_file_from_gcs(
            bucket_name=GCS_BUCKET,
            blob_name=output_dict["gcs_links"]["video"].replace(
                f"gs://{GCS_BUCKET}/", ""
            ),
        )

        # push the final video to gcs bucket
        dest_blob = f"outputs/{job_id}/{video_name}.mp4"
        upload_file_to_gcs(
            local_path=f"/tmp/outputs/{job_id}/final_video.mp4",
            bucket_name=GCS_BUCKET,
            destination_blob_name=dest_blob,
        )

    return {
        "status": "full inference done",
        "job_id": job_id,
        "video_url": f"https://storage.googleapis.com/benzaiten-outputs/outputs/{job_id}/{video_name}.mp4",
        "subtitle_url": f"https://storage.googleapis.com/benzaiten-outputs/outputs/{job_id}/vocals.vtt",
    }


@app.post("/jobs/{job_id}/convert_to_vtt")
def convert_to_vtt(job_id: str) -> dict:
    """
    This function takes in an srt file and converts it to a vtt file, which can be used for subtitles in the video player.

    Args:
        job_id (str): The job id of the inference job, used to locate the srt file in the gcs bucket.
    """
    output_dir = Path(f"/tmp/outputs/{job_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    srt_path = output_dir / "vocals.srt"
    vtt_path = output_dir / "vocals.vtt"

    # download srt file from gcs bucket
    try:
        download_file_from_gcs(
            bucket_name=GCS_BUCKET,
            source_blob_name=f"outputs/{job_id}/vocals.srt",
            local_path=str(srt_path),
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"file download from GCS failed: {str(e)}"
        )

    # convert srt to vtt
    try:
        convert_srt_to_vtt(srt_path=str(srt_path), vtt_path=str(vtt_path))
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"srt to vtt conversion failed: {str(e)}"
        )

    # upload vtt file to gcs bucket
    try:
        upload_file_to_gcs(
            local_path=str(vtt_path),
            bucket_name=GCS_BUCKET,
            destination_blob_name=f"outputs/{job_id}/vocals.vtt",
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"file upload to GCS failed: {str(e)}"
        )

    return {
        "status": "vtt converted",
        "job_id": job_id,
        "vtt_link": f"https://storage.googleapis.com/{GCS_BUCKET}/outputs/{job_id}/vocals.vtt",
        "vtt_url": f"https://storage.googleapis.com/benzaiten-outputs/outputs/{job_id}/vocals.vtt",
    }


# @app.post("/jobs")
async def create_inference_job(
    file: UploadFile = File(...),
    should_decrowd: bool = Form(False),
    language: Union[str, None] = Form(None),
) -> Dict:
    """
    Adapted function from run_full_inference to support K8 job creation to run inference on GKE per request, versus keeping the pod open in an always "on-deployment" state.
    Here, a k8s job is created for full inference initialization but now we pass the actual inference to the k8s job instead of running it in the fastapi app
    Args:
        file: the input file from the user, either video or audio, uploaded through the FastAPI endpoint
        should_decrowd: whether to run the decrowding model after source separation
        language: input file audio language
    Returns:
        dict containing job_id and status message
    """
    job_id = create_job_id()

    try:
        input_gcs_path, input_blob_name, filename = await upload_input_file_to_gcs(
            file=file, job_id=job_id
        )

        job_name = create_k8s_inference_job(
            job_id=job_id,
            input_gcs_path=input_gcs_path,
            input_blob_name=input_blob_name,
            filename=filename,
            should_decrowd=should_decrowd,
            language=language,
            content_type=file.content_type,
        )

        return {
            "status": "queued",
            "job_id": job_id,
            "k8s_job_name": job_name,
            "input_gcs_path": input_gcs_path,
        }
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"k8s job creation failed: {str(e)}"
        )


@app.post("/jobs")
async def create_orchestration_inference_pipeline_job(
    file: UploadFile = File(...),
    should_decrowd: bool = Form(False),
    language: Union[str, None] = Form(None),
) -> Dict:
    """
    Create a Kubernetes orchestration Job and return immediately for frontend polling.
    """
    from backend.scripts.orchestration_jobs.status import write_inference_job_status

    job_id = create_job_id()

    try:
        input_gcs_path, input_blob_name, filename = await upload_input_file_to_gcs(
            file=file,
            job_id=job_id,
        )

        orchestration_job_name = create_k8s_orchestration_job(
            job_id=job_id,
            input_blob_name=input_blob_name,
            filename=filename,
            content_type=file.content_type,
            should_decrowd=should_decrowd,
            language=language,
        )

        write_inference_job_status(job_id=job_id, status="queued")

        return {
            "status": "queued",
            "job_id": job_id,
            "k8s_job_name": orchestration_job_name,
            "input_gcs_path": input_gcs_path,
        }

    except Exception as e:
        write_inference_job_status(job_id=job_id, status="failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"inference orchestration job creation failed: {str(e)}",
        )


@app.get("/jobs/{job_id}")
def get_inference_job_status(job_id: str) -> Dict[str, str]:
    """
    Endpoint to get the status of an inference job given the job id.
    Used for polling the status of the job from the frontend.
    Returns four possible statuses of the job: "queued", "running", "failed", "completed".

    Args:
        job_id: the unique identifier for the inference job, generated in the create_inference_job endpoint
    Returns:
        dict containing job_id and status message
    """
    from kubernetes import client
    from kubernetes.client.rest import ApiException

    def completed_result_response() -> Union[Dict[str, str], None]:
        res_path = Path(f"/tmp/{job_id}_result.json")

        try:
            download_file_from_gcs(
                bucket_name=GCS_BUCKET,
                source_blob_name=f"outputs/{job_id}/result.json",
                local_path=str(res_path),
            )
        except Exception:
            return None

        with open(res_path, "r") as f:
            result = json.load(f)

        if (
            result.get("status") != "full inference done"
            or not result.get("video_url")
            or not result.get("subtitle_url")
        ):
            return None

        return {
            "job_id": job_id,
            "status": "completed",
            "video_url": result["video_url"],
            "subtitle_url": result["subtitle_url"],
        }

    def failed_status_response() -> Union[Dict[str, str], None]:
        status_path = Path(f"/tmp/{job_id}_status.json")

        try:
            download_file_from_gcs(
                bucket_name=GCS_BUCKET,
                source_blob_name=f"outputs/{job_id}/status.json",
                local_path=str(status_path),
            )
        except Exception:
            return None

        with open(status_path, "r") as f:
            status_result = json.load(f)

        if status_result.get("status") != "failed":
            return None

        return {
            "job_id": job_id,
            "status": "failed",
            "error": status_result.get("error", "Inference job failed"),
        }

    try:
        result_response = completed_result_response()
        if result_response is not None:
            return result_response

        failed_response = failed_status_response()
        if failed_response is not None:
            return failed_response

        api_client = get_k8s_api_client()
        batch_v1 = client.BatchV1Api(api_client=api_client)
        job_name = f"benzaiten-inference-{job_id}"

        try:
            jobs = [
                batch_v1.read_namespaced_job_status(
                    name=job_name, namespace=K8S_NAMESPACE
                )
            ]
        except ApiException as e:
            if e.status != 404:
                raise

            jobs = batch_v1.list_namespaced_job(
                namespace=K8S_NAMESPACE,
                label_selector=f"job_id={job_id}",
            ).items

        if not jobs:
            return {"job_id": job_id, "status": "queued"}

        if any(job.status.failed and job.status.failed >= 1 for job in jobs):
            return {"job_id": job_id, "status": "failed"}

        if any(job.status.active and job.status.active >= 1 for job in jobs):
            return {"job_id": job_id, "status": "running"}

        if all(job.status.succeeded and job.status.succeeded >= 1 for job in jobs):
            result_response = completed_result_response()
            if result_response is not None:
                return result_response

            return {"job_id": job_id, "status": "running"}

        return {"job_id": job_id, "status": "queued"}

    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"failed to get k8s job status: {str(e)}"
        )


# add CORS middleware to allow requests from the frontend (served on a different origin)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://kseto06.github.io",  # putting for now
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# testing
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
