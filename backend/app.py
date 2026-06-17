from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from google.cloud import storage

import json
import os
import re
import shutil
import uuid
import warnings
from typing import List, Optional, Tuple, Dict, Union
from pathlib import Path
from urllib.parse import quote

from backend.scripts.ffmpeg import (
    split_sources,
    build_video,
    convert_srt_to_vtt,
    render_video_with_ass_subtitles,
)
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


class EditorSubtitleCue(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(gt=0)
    text: str = Field(min_length=1, max_length=10000)


class EditorSubtitleTransform(BaseModel):
    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)
    width: float = Field(ge=5, le=120)
    height: float = Field(ge=5, le=100)
    rotation: float = Field(ge=-180, le=180)


class SaveEditorProjectRequest(BaseModel):
    source_blob_name: str
    title: str = Field(min_length=1, max_length=180)
    cues: List[EditorSubtitleCue]
    subtitle_font_size: int = Field(ge=12, le=72)
    subtitle_transform: EditorSubtitleTransform
    karaoke_enabled: bool = True
    karaoke_highlight_color: str = "#f4a6c1"


class RenameProjectRequest(BaseModel):
    source_blob_name: str
    title: str = Field(min_length=1, max_length=180)


def _public_gcs_url(blob_name: str) -> str:
    encoded_name = "/".join(quote(part, safe="") for part in blob_name.split("/"))
    return f"https://storage.googleapis.com/{GCS_BUCKET}/{encoded_name}"


def _validated_project_video_blob_name(blob_name: str) -> str:
    clean_blob_name = blob_name.strip()
    if (
        not re.fullmatch(r"outputs/[^/]+/.+\.mp4", clean_blob_name, re.IGNORECASE)
        or ".." in Path(clean_blob_name).parts
    ):
        raise HTTPException(status_code=400, detail="Invalid project video object.")
    return clean_blob_name


def _clean_project_title(title: str) -> str:
    clean_title = re.sub(r"[/\\\x00-\x1f]+", "-", title).strip(" .")
    clean_title = re.sub(r"\.mp4$", "", clean_title, flags=re.IGNORECASE).strip()
    if not clean_title:
        raise HTTPException(status_code=400, detail="Project title is invalid.")
    return clean_title


def _validated_job_id(job_id: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", job_id):
        raise HTTPException(status_code=400, detail="Invalid project job ID.")
    return job_id


def _format_ass_timestamp(seconds: float) -> str:
    centiseconds = max(0, round(seconds * 100))
    hours, remainder = divmod(centiseconds, 360000)
    minutes, remainder = divmod(remainder, 6000)
    whole_seconds, fraction = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{fraction:02d}"


def _format_vtt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3600000)
    minutes, remainder = divmod(remainder, 60000)
    whole_seconds, fraction = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d}.{fraction:03d}"


def _escape_ass_text(text: str) -> str:
    return (
        text.replace("\\", r"\\")
        .replace("{", r"\{")
        .replace("}", r"\}")
        .replace("\r", "")
        .replace("\n", r"\N")
    )


def _ass_color_from_hex(hex_color: str) -> str:
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", hex_color):
        raise HTTPException(
            status_code=400,
            detail="Karaoke highlight color must be a #RRGGBB hex color.",
        )
    clean = hex_color.lstrip("#")
    red = clean[0:2]
    green = clean[2:4]
    blue = clean[4:6]
    return f"&H00{blue}{green}{red}".upper()


def _karaoke_token_weight(text: str) -> float:
    weight = 0.0
    for character in text.strip():
        if character.isspace():
            continue
        weight += 0.25 if re.fullmatch(r"[\W_]", character, re.UNICODE) else 1.0
    return max(0.25, weight)


def _karaoke_line_segments(text: str) -> List[Tuple[str, float]]:
    if not text:
        return []
    if re.search(r"\s", text.strip()):
        return [
            (token, _karaoke_token_weight(token))
            for token in re.findall(r"\S+\s*", text)
        ]
    return [(character, _karaoke_token_weight(character)) for character in text]


def _escape_ass_karaoke_segment(text: str) -> str:
    return (
        text.replace("\\", r"\\")
        .replace("{", r"\{")
        .replace("}", r"\}")
        .replace("\r", "")
    )


def _format_karaoke_ass_text(text: str, duration: float) -> str:
    segments = _karaoke_line_segments(text)
    total_weight = sum(weight for _, weight in segments) or 1.0
    remaining_centiseconds = max(1, round(duration * 100))
    remaining_weight = total_weight
    ass_parts: List[str] = []
    for token, weight in segments:
        if remaining_weight <= 0:
            centiseconds = 1
        else:
            centiseconds = max(
                1,
                round(remaining_centiseconds * (weight / remaining_weight)),
            )
        remaining_centiseconds = max(0, remaining_centiseconds - centiseconds)
        remaining_weight -= weight
        ass_parts.append(rf"{{\kf{centiseconds}}}{_escape_ass_karaoke_segment(token)}")
    return "".join(ass_parts)


