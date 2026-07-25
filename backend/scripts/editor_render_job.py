import json
import os
import shutil
import time
import traceback
from pathlib import Path
from typing import Any, Dict

from google.cloud import storage

from backend.app import (
    EDITOR_REFERENCE_HEIGHT,
    EDITOR_REFERENCE_WIDTH,
    SaveEditorProjectRequest,
    _prepare_editor_font_dir,
    _write_editor_subtitles,
)
from backend.scripts.browser_subtitle_renderer import (
    BrowserSubtitleRendererUnavailable,
    render_video_with_browser_subtitles,
)
from backend.scripts.ffmpeg import render_video_with_ass_subtitles


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _write_status(
    bucket: storage.Bucket,
    status_blob_name: str,
    payload: Dict[str, Any],
) -> None:
    bucket.blob(status_blob_name).upload_from_string(
        json.dumps(payload, ensure_ascii=False, sort_keys=True),
        content_type="application/json",
    )


def run_editor_render_job() -> Dict[str, Any]:
    """
    Function to run the editor render job, which processes a video with subtitles
    and uploads the results to GCS

    Returns:
        Dict[str, Any]: a dict containing status of the job, job_id, render_id,
        sizes of rendered video and vtt file, and blob names for staging video and vtt
    """
    job_id = _required_env("JOB_ID")
    render_id = _required_env("RENDER_ID")
    bucket_name = _required_env("GCS_BUCKET")
    request_blob_name = _required_env("RENDER_REQUEST_BLOB_NAME")
    status_blob_name = _required_env("RENDER_STATUS_BLOB_NAME")
    render_source_blob_name = _required_env("RENDER_SOURCE_BLOB_NAME")
    render_source_generation = int(_required_env("RENDER_SOURCE_GENERATION"))
    staging_video_blob_name = _required_env("STAGING_VIDEO_BLOB_NAME")
    staging_vtt_blob_name = _required_env("STAGING_VTT_BLOB_NAME")

    work_dir = Path(f"/tmp/benzaiten-editor-render-{render_id}")
    source_path = work_dir / "source.mp4"
    ass_path = work_dir / "subtitles.ass"
    vtt_path = work_dir / "subtitles.vtt"
    rendered_path = work_dir / "rendered.mp4"

    client = storage.Client()
    bucket = client.bucket(bucket_name)
    work_dir.mkdir(parents=True, exist_ok=True)
    render_started_at = time.monotonic()

    try:
        _write_status(
            bucket,
            status_blob_name,
            {
                "status": "running",
                "job_id": job_id,
                "render_id": render_id,
            },
        )

        request_blob = bucket.get_blob(request_blob_name)
        if request_blob is None:
            raise RuntimeError(f"Render request blob is missing: {request_blob_name}")
        request_payload = json.loads(request_blob.download_as_text(encoding="utf-8"))
        request = SaveEditorProjectRequest.model_validate(request_payload)

        render_source_blob = bucket.get_blob(render_source_blob_name)
        if render_source_blob is None:
            raise RuntimeError(
                f"Render source blob is missing: {render_source_blob_name}"
            )
        render_source_blob.download_to_filename(
            str(source_path),
            if_generation_match=render_source_generation,
        )

        render_font_dir = _prepare_editor_font_dir(work_dir)
        _write_editor_subtitles(request, ass_path, vtt_path)
        try:
            render_video_with_browser_subtitles(
                video_path=str(source_path),
                output_path=str(rendered_path),
                cues=[
                    {
                        "start": cue.start,
                        "end": cue.end,
                        "text": cue.text,
                    }
                    for cue in request.cues
                ],
                subtitle_font_size=request.subtitle_font_size,
                subtitle_transform=request.subtitle_transform.model_dump(),
                karaoke_enabled=request.karaoke_enabled,
                karaoke_highlight_color=request.karaoke_highlight_color,
                fonts_dir=str(render_font_dir),
                process_id=render_id,
                reference_width=EDITOR_REFERENCE_WIDTH,
                reference_height=EDITOR_REFERENCE_HEIGHT,
                pitch_semitones=request.pitch_semitones,
            )
        except BrowserSubtitleRendererUnavailable:
            render_video_with_ass_subtitles(
                video_path=str(source_path),
                ass_path=str(ass_path),
                output_path=str(rendered_path),
                fonts_dir=str(render_font_dir),
                process_id=render_id,
                pitch_semitones=request.pitch_semitones,
            )
        except Exception as error:
            if "cancelled" in str(error).lower():
                raise
            render_video_with_ass_subtitles(
                video_path=str(source_path),
                ass_path=str(ass_path),
                output_path=str(rendered_path),
                fonts_dir=str(render_font_dir),
                process_id=render_id,
                pitch_semitones=request.pitch_semitones,
            )

        if not rendered_path.exists() or rendered_path.stat().st_size == 0:
            raise RuntimeError("The rendered video is empty.")

        staging_video = bucket.blob(staging_video_blob_name)
        staging_video.upload_from_filename(str(rendered_path), content_type="video/mp4")
        staging_vtt = bucket.blob(staging_vtt_blob_name)
        staging_vtt.upload_from_filename(str(vtt_path), content_type="text/vtt")

        result = {
            "status": "completed",
            "job_id": job_id,
            "render_id": render_id,
            "rendered_size": rendered_path.stat().st_size,
            "vtt_size": vtt_path.stat().st_size,
            "staging_video_blob_name": staging_video_blob_name,
            "staging_vtt_blob_name": staging_vtt_blob_name,
            "pitch_semitones": request.pitch_semitones,
            "render_seconds": round(time.monotonic() - render_started_at, 3),
        }
        _write_status(bucket, status_blob_name, result)
        return result
    except Exception as error:
        _write_status(
            bucket,
            status_blob_name,
            {
                "status": "failed",
                "job_id": job_id,
                "render_id": render_id,
                "error": str(error),
                "traceback": traceback.format_exc(),
            },
        )
        raise
    finally:
        shutil.rmtree(work_dir, ignore_errors=True)


if __name__ == "__main__":
    print(json.dumps(run_editor_render_job(), ensure_ascii=False, sort_keys=True))
