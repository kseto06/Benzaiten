"""
This is the script for deploying a k8s inference job defined in the fastapi app

It's simply reproducing the v1 deployment pipeline in run_full_inference, but instead of running the pipeline with the pod always open
in the cluster (which wastes resources), we deploy it on a k8s job which runs the full pipeline and then terminates once inference is complete.
"""

import os
import json
import warnings
from pathlib import Path
from typing import Optional, Dict

from backend.gcp_utils.gcs_bucket import (
    download_file_from_gcs,
    upload_file_to_gcs,
    remove_file_from_gcs,
    clean_gcs_bucket,
)
from backend.scripts.ffmpeg import (
    split_sources,
    build_video,
    convert_srt_to_vtt,
    get_media_duration,
    extract_audio_segment,
    concatenate_audio_files,
)
from backend.scripts.process import run_karaoke_inference
from backend.language_models.transcribe import run_srt_inference

GCS_BUCKET = os.environ.get("GCS_BUCKET", "benzaiten-outputs")


def _stage_blob(job_id: str, stage: str, filename: str) -> str:
    return f"outputs/{job_id}/{filename}"


def run_inference_job() -> Dict:
    """
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
    """
    # emit deprecation warning
    warnings.warn(
        "run_inference_job is deprecated: use the orchestration pipeline jobs",
        DeprecationWarning,
    )

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
            local_path=str(input_path),
        )
    )

    # prepare for bs-roformer (instrumental/vocal) source separation
    is_video = content_type is not None and content_type.startswith("video/")
    model_name = "bs-roformer"
    video_path: Optional[Path] = None

    try:
        if is_video:
            video_path, audio_path = split_sources(
                video_path=str(local_input_path), output_dir=str(input_dir)
            )
            inference_input_path = str(audio_path)
        else:
            inference_input_path = str(local_input_path)

        run_karaoke_inference(
            model_name=model_name,
            audio_path=inference_input_path,
            output_path=str(output_dir),
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
        "gcs_links": {},
    }

    # decrowding pipeline (if selected)
    if should_decrowd:
        model_name = "decrowd"
        decrowd_input_path = instrumental_path

        if not decrowd_input_path.exists():
            raise FileNotFoundError(
                f"expected input file (from bs-roformer inference) for decrowding missing: {decrowd_input_path}"
            )

        run_karaoke_inference(
            model_name=model_name,
            audio_path=str(decrowd_input_path),
            output_path=str(output_dir),
        )

        decrowd_instrumental_path = output_dir / "instrumental_(decrowd).mp3"

        if not decrowd_instrumental_path.exists():
            raise FileNotFoundError(
                f"expected output file from decrowding missing: {decrowd_instrumental_path}"
            )

        output_dict["model"] = "bs-roformer+decrowd"
        output_dict["crowd"] = "crowd.mp3"
        output_dict["instrumental_(decrowd)"] = "instrumental_(decrowd).mp3"

        final_audio_path = decrowd_instrumental_path

    else:
        final_audio_path = instrumental_path

    # transcription/translation pipeline
    srt_output_path = run_srt_inference(
        audio_path=str(vocals_path), output_path=str(output_dir), language=language
    )

    srt_output_path = Path(srt_output_path)

    if not srt_output_path.exists():
        raise FileNotFoundError(
            f"expected output file from transcription missing: {srt_output_path}"
        )

    output_dict["srt"] = srt_output_path.name

    # srt -> vtt conversion
    vtt_path = output_dir / "vocals.vtt"
    convert_srt_to_vtt(srt_path=str(srt_output_path), vtt_path=str(vtt_path))
    if not vtt_path.exists():
        raise FileNotFoundError(
            f"expected output file from srt to vtt conversion missing: {vtt_path}"
        )

    # building the final video
    final_video_path, final_video_blob = None, None

    if is_video and video_path is not None:
        output_dict["video"] = Path(video_path).name
        final_video_path = output_dir / "final_video.mp4"

        build_video(
            video_path=str(video_path),
            audio_path=str(final_audio_path),
            srt_path=str(srt_output_path),
            output_path=str(final_video_path),
        )

        if not final_video_path.exists():
            raise FileNotFoundError(
                f"expected output file from final video build missing: {final_video_path}"
            )

        # upload final video to gcs with the original filename
        final_video_blob = f"outputs/{job_id}/{video_name}.mp4"
        final_video_link = upload_file_to_gcs(
            local_path=str(final_video_path),
            bucket_name=GCS_BUCKET,
            destination_blob_name=final_video_blob,
        )

        output_dict["gcs_links"]["video"] = final_video_link

    # upload final subtitle files
    srt_blob, vtt_blob = f"outputs/{job_id}/vocals.srt", f"outputs/{job_id}/vocals.vtt"

    srt_link = upload_file_to_gcs(
        local_path=str(srt_output_path),
        bucket_name=GCS_BUCKET,
        destination_blob_name=srt_blob,
    )

    vtt_link = upload_file_to_gcs(
        local_path=str(vtt_path), bucket_name=GCS_BUCKET, destination_blob_name=vtt_blob
    )

    output_dict["gcs_links"]["srt"] = srt_link
    output_dict["gcs_links"]["vtt"] = vtt_link

    # remove the original input file from gcs to save space
    remove_file_from_gcs(bucket_name=GCS_BUCKET, blob_name=input_blob_name)

    result = {
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
        json.dump(result, f)

    upload_file_to_gcs(
        local_path=str(result_path),
        bucket_name=GCS_BUCKET,
        destination_blob_name=f"outputs/{job_id}/result.json",
    )

    return result


# ----------------------------------
# Split pipeline orchestration integration for jobs


def run_source_separation_job() -> Dict:
    """
    Function to run the source separation job, which will be the first job in the split pipeline orchestration.
    This will run the bs-roformer model to do vocal/instrumental separation, and then upload the separated vocals and instrumentals to GCS

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job
        input_blob_name: The blob name of the input file in GCS.
        filename: The original filename of the input file.
        content_type: The content type of the input file (e.g. "video/mp4
    Returns:
        dict containing job_id, status message, and GCS links to the separated sources
    """
    # get job configs from the env vars
    job_id = os.environ["JOB_ID"]
    input_blob_name = os.environ["INPUT_BLOB_NAME"]
    filename = os.environ["FILENAME"]
    content_type = os.environ.get("CONTENT_TYPE", "video/mp4")

    # created the tmp input and output dirs for storing local videos as the pipeline runs
    input_dir = Path(f"/tmp/{job_id}")
    input_dir.mkdir(parents=True, exist_ok=True)

    output_dir = Path(f"/tmp/outputs/{job_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    input_path = input_dir / filename

    # retreive input file from GCS (new for k8s job pipeline)
    local_input_path = Path(
        download_file_from_gcs(
            bucket_name=GCS_BUCKET,
            source_blob_name=input_blob_name,
            local_path=str(input_path),
        )
    )

    # prepare for bs-roformer (instrumental/vocal) source separation
    is_video = content_type is not None and content_type.startswith("video/")
    model_name = "bs-roformer"
    video_path: Optional[Path] = None

    try:
        if is_video:
            video_path, audio_path = split_sources(
                video_path=str(local_input_path), output_dir=str(input_dir)
            )
            inference_input_path = str(audio_path)
        else:
            inference_input_path = str(local_input_path)

        run_karaoke_inference(
            model_name=model_name,
            audio_path=inference_input_path,
            output_path=str(output_dir),
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
        "gcs_links": {},
    }

    # upload separated sources to gcs
    vocals_blob = os.environ.get(
        "OUTPUT_VOCALS_BLOB_NAME",
        _stage_blob(job_id, "source_separation", "vocals.mp3"),
    )
    instrumental_blob = os.environ.get(
        "OUTPUT_INSTRUMENTAL_BLOB_NAME",
        _stage_blob(job_id, "source_separation", "instrumental.mp3"),
    )

    vocals_link = upload_file_to_gcs(
        local_path=str(vocals_path),
        bucket_name=GCS_BUCKET,
        destination_blob_name=vocals_blob,
    )

    instrumental_link = upload_file_to_gcs(
        local_path=str(instrumental_path),
        bucket_name=GCS_BUCKET,
        destination_blob_name=instrumental_blob,
    )

    output_dict["gcs_links"]["vocals"] = vocals_link
    output_dict["gcs_links"]["instrumental"] = instrumental_link

    if is_video and video_path is not None:
        input_video_blob = os.environ.get(
            "OUTPUT_VIDEO_BLOB_NAME",
            _stage_blob(job_id, "source_separation", "input_video.mp4"),
        )
        video_link = upload_file_to_gcs(
            local_path=str(video_path),
            bucket_name=GCS_BUCKET,
            destination_blob_name=input_video_blob,
        )
        output_dict["gcs_links"]["input_video"] = video_link

    return output_dict


def write_json_to_gcs_blob(job_id: str, final_audio_path: Path) -> str:
    """
    Helper function to write the final audio path (after source separation and optional decrowding) to a JSON blob in GCS,
    which can be read by the transcription job in the split pipeline orchestration integration

    Args:
        job_id: Unique identifier for the job, used as part of the K8s job
        final_audio_path: the local path to the final audio file (either instrumental or decrowded instrumental depending on user selections)
                          that will be fed into the transcription pipeline in the next job

    Returns:
        the public url to the JSON blob in GCS containing the final audio path
    """
    # upload the final audio file to GCS so downstream jobs can access it
    audio_blob = f"outputs/{job_id}/{Path(final_audio_path).name}"
    audio_public_url = upload_file_to_gcs(
        local_path=str(final_audio_path),
        bucket_name=GCS_BUCKET,
        destination_blob_name=audio_blob,
    )

    # write a JSON file that contains the GCS blob name and public URL
    final_audio_json_content = {
        "audio_blob": audio_blob,
        "final_audio_gcs": audio_public_url,
    }

    final_audio_blob = f"outputs/{job_id}/final_audio_path.json"
    tmp_json_path = f"/tmp/{job_id}/final_audio_path.json"
    Path(f"/tmp/{job_id}").mkdir(parents=True, exist_ok=True)

    with open(tmp_json_path, "w") as f:
        json.dump(final_audio_json_content, f)

    public_url = upload_file_to_gcs(
        local_path=tmp_json_path,
        bucket_name=GCS_BUCKET,
        destination_blob_name=final_audio_blob,
    )

    return public_url


FAST_DECROWD_SEGMENT_SECONDS = 30.0


def run_fast_decrowd_inference(
    decrowd_input_path: Path,
    output_dir: Path,
) -> Path:
    duration = get_media_duration(str(decrowd_input_path))
    full_output_path = output_dir / "instrumental_(decrowd).mp3"

    if duration <= FAST_DECROWD_SEGMENT_SECONDS * 2:
        run_karaoke_inference(
            model_name="decrowd",
            audio_path=str(decrowd_input_path),
            output_path=str(output_dir),
        )
        return full_output_path

    work_dir = output_dir / "fast_decrowd"
    inference_output_dir = work_dir / "inference"
    work_dir.mkdir(parents=True, exist_ok=True)
    inference_output_dir.mkdir(parents=True, exist_ok=True)

    first_input = extract_audio_segment(
        str(decrowd_input_path),
        str(work_dir / "first_30_seconds.mp3"),
        start_seconds=0,
        duration_seconds=FAST_DECROWD_SEGMENT_SECONDS,
    )
    last_input = extract_audio_segment(
        str(decrowd_input_path),
        str(work_dir / "last_30_seconds.mp3"),
        start_seconds=duration - FAST_DECROWD_SEGMENT_SECONDS,
        duration_seconds=FAST_DECROWD_SEGMENT_SECONDS,
    )
    fast_input = concatenate_audio_files(
        [str(first_input), str(last_input)],
        str(work_dir / "fast_decrowd_input.mp3"),
    )

    run_karaoke_inference(
        model_name="decrowd",
        audio_path=str(fast_input),
        output_path=str(inference_output_dir),
    )

    fast_output = inference_output_dir / "instrumental_(decrowd).mp3"
    if not fast_output.exists():
        raise FileNotFoundError(f"expected fast decrowd output missing: {fast_output}")

    first_output = extract_audio_segment(
        str(fast_output),
        str(work_dir / "first_30_seconds_decrowd.mp3"),
        start_seconds=0,
        duration_seconds=FAST_DECROWD_SEGMENT_SECONDS,
    )
    last_output = extract_audio_segment(
        str(fast_output),
        str(work_dir / "last_30_seconds_decrowd.mp3"),
        start_seconds=FAST_DECROWD_SEGMENT_SECONDS,
        duration_seconds=FAST_DECROWD_SEGMENT_SECONDS,
    )
    middle_input = extract_audio_segment(
        str(decrowd_input_path),
        str(work_dir / "middle_original.mp3"),
        start_seconds=FAST_DECROWD_SEGMENT_SECONDS,
        duration_seconds=duration - (FAST_DECROWD_SEGMENT_SECONDS * 2),
    )

    concatenate_audio_files(
        [str(first_output), str(middle_input), str(last_output)],
        str(full_output_path),
    )
    return full_output_path


def run_decrowding_job():
    """
    This function runs the decrowding job of the orchestration pipeline which is optional depending on user configurations
    Takes in separated instrumental audio from the source separation job and runs decrowding to separate crowd noise, further cleaning the instrumental audio
    """
    should_decrowd = os.environ.get("SHOULD_DECROWD", "false").lower() == "true"
    fast_decrowd = os.environ.get("FAST_DECROWD", "false").lower() == "true"
    job_id = os.environ["JOB_ID"]

    # decrowding pipeline (if selected)
    if should_decrowd:
        model_name = "decrowd"
        # get decrowding input from the source-separation stage output
        instrumental_blob = os.environ.get(
            "INPUT_AUDIO_BLOB_NAME",
            _stage_blob(job_id, "source_separation", "instrumental.mp3"),
        )
        decrowd_input_path = Path(
            download_file_from_gcs(
                bucket_name=GCS_BUCKET,
                source_blob_name=instrumental_blob,
                local_path=f"/tmp/{job_id}/instrumental.mp3",
            )
        )

        if not decrowd_input_path.exists():
            raise FileNotFoundError(
                f"expected input file (from bs-roformer inference) for decrowding missing: {decrowd_input_path}"
            )

        # construct output dir and run decrowding inference
        output_dir = Path(f"/tmp/outputs/{job_id}")
        output_dir.mkdir(parents=True, exist_ok=True)

        if fast_decrowd:
            decrowd_instrumental_path = run_fast_decrowd_inference(
                decrowd_input_path=decrowd_input_path,
                output_dir=output_dir,
            )
        else:
            run_karaoke_inference(
                model_name=model_name,
                audio_path=str(decrowd_input_path),
                output_path=str(output_dir),
            )
            decrowd_instrumental_path = output_dir / "instrumental_(decrowd).mp3"

        if not decrowd_instrumental_path.exists():
            raise FileNotFoundError(
                f"expected output file from decrowding missing: {decrowd_instrumental_path}"
            )

        # write new decrowded instrumental path to output_dict and GCS
        decrowd_blob = os.environ.get(
            "OUTPUT_AUDIO_BLOB_NAME",
            _stage_blob(job_id, "decrowd", "instrumental_(decrowd).mp3"),
        )
        upload_file_to_gcs(
            local_path=str(decrowd_instrumental_path),
            bucket_name=GCS_BUCKET,
            destination_blob_name=decrowd_blob,
        )

        output_dict = {
            "status": "decrowding done",
            "model": "bs-roformer+decrowd",
            "fast_decrowd": fast_decrowd,
            "crowd": "crowd.mp3",
            "instrumental_(decrowd)": "instrumental_(decrowd).mp3",
            "gcs_links": {
                "instrumental_(decrowd)": f"https://storage.googleapis.com/{GCS_BUCKET}/{decrowd_blob}"
            },
        }

        # write final_audio_path to GCS as JSON blob
        # final_audio_path = decrowd_instrumental_path
        # final_audio_gcs_link = write_json_to_gcs_blob(
        #     job_id=job_id, final_audio_path=final_audio_path
        # )
        # output_dict["gcs_links"]["final_audio_json"] = final_audio_gcs_link

        return output_dict

    else:
        instrumental_blob = os.environ.get(
            "INPUT_AUDIO_BLOB_NAME",
            _stage_blob(job_id, "source_separation", "instrumental.mp3"),
        )
        # instrumental_path = Path(
        #     download_file_from_gcs(
        #         bucket_name=GCS_BUCKET,
        #         source_blob_name=instrumental_blob,
        #         local_path=f"/tmp/{job_id}/instrumental.mp3",
        #     )
        # )
        # final_audio_path = instrumental_path
        # final_audio_gcs_link = write_json_to_gcs_blob(
        #     job_id=job_id, final_audio_path=final_audio_path
        # )

        return {
            "status": "decrowding skipped",
            "model": "bs-roformer",
            "instrumental": "instrumental.mp3",
            "gcs_links": {
                "instrumental": f"https://storage.googleapis.com/{GCS_BUCKET}/{instrumental_blob}",
                # "final_audio_json": final_audio_gcs_link,
            },
        }


def run_transcription_job():
    """
    Function to run the transcription job of the orchestration pipeline, which:
    - takes in the separated vocals and decrowded instrumental (if selected) from the previous jobs
    - runs transcription and translation
    - uploads the generated subtitle files to GCS
    """
    job_id = os.environ["JOB_ID"]
    language: Optional[str] = os.environ.get("LANGUAGE") or None
    gcs_bucket = os.environ.get("GCS_BUCKET", GCS_BUCKET)

    output_dir = Path(f"/tmp/outputs/{job_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    vocals_blob = os.environ.get(
        "INPUT_AUDIO_BLOB_NAME",
        _stage_blob(job_id, "source_separation", "vocals.mp3"),
    )
    vocals_path = Path(
        download_file_from_gcs(
            bucket_name=gcs_bucket,
            source_blob_name=vocals_blob,
            local_path=f"/tmp/{job_id}/vocals.mp3",
        )
    )

    srt_output_path = run_srt_inference(
        audio_path=str(vocals_path), output_path=str(output_dir), language=language
    )

    srt_output_path = Path(srt_output_path)

    if not srt_output_path.exists():
        raise FileNotFoundError(
            f"expected output file from transcription missing: {srt_output_path}"
        )

    output_dict = {
        "status": "transcription done",
        "model": "large-v3-turbo",
        "vocals": "vocals.mp3",
        "gcs_links": {},
    }
    output_dict["srt"] = srt_output_path.name

    # srt -> vtt conversion
    vtt_path = output_dir / "vocals.vtt"
    convert_srt_to_vtt(srt_path=str(srt_output_path), vtt_path=str(vtt_path))
    if not vtt_path.exists():
        raise FileNotFoundError(
            f"expected output file from srt to vtt conversion missing: {vtt_path}"
        )

    srt_blob = os.environ.get(
        "OUTPUT_SRT_BLOB_NAME",
        _stage_blob(job_id, "transcription", "vocals.srt"),
    )
    vtt_blob = os.environ.get(
        "OUTPUT_VTT_BLOB_NAME",
        _stage_blob(job_id, "transcription", "vocals.vtt"),
    )

    srt_link = upload_file_to_gcs(
        local_path=str(srt_output_path),
        bucket_name=gcs_bucket,
        destination_blob_name=srt_blob,
    )

    vtt_link = upload_file_to_gcs(
        local_path=str(vtt_path),
        bucket_name=gcs_bucket,
        destination_blob_name=vtt_blob,
    )

    output_dict["gcs_links"]["srt"] = srt_link
    output_dict["gcs_links"]["vtt"] = vtt_link

    result = {
        "job_id": job_id,
        "status": "transcription done",
        "model": "large-v3-turbo",
        "gcs_links": output_dict["gcs_links"],
    }

    result_path = output_dir / "transcription_result.json"

    with open(result_path, "w") as f:
        json.dump(result, f)

    upload_file_to_gcs(
        local_path=str(result_path),
        bucket_name=gcs_bucket,
        destination_blob_name=f"outputs/{job_id}/result.json",
    )

    return result


def _download_final_audio_blob(
    job_id: str,
    gcs_bucket: str,
    audio_blob: Optional[str],
) -> Path:
    if not audio_blob:
        final_audio_json_blob = f"outputs/{job_id}/final_audio_path.json"
        final_audio_json_local = Path(f"/tmp/{job_id}/final_audio_path.json")
        final_audio_json_local.parent.mkdir(parents=True, exist_ok=True)
        final_audio_json_local = Path(
            download_file_from_gcs(
                bucket_name=gcs_bucket,
                source_blob_name=final_audio_json_blob,
                local_path=str(final_audio_json_local),
            )
        )

        with open(final_audio_json_local, "r") as jf:
            data = json.load(jf)

        audio_blob = data.get("audio_blob")
        if not audio_blob:
            raise RuntimeError("final_audio JSON missing 'audio_blob' field")

    final_audio_local = Path(f"/tmp/{job_id}/{Path(audio_blob).name}")
    return Path(
        download_file_from_gcs(
            bucket_name=gcs_bucket,
            source_blob_name=audio_blob,
            local_path=str(final_audio_local),
        )
    )


def run_build_video_job():
    """
    Function to run the build video job of the orchestration pipeline
    """
    job_id = os.environ["JOB_ID"]
    is_video = os.environ.get("IS_VIDEO", "false").lower() == "true"
    gcs_bucket = os.environ.get("GCS_BUCKET", GCS_BUCKET)

    output_dir = Path(f"/tmp/outputs/{job_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    # building the final playable media
    video_path, final_video_path, final_video_blob = None, None, None
    final_audio_blob = None
    filename = os.environ["FILENAME"]
    video_blob = os.environ.get("VIDEO_BLOB_NAME") or os.environ.get("INPUT_BLOB_NAME")
    audio_blob = os.environ.get("AUDIO_BLOB_NAME")
    srt_blob = os.environ.get(
        "SRT_BLOB_NAME",
        _stage_blob(job_id, "transcription", "vocals.srt"),
    )
    vtt_blob = os.environ.get(
        "VTT_BLOB_NAME",
        _stage_blob(job_id, "transcription", "vocals.vtt"),
    )
    output_video_blob = os.environ.get(
        "OUTPUT_VIDEO_BLOB_NAME",
        _stage_blob(job_id, "final_output", f"{Path(filename).stem}.mp4"),
    )
    output_audio_blob = os.environ.get(
        "OUTPUT_AUDIO_BLOB_NAME",
        _stage_blob(job_id, "final_output", f"{Path(filename).stem}.mp3"),
    )

    # construct the video build output dict
    output_dict = {
        "job_id": job_id,
        "status": "video build done",
        "model": "build video",
        "gcs_links": {},
    }
    output_dir = Path(f"/tmp/outputs/{job_id}")
    output_dir.mkdir(parents=True, exist_ok=True)

    if is_video:
        if not video_blob:
            raise RuntimeError(
                "VIDEO_BLOB_NAME or INPUT_BLOB_NAME must be set for video builds"
            )

        # get the video path from gcs and construct the final video path
        video_path = Path(
            download_file_from_gcs(
                bucket_name=GCS_BUCKET,
                source_blob_name=video_blob,
                local_path=f"/tmp/{job_id}/{filename}",
            )
        )

        output_dict["video"] = Path(video_path).name
        final_video_path = output_dir / Path(output_video_blob).name

        final_audio_local = _download_final_audio_blob(
            job_id=job_id,
            gcs_bucket=gcs_bucket,
            audio_blob=audio_blob,
        )
        srt_output_path = Path(
            download_file_from_gcs(
                bucket_name=gcs_bucket,
                source_blob_name=srt_blob,
                local_path=f"/tmp/{job_id}/vocals.srt",
            )
        )

        build_video(
            video_path=str(video_path),
            audio_path=str(final_audio_local),
            srt_path=str(srt_output_path),
            output_path=str(final_video_path),
        )

        if not final_video_path.exists():
            raise FileNotFoundError(
                f"expected output file from final video build missing: {final_video_path}"
            )

        final_video_blob = output_video_blob
        final_video_link = upload_file_to_gcs(
            local_path=str(final_video_path),
            bucket_name=GCS_BUCKET,
            destination_blob_name=final_video_blob,
        )

        output_dict["gcs_links"]["video"] = final_video_link
    else:
        final_audio_local = _download_final_audio_blob(
            job_id=job_id,
            gcs_bucket=gcs_bucket,
            audio_blob=audio_blob,
        )

        if not final_audio_local.exists():
            raise FileNotFoundError(
                f"expected final audio file missing: {final_audio_local}"
            )

        final_audio_blob = output_audio_blob
        final_audio_link = upload_file_to_gcs(
            local_path=str(final_audio_local),
            bucket_name=gcs_bucket,
            destination_blob_name=final_audio_blob,
        )

        output_dict["gcs_links"]["audio"] = final_audio_link

    output_dict["gcs_links"]["srt"] = f"gs://{gcs_bucket}/{srt_blob}"
    output_dict["gcs_links"]["vtt"] = f"gs://{gcs_bucket}/{vtt_blob}"

    # remove the original input file from gcs to save space
    input_blob_name = os.environ.get("INPUT_BLOB_NAME")
    if input_blob_name:
        remove_file_from_gcs(bucket_name=gcs_bucket, blob_name=input_blob_name)

    result = {
        "status": "full inference done",
        "job_id": job_id,
        "video_url": (
            f"https://storage.googleapis.com/{gcs_bucket}/{final_video_blob}"
            if final_video_blob is not None
            else None
        ),
        "audio_url": (
            f"https://storage.googleapis.com/{gcs_bucket}/{final_audio_blob}"
            if final_audio_blob is not None
            else None
        ),
        "subtitle_url": f"https://storage.googleapis.com/{gcs_bucket}/{vtt_blob}",
        "vtt_url": f"https://storage.googleapis.com/{gcs_bucket}/{vtt_blob}",
        "srt_url": f"https://storage.googleapis.com/{gcs_bucket}/{srt_blob}",
    }

    result_path = output_dir / "result.json"

    with open(result_path, "w") as f:
        json.dump(result, f)

    upload_file_to_gcs(
        local_path=str(result_path),
        bucket_name=gcs_bucket,
        destination_blob_name=f"outputs/{job_id}/result.json",
    )

    # remove all files except for the final video and subtitle files in gcs to save space
    keep_blob_names = [srt_blob, vtt_blob, f"outputs/{job_id}/result.json"]
    if final_video_blob is not None:
        keep_blob_names.append(final_video_blob)
    if final_audio_blob is not None:
        keep_blob_names.append(final_audio_blob)

    clean_gcs_bucket(
        bucket_name=GCS_BUCKET,
        job_id=job_id,
        keep_blob_names=keep_blob_names,
    )

    return result


if __name__ == "__main__":
    result = run_inference_job()
    print(result, flush=True)