def _write_editor_subtitles(
    request: SaveEditorProjectRequest,
    ass_path: Path,
    vtt_path: Path,
) -> None:
    transform = request.subtitle_transform
    margin = round((100 - transform.width) / 200 * 1920)
    position_x = round(transform.x / 100 * 1920)
    position_y = round(transform.y / 100 * 1080)
    primary_color = (
        _ass_color_from_hex(request.karaoke_highlight_color)
        if request.karaoke_enabled
        else "&H00FFFFFF"
    )
    secondary_color = "&H00FFFFFF" if request.karaoke_enabled else "&H000000FF"
    ass_lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        "PlayResX: 1920",
        "PlayResY: 1080",
        "WrapStyle: 2",
        "",
        "[V4+ Styles]",
        (
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
            "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
            "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
            "Alignment, MarginL, MarginR, MarginV, Encoding"
        ),
        (
            f"Style: Default,Arial,{request.subtitle_font_size},{primary_color},"
            f"{secondary_color},&H00101A24,&H80000000,-1,0,0,0,100,100,0,0,1,2,1,"
            f"5,{margin},{margin},0,1"
        ),
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    vtt_lines = ["WEBVTT", ""]

    for index, cue in enumerate(
        sorted(request.cues, key=lambda item: item.start), start=1
    ):
        if cue.end <= cue.start:
            raise HTTPException(
                status_code=400,
                detail=f"Subtitle cue {index} must end after it starts.",
            )
        if request.karaoke_enabled:
            cue_lines = cue.text.replace("\r", "").split("\n")
            line_height = round(request.subtitle_font_size * 1.25)
            line_count = max(1, len(cue_lines))
            for line_index, line in enumerate(cue_lines):
                if not line:
                    continue
                offset_y = round((line_index - (line_count - 1) / 2) * line_height)
                overrides = (
                    rf"{{\an5\pos({position_x},{position_y + offset_y})"
                    rf"\frz{transform.rotation:.2f}}}"
                )
                ass_lines.append(
                    "Dialogue: 0,"
                    f"{_format_ass_timestamp(cue.start)},"
                    f"{_format_ass_timestamp(cue.end)},"
                    f"Default,,0,0,0,,{overrides}"
                    f"{_format_karaoke_ass_text(line, cue.end - cue.start)}"
                )
        else:
            overrides = (
                rf"{{\an5\pos({position_x},{position_y})"
                rf"\frz{transform.rotation:.2f}}}"
            )
            ass_lines.append(
                "Dialogue: 0,"
                f"{_format_ass_timestamp(cue.start)},"
                f"{_format_ass_timestamp(cue.end)},"
                f"Default,,0,0,0,,{overrides}{_escape_ass_text(cue.text)}"
            )
        vtt_lines.extend(
            [
                str(index),
                (
                    f"{_format_vtt_timestamp(cue.start)} --> "
                    f"{_format_vtt_timestamp(cue.end)}"
                ),
                cue.text,
                "",
            ]
        )

    ass_path.write_text("\n".join(ass_lines) + "\n", encoding="utf-8")
    vtt_path.write_text("\n".join(vtt_lines), encoding="utf-8")


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
    fast_decrowd: bool = Form(False),
    language: Union[str, None] = Form(None),
) -> Dict:
    """
    Create a Kubernetes orchestration Job and return immediately for frontend polling.
    """
    from backend.scripts.orchestration_jobs.status import (
        try_write_inference_job_status,
        write_inference_job_status,
    )

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
            fast_decrowd=fast_decrowd,
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
        try_write_inference_job_status(job_id=job_id, status="failed", error=str(e))
        raise HTTPException(
            status_code=500,
            detail=f"inference orchestration job creation failed: {str(e)}",
        )


