'''
This is the script for deploying a k8s inference job defined in the fastapi app

It's simply reproducing the v1 deployment pipeline in run_full_inference, but instead of running the pipeline with the pod always open 
in the cluster (which wastes resources), we deploy it on a k8s job which runs the full pipeline and then terminates once inference is complete.
'''
import os
from pathlib import Path
from typing import Optional, Dict

from backend.gcp_utils.gcs_bucket import download_file_from_gcs, upload_file_to_gcs, remove_file_from_gcs
from backend.scripts.ffmpeg import split_sources, build_video, convert_srt_to_vtt
from backend.scripts.process import run_karaoke_inference
from backend.language_models.transcribe import run_srt_inference

GCS_BUCKET = os.environ.get("GCS_BUCKET", "benzaiten-outputs")

def run_inference_job() -> Dict:
    '''
    Function to run the full inference pipeline: source separation -> transcription -> translation -> romanization -> remove (temp) GCS files -> construct video with subtitles
    Automate all GCS uploads and downloads in the process.

    This function is intended to be run as part of a K8s job, where the parameters are passed in as environment variables. The K8s job will run this function, which will execute the full inference pipeline, and then terminate once complete.

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job name; generated in fastapi app
        input_gcs_path: GCS path to the input file (e.g. gs://bucket/path/to/file).
        input_blob_name: The blob name of the input file in GCS.
        filename: The original filename of the input file.
        should_decrowd: Boolean indicating whether to run decrowding during inference.
    Returns:
        dict containing job_id and status message
    '''
    # get job configs from the env vars
    job_id = os.environ["JOB_ID"]
    input_blob_name = os.environ["INPUT_BLOB_NAME"]
    filename = os.environ["FILENAME"]
    should_decrowd = os.environ.get("SHOULD_DECROWD", "false").lower() == "true"
    language: Optional[str] = os.environ.get("LANGUAGE") or None
    content_type = os.environ.get("CONTENT_TYPE", "video/mp4")

    # created the tmp input and output dirs for storing local videos as the pipeline runs
    input_dir = Path(f"/tmp/{job_id}")
    input_dir.mkdir(parents=True, exist_ok=True)

    output_dir = Path(f"/tmp/outputs/{job_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    input_path = input_dir / filename
    video_name = Path(filename).stem

    # retreive input file from GCS (new for k8s job pipeline)
    local_input_path = Path(
        download_file_from_gcs(
            bucket_name=GCS_BUCKET,
            source_blob_name=input_blob_name,
            local_path=str(input_path)
        )
    )
    
    # prepare for bs-roformer (instrumental/vocal) source separation
    is_video = content_type is not None and content_type.startswith("video/")
    model_name = "bs-roformer"

    try: 
        if is_video: 
            video_path, audio_path = split_sources(video_path=str(local_input_path), output_dir=str(input_dir))
            inference_input_path = str(audio_path)
        else:
            video_path = None
            inference_input_path = str(local_input_path)
        
        run_karaoke_inference(
            model_name=model_name,
            audio_path=inference_input_path,
            output_path=str(output_dir)
        )
    except Exception as e:
        raise RuntimeError(f"Source separation failed: {e}")

    # construct vocal + instrumental paths + add checks
    vocals_path = output_dir / "vocals.mp3"
    instrumental_path = output_dir / "instrumental.mp3"

    if not vocals_path.exists():
        raise FileNotFoundError(f"Expected output file missing: {vocals_path}")

    if not instrumental_path.exists():
        raise FileNotFoundError(f"Expected output file missing: {instrumental_path}")
    
    # construct local files dict 
    output_dict = {
        "status": "done",
        "model": "bs-roformer",
        "vocals": "vocals.mp3",
        "instrumental": "instrumental.mp3",
        "gcs_links": {}
    }

    # decrowding pipeline (if selected)
    if should_decrowd:
        model_name = "decrowd"
        decrowd_input_path = instrumental_path

        if not decrowd_input_path.exists():
            raise FileNotFoundError(f"expected input file (from bs-roformer inference) for decrowding missing: {decrowd_input_path}")
        
        run_karaoke_inference(
            model_name=model_name,
            audio_path=str(decrowd_input_path),
            output_path=str(output_dir)
        )

        decrowd_instrumental_path = output_dir / "instrumental_(decrowd).mp3"

        if not decrowd_instrumental_path.exists():
            raise FileNotFoundError(f"expected output file from decrowding missing: {decrowd_instrumental_path}")
        
        output_dict["model"] = "bs-roformer+decrowd"
        output_dict["crowd"] = "crowd.mp3"
        output_dict["instrumental_(decrowd)"] = "instrumental_(decrowd).mp3"

        final_audio_path = decrowd_instrumental_path

    else:
        final_audio_path = instrumental_path

    # transcription/translation pipeline
    srt_output_path = run_srt_inference(
        audio_path=str(vocals_path), 
        output_path=str(output_dir), 
        language=language
    )

    srt_output_path = Path(srt_output_path)

    if not srt_output_path.exists():
        raise FileNotFoundError(f"expected output file from transcription missing: {srt_output_path}")

    output_dict["srt"] = srt_output_path.name

    # srt -> vtt conversion
    vtt_path = output_dir / "vocals.vtt"
    convert_srt_to_vtt(
        srt_path=str(srt_output_path),
        vtt_path=str(vtt_path)
    )
    if not vtt_path.exists():
        raise FileNotFoundError(f"expected output file from srt to vtt conversion missing: {vtt_path}")
    
    # building the final video 
    final_video_path, final_video_blob = None, None

    if is_video and video_path is not None:
        output_dict["video"] = Path(video_path).name
        final_video_path = output_dir / "final_video.mp4"

        build_video(
            video_path=str(video_path),
            audio_path=str(final_audio_path),
            srt_path=str(srt_output_path),
            output_path=str(final_video_path)
        )

        if not final_video_path.exists():
            raise FileNotFoundError(f"expected output file from final video build missing: {final_video_path}")
        
        # upload final video to gcs with the original filename 
        final_video_blob = f"outputs/{job_id}/{video_name}.mp4"
        final_video_link = upload_file_to_gcs(
            local_path=str(final_video_path),
            bucket_name=GCS_BUCKET,
            destination_blob_name=final_video_blob
        )

        output_dict["gcs_links"]["video"] = final_video_link

    # upload final subtitle files
    srt_blob, vtt_blob = f"outputs/{job_id}/vocals.srt", f"outputs/{job_id}/vocals.vtt"

    srt_link = upload_file_to_gcs(
        local_path=str(srt_output_path),
        bucket_name=GCS_BUCKET,
        destination_blob_name=srt_blob
    )

    vtt_link = upload_file_to_gcs(
        local_path=str(vtt_path),
        bucket_name=GCS_BUCKET,
        destination_blob_name=vtt_blob
    )

    output_dict["gcs_links"]["srt"] = srt_link
    output_dict["gcs_links"]["vtt"] = vtt_link

    # remove the original input file from gcs to save space
    remove_file_from_gcs(
        bucket_name=GCS_BUCKET,
        blob_name=input_blob_name
    )
    
    result ={
        "status": "full inference done",
        "job_id": job_id,
        "video_url": (
            f"https://storage.googleapis.com/{GCS_BUCKET}/{final_video_blob}"
            if final_video_blob is not None
            else None
        ),
        "subtitle_url": f"https://storage.googleapis.com/{GCS_BUCKET}/{vtt_blob}",
        "vtt_url": f"https://storage.googleapis.com/{GCS_BUCKET}/{vtt_blob}",
        "srt_url": f"https://storage.googleapis.com/{GCS_BUCKET}/{srt_blob}",
    }

    result_path = output_dir / "result.json"

    with open(result_path, "w") as f:
        import json 
        json.dump(result, f)
    
    upload_file_to_gcs(
        local_path=str(result_path),
        bucket_name=GCS_BUCKET,
        destination_blob_name=f"outputs/{job_id}/result.json"
    )

    return result

if __name__ == "__main__":
    result = run_inference_job()
    print(result, flush=True)