@app.post("/projects/save")
def save_editor_project(request: SaveEditorProjectRequest) -> Dict[str, object]:
    """
    Render editor subtitle changes and publish them without deleting the source first.
    """
    source_blob_name = _validated_project_video_blob_name(request.source_blob_name)
    clean_title = _clean_project_title(request.title)

    source_parent = source_blob_name.rsplit("/", 1)[0]
    destination_blob_name = f"{source_parent}/{clean_title}.mp4"
    save_id = uuid.uuid4().hex
    subtitle_blob_name = (
        f"{source_blob_name.split('/')[0]}/{source_blob_name.split('/')[1]}"
        f"/editor/{clean_title}-{save_id}.vtt"
    )
    staging_prefix = (
        f"{source_blob_name.split('/')[0]}/{source_blob_name.split('/')[1]}"
        f"/.editor-staging/{save_id}"
    )
    staging_video_name = f"{staging_prefix}.mp4"
    staging_vtt_name = f"{staging_prefix}.vtt"
    render_source_blob_name = (
        f"{source_blob_name.split('/')[0]}/{source_blob_name.split('/')[1]}"
        "/editor/source.mp4"
    )
    work_dir = Path(f"/tmp/benzaiten-editor-{save_id}")
    source_path = work_dir / "source.mp4"
    ass_path = work_dir / "subtitles.ass"
    vtt_path = work_dir / "subtitles.vtt"
    rendered_path = work_dir / "rendered.mp4"
    client = storage.Client()
    bucket = client.bucket(GCS_BUCKET)
    source_blob = bucket.get_blob(source_blob_name)
    published_vtt = None
    cleanup_warning: Optional[str] = None

    if source_blob is None:
        raise HTTPException(
            status_code=404, detail="The source video no longer exists."
        )
    source_generation = source_blob.generation

    if destination_blob_name != source_blob_name and bucket.get_blob(
        destination_blob_name
    ):
        raise HTTPException(
            status_code=409,
            detail="A video with that project title already exists.",
        )

    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        render_source_blob = bucket.get_blob(render_source_blob_name)
        if render_source_blob is None:
            try:
                render_source_blob = bucket.copy_blob(
                    source_blob,
                    bucket,
                    render_source_blob_name,
                    source_generation=source_generation,
                    if_generation_match=0,
                    if_source_generation_match=source_generation,
                )
            except Exception:
                render_source_blob = bucket.get_blob(render_source_blob_name)
                if render_source_blob is None:
                    raise
        render_source_blob.reload()
        render_source_blob.download_to_filename(
            str(source_path),
            if_generation_match=render_source_blob.generation,
        )
        _write_editor_subtitles(request, ass_path, vtt_path)
        render_video_with_ass_subtitles(
            video_path=str(source_path),
            ass_path=str(ass_path),
            output_path=str(rendered_path),
        )
        if not rendered_path.exists() or rendered_path.stat().st_size == 0:
            raise RuntimeError("The rendered video is empty.")

        staging_video = bucket.blob(staging_video_name)
        staging_video.upload_from_filename(str(rendered_path), content_type="video/mp4")
        staging_video.reload()
        if staging_video.size != rendered_path.stat().st_size:
            raise RuntimeError("The staged video failed size verification.")

        staging_vtt = bucket.blob(staging_vtt_name)
        staging_vtt.upload_from_filename(str(vtt_path), content_type="text/vtt")
        staging_vtt.reload()
        if staging_vtt.size != vtt_path.stat().st_size:
            raise RuntimeError("The staged subtitle file failed size verification.")

        published_vtt = bucket.copy_blob(
            staging_vtt,
            bucket,
            subtitle_blob_name,
            if_generation_match=0,
        )
        published_vtt.reload()

        destination_generation_match = (
            source_generation if destination_blob_name == source_blob_name else 0
        )
        published_video = bucket.copy_blob(
            staging_video,
            bucket,
            destination_blob_name,
            if_generation_match=destination_generation_match,
        )
        published_video.reload()
        if published_video.size != staging_video.size:
            raise RuntimeError("The published video failed size verification.")

        if destination_blob_name != source_blob_name:
            try:
                source_blob.delete(if_generation_match=source_generation)
            except Exception as error:
                cleanup_warning = (
                    "The edited video was saved, but the previous video could not be "
                    f"removed safely: {error}"
                )

        return {
            "status": "saved",
            "title": clean_title,
            "media_object_name": destination_blob_name,
            "media_url": _public_gcs_url(destination_blob_name),
            "render_source_object_name": render_source_blob_name,
            "render_source_url": _public_gcs_url(render_source_blob_name),
            "subtitle_object_name": subtitle_blob_name,
            "subtitle_url": _public_gcs_url(subtitle_blob_name),
            "generation": published_video.generation,
            "cleanup_warning": cleanup_warning,
        }
    except HTTPException:
        raise
    except Exception as error:
        if published_vtt is not None:
            try:
                published_vtt.delete()
            except Exception:
                pass
        raise HTTPException(
            status_code=500,
            detail=f"edited video save failed before replacing the original: {error}",
        )
    finally:
        for blob_name in (staging_video_name, staging_vtt_name):
            try:
                bucket.blob(blob_name).delete()
            except Exception:
                pass
        shutil.rmtree(work_dir, ignore_errors=True)


@app.get("/projects/download")
def download_project(source_blob_name: str) -> StreamingResponse:
    source_blob_name = _validated_project_video_blob_name(source_blob_name)
    bucket = storage.Client().bucket(GCS_BUCKET)
    source_blob = bucket.get_blob(source_blob_name)
    if source_blob is None:
        raise HTTPException(
            status_code=404, detail="The project video no longer exists."
        )

    source_blob.reload()
    generation = source_blob.generation
    filename = source_blob_name.rsplit("/", 1)[-1]

    def stream_video():
        with source_blob.open("rb", if_generation_match=generation) as source:
            while chunk := source.read(1024 * 1024):
                yield chunk

    return StreamingResponse(
        stream_video(),
        media_type=source_blob.content_type or "video/mp4",
        headers={
            "Content-Disposition": (
                f"attachment; filename*=UTF-8''{quote(filename, safe='')}"
            ),
            "Content-Length": str(source_blob.size),
        },
    )


@app.post("/projects/rename")
def rename_project(request: RenameProjectRequest) -> Dict[str, object]:
    source_blob_name = _validated_project_video_blob_name(request.source_blob_name)
    clean_title = _clean_project_title(request.title)
    source_parent = source_blob_name.rsplit("/", 1)[0]
    destination_blob_name = f"{source_parent}/{clean_title}.mp4"
    bucket = storage.Client().bucket(GCS_BUCKET)
    source_blob = bucket.get_blob(source_blob_name)

    if source_blob is None:
        raise HTTPException(
            status_code=404, detail="The project video no longer exists."
        )
    source_blob.reload()
    source_generation = source_blob.generation

    if destination_blob_name == source_blob_name:
        return {
            "status": "renamed",
            "title": clean_title,
            "media_object_name": source_blob_name,
            "media_url": _public_gcs_url(source_blob_name),
        }
    if bucket.get_blob(destination_blob_name) is not None:
        raise HTTPException(
            status_code=409,
            detail="A video with that project title already exists.",
        )

    try:
        renamed_blob = bucket.copy_blob(
            source_blob,
            bucket,
            destination_blob_name,
            source_generation=source_generation,
            if_generation_match=0,
            if_source_generation_match=source_generation,
        )
        renamed_blob.reload()
        if renamed_blob.size != source_blob.size:
            renamed_blob.delete(if_generation_match=renamed_blob.generation)
            raise RuntimeError("The renamed video failed size verification.")
        try:
            source_blob.delete(if_generation_match=source_generation)
        except Exception as error:
            renamed_blob.delete(if_generation_match=renamed_blob.generation)
            raise RuntimeError(
                "The original video changed before rename could complete."
            ) from error
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(status_code=500, detail=f"project rename failed: {error}")

    return {
        "status": "renamed",
        "title": clean_title,
        "media_object_name": destination_blob_name,
        "media_url": _public_gcs_url(destination_blob_name),
    }


@app.delete("/projects/{job_id}")
def delete_project(job_id: str) -> Dict[str, object]:
    job_id = _validated_job_id(job_id)
    prefix = f"outputs/{job_id}/"
    bucket = storage.Client().bucket(GCS_BUCKET)
    blobs_by_name = {blob.name: blob for blob in bucket.list_blobs(prefix=prefix)}

    for marker_name in (prefix, prefix.rstrip("/")):
        marker_blob = bucket.get_blob(marker_name)
        if marker_blob is not None:
            blobs_by_name[marker_blob.name] = marker_blob

    blobs = list(blobs_by_name.values())
    if not blobs:
        raise HTTPException(status_code=404, detail="The project no longer exists.")

    deleted_objects = 0
    try:
        for blob in blobs:
            blob.delete(if_generation_match=blob.generation)
            deleted_objects += 1
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=(
                f"project deletion stopped after {deleted_objects} objects: {error}"
            ),
        )

    remaining_names = {blob.name for blob in bucket.list_blobs(prefix=prefix)}
    for marker_name in (prefix, prefix.rstrip("/")):
        if bucket.get_blob(marker_name) is not None:
            remaining_names.add(marker_name)
    if remaining_names:
        raise HTTPException(
            status_code=500,
            detail=(
                "project deletion did not fully clear the GCS prefix; remaining objects: "
                + ", ".join(sorted(remaining_names))
            ),
        )

    return {
        "status": "deleted",
        "job_id": job_id,
        "deleted_objects": deleted_objects,
        "deleted_prefix": prefix,
    }


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
            or not (result.get("video_url") or result.get("audio_url"))
            or not result.get("subtitle_url")
        ):
            return None

        response = {
            "job_id": job_id,
            "status": "completed",
            "subtitle_url": result["subtitle_url"],
        }
        if result.get("video_url"):
            response["video_url"] = result["video_url"]
        if result.get("audio_url"):
            response["audio_url"] = result["audio_url"]

        return response

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
        "https://kseto06.github.io",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# testing
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
