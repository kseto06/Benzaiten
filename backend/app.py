from fastapi import Depends, FastAPI, Header, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from google.cloud import storage
from google.cloud import firestore
import firebase_admin
from firebase_admin import auth as firebase_auth

import json
import os
import re
import shutil
import uuid
import warnings
from datetime import datetime, timezone, timedelta
from typing import Any, List, Optional, Tuple, Dict, Union
from pathlib import Path
from urllib.parse import quote, unquote, urlparse

from backend.scripts.ffmpeg import (
    cancel_ffmpeg_process,
    clear_ffmpeg_process_cancelled,
    split_sources,
    build_video,
    convert_srt_to_vtt,
    extract_audio_from_video,
    is_ffmpeg_process_cancelled,
    render_video_with_ass_subtitles,
)
from backend.scripts.browser_subtitle_renderer import (
    BrowserSubtitleRendererUnavailable,
    render_video_with_browser_subtitles,
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
    create_k8s_editor_render_job,
    delete_k8s_editor_render_jobs,
    wait_for_jobs,
)

app = FastAPI()
GCS_BUCKET = os.environ.get("GCS_BUCKET", "benzaiten-outputs")
FIREBASE_AUTH_PROJECT_ID = os.environ.get(
    "FIREBASE_AUTH_PROJECT_ID",
    os.environ.get("FIREBASE_PROJECT_ID", "benzaiten-fbad8"),
)
FIRESTORE_PROJECT_ID = os.environ.get(
    "FIRESTORE_PROJECT_ID",
    os.environ.get("GOOGLE_CLOUD_PROJECT", "project-0c6e9a84-c914-4d2f-ace"),
)
PROJECT_INDEX_BACKEND = os.environ.get("PROJECT_INDEX_BACKEND", "gcs").lower()
PROJECT_INDEX_PREFIX = os.environ.get("PROJECT_INDEX_PREFIX", "project-index").strip(
    "/"
)
PROJECTS_COLLECTION = os.environ.get("FIRESTORE_PROJECTS_COLLECTION", "projects")
SIGNED_URL_TTL_SECONDS = int(os.environ.get("SIGNED_URL_TTL_SECONDS", "3600"))
IS_LOCAL_DEV = not (
    os.environ.get("KUBERNETES_SERVICE_HOST") or os.environ.get("K_SERVICE")
)
DEFAULT_PUBLIC_GCS_URL_FALLBACK = "true" if IS_LOCAL_DEV else "false"
ALLOW_PUBLIC_GCS_URL_FALLBACK = os.environ.get(
    "ALLOW_PUBLIC_GCS_URL_FALLBACK",
    DEFAULT_PUBLIC_GCS_URL_FALLBACK,
).lower() in {"1", "true", "yes"}
PROJECT_ROOT = Path(__file__).resolve().parents[1]
EDITOR_REFERENCE_WIDTH = 960
EDITOR_REFERENCE_HEIGHT = 540
EDITOR_SUBTITLE_FONT = "DM Sans"
EDITOR_ASS_FONT_SCALE = 1.32
EDITOR_ASS_SCALE_X = 106
EDITOR_ASS_SPACING = 0.35
EDITOR_SUBTITLE_HORIZONTAL_PADDING = 28
EDITOR_SUBTITLE_FONT_DIR = (
    PROJECT_ROOT / "frontend" / "src" / "fonts" / "DM_Sans" / "static"
)
EDITOR_SUBTITLE_FONT_FILES = (
    "DMSans-Regular.ttf",
    "DMSans-Bold.ttf",
)
IMAGE = os.environ.get(
    "IMAGE",
    "northamerica-northeast2-docker.pkg.dev/project-0c6e9a84-c914-4d2f-ace/benzaiten/benzaiten-inference:latest",
)
K8S_NAMESPACE = os.environ.get("K8S_NAMESPACE", "default")
EDITOR_RENDER_USE_K8S = os.environ.get(
    "EDITOR_RENDER_USE_K8S",
    "false" if IS_LOCAL_DEV else "true",
).lower() in {"1", "true", "yes"}
EDITOR_RENDER_JOB_TIMEOUT_SECONDS = int(
    os.environ.get("EDITOR_RENDER_JOB_TIMEOUT_SECONDS", "3600")
)


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
    pitch_semitones: float = Field(default=0, ge=-12, le=12)
    client_render_id: Optional[str] = None


class RenameProjectRequest(BaseModel):
    source_blob_name: str
    title: str = Field(min_length=1, max_length=180)


class AuthenticatedUser(BaseModel):
    uid: str
    email: Optional[str] = None


def _public_gcs_url(blob_name: str) -> str:
    encoded_name = "/".join(quote(part, safe="") for part in blob_name.split("/"))
    return f"https://storage.googleapis.com/{GCS_BUCKET}/{encoded_name}"


def _gcs_object_name_from_url(url_or_name: Optional[str]) -> Optional[str]:
    if not url_or_name:
        return None

    if not re.match(r"^https?://", url_or_name):
        return url_or_name.strip()

    parsed = urlparse(url_or_name)
    path = parsed.path.lstrip("/")
    bucket_prefix = f"{GCS_BUCKET}/"
    if parsed.netloc == "storage.googleapis.com" and path.startswith(bucket_prefix):
        return unquote(path[len(bucket_prefix) :])
    if parsed.netloc == f"{GCS_BUCKET}.storage.googleapis.com":
        return unquote(path)

    return None


def _job_id_from_blob_name(blob_name: str) -> str:
    parts = blob_name.split("/")
    if len(parts) < 2 or parts[0] != "outputs":
        raise HTTPException(status_code=400, detail="Invalid project object.")

    return _validated_job_id(parts[1])


def _firebase_app() -> firebase_admin.App:
    try:
        return firebase_admin.get_app()
    except ValueError:
        options = (
            {"projectId": FIREBASE_AUTH_PROJECT_ID}
            if FIREBASE_AUTH_PROJECT_ID
            else None
        )
        return firebase_admin.initialize_app(options=options)


def _firestore_client() -> firestore.Client:
    if FIRESTORE_PROJECT_ID:
        return firestore.Client(project=FIRESTORE_PROJECT_ID)
    return firestore.Client()


def _project_doc(job_id: str) -> firestore.DocumentReference:
    return _firestore_client().collection(PROJECTS_COLLECTION).document(job_id)


def _use_firestore_project_index() -> bool:
    return PROJECT_INDEX_BACKEND == "firestore"


def _project_timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def _project_index_blob_name(owner_uid: str, job_id: str) -> str:
    owner_segment = quote(owner_uid, safe="")
    job_segment = quote(job_id, safe="")
    return f"{PROJECT_INDEX_PREFIX}/{owner_segment}/{job_segment}.json"


def _project_index_bucket() -> storage.Bucket:
    return storage.Client().bucket(GCS_BUCKET)


def _read_gcs_project_record(
    job_id: str,
    user: AuthenticatedUser,
) -> Dict[str, Any]:
    blob = _project_index_bucket().get_blob(_project_index_blob_name(user.uid, job_id))
    if blob is None:
        raise HTTPException(status_code=404, detail="The project does not exist.")
    try:
        project = json.loads(blob.download_as_text(encoding="utf-8"))
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"The project index record is unreadable: {error}",
        ) from error
    if project.get("owner_uid") != user.uid:
        raise HTTPException(status_code=404, detail="The project does not exist.")
    return project


def _list_gcs_project_records(user: AuthenticatedUser) -> List[Dict[str, Any]]:
    prefix = f"{PROJECT_INDEX_PREFIX}/{quote(user.uid, safe='')}/"
    projects: List[Dict[str, Any]] = []
    for blob in _project_index_bucket().list_blobs(prefix=prefix):
        if not blob.name.endswith(".json"):
            continue
        try:
            project = json.loads(blob.download_as_text(encoding="utf-8"))
        except Exception as error:
            warnings.warn(
                f"skipping unreadable project index record {blob.name}: {error}",
                RuntimeWarning,
            )
            continue
        if project.get("owner_uid") == user.uid:
            projects.append(project)
    return projects


def _upsert_gcs_project_record(job_id: str, values: Dict[str, Any]) -> None:
    owner_uid = values.get("owner_uid")
    if not owner_uid:
        raise RuntimeError("GCS project index writes require owner_uid.")

    bucket = _project_index_bucket()
    blob = bucket.blob(_project_index_blob_name(str(owner_uid), job_id))
    existing: Dict[str, Any] = {}
    existing_blob = bucket.get_blob(blob.name)
    if existing_blob is not None:
        try:
            existing = json.loads(existing_blob.download_as_text(encoding="utf-8"))
        except Exception:
            existing = {}

    now = _project_timestamp()
    record = {
        **existing,
        **values,
        "job_id": job_id,
        "updated_at": now,
    }
    if not record.get("created_at"):
        record["created_at"] = now
    blob.upload_from_string(
        json.dumps(record, ensure_ascii=False, sort_keys=True),
        content_type="application/json",
    )


def _delete_project_record(job_id: str, user: AuthenticatedUser) -> None:
    if _use_firestore_project_index():
        _project_doc(job_id).delete()
        return

    blob = _project_index_bucket().get_blob(_project_index_blob_name(user.uid, job_id))
    if blob is not None:
        blob.delete(if_generation_match=blob.generation)


def get_current_user(
    authorization: Optional[str] = Header(default=None),
) -> AuthenticatedUser:
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="Authentication required.")
    token = authorization.split(" ", 1)[1].strip()
    if not token:
        raise HTTPException(status_code=401, detail="Authentication required.")
    try:
        _firebase_app()
        decoded = firebase_auth.verify_id_token(token)
    except Exception as error:
        raise HTTPException(
            status_code=401, detail=f"Invalid authentication token: {error}"
        ) from error
    uid = decoded.get("uid") or decoded.get("sub")
    if not uid:
        raise HTTPException(status_code=401, detail="Invalid authentication token.")
    return AuthenticatedUser(uid=uid, email=decoded.get("email"))


def _signed_gcs_url(bucket: storage.Bucket, blob_name: str) -> str:
    blob = bucket.blob(blob_name)
    try:
        return blob.generate_signed_url(
            version="v4",
            expiration=timedelta(seconds=SIGNED_URL_TTL_SECONDS),
            method="GET",
        )
    except Exception as error:
        if ALLOW_PUBLIC_GCS_URL_FALLBACK:
            warnings.warn(
                f"falling back to public GCS URL for {blob_name}: {error}",
                RuntimeWarning,
            )
            return _public_gcs_url(blob_name)
        raise RuntimeError(
            "failed to create a signed media URL; configure service-account "
            "credentials or set ALLOW_PUBLIC_GCS_URL_FALLBACK=true for local dev"
        ) from error


def _get_owned_project(job_id: str, user: AuthenticatedUser) -> Dict[str, Any]:
    if not _use_firestore_project_index():
        return _read_gcs_project_record(job_id, user)

    snapshot = _project_doc(job_id).get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="The project does not exist.")
    project = snapshot.to_dict() or {}
    if project.get("owner_uid") != user.uid:
        raise HTTPException(status_code=404, detail="The project does not exist.")
    return project


def _assert_owned_project_blob(
    blob_name: str,
    user: AuthenticatedUser,
) -> Tuple[str, Dict[str, Any]]:
    job_id = _job_id_from_blob_name(blob_name)
    project = _get_owned_project(job_id, user)
    gcs_prefix = project.get("gcs_prefix") or f"outputs/{job_id}/"
    if not blob_name.startswith(gcs_prefix):
        raise HTTPException(status_code=403, detail="Project object is not allowed.")
    return job_id, project


def _project_response(
    project: Dict[str, Any],
    bucket: storage.Bucket,
) -> Optional[Dict[str, Any]]:
    job_id = project.get("job_id")
    media_blob_name = project.get("media_blob_name")
    if not job_id or not media_blob_name:
        return None
    media_blob = bucket.get_blob(media_blob_name)
    if media_blob is None:
        return None
    media_blob.reload()
    subtitle_blob_name = project.get("subtitle_blob_name")
    render_source_blob_name = project.get("render_source_blob_name")
    return {
        "title": project.get("title") or Path(media_blob_name).stem,
        "job_id": job_id,
        "media_object_name": media_blob_name,
        "media_url": _signed_gcs_url(bucket, media_blob_name),
        "media_updated": media_blob.updated.isoformat() if media_blob.updated else None,
        "media_size": str(media_blob.size or ""),
        "media_content_type": media_blob.content_type or "video/mp4",
        "subtitle_object_name": subtitle_blob_name,
        "subtitle_url": (
            _signed_gcs_url(bucket, subtitle_blob_name) if subtitle_blob_name else None
        ),
        "render_source_object_name": render_source_blob_name,
        "render_source_url": (
            _signed_gcs_url(bucket, render_source_blob_name)
            if render_source_blob_name
            else None
        ),
        "pitch_semitones": project.get("pitch_semitones", 0),
    }


def _upsert_project_record(job_id: str, values: Dict[str, Any]) -> None:
    if not _use_firestore_project_index():
        _upsert_gcs_project_record(job_id, values)
        return

    doc = _project_doc(job_id)
    doc.set(
        {
            **values,
            "job_id": job_id,
            "updated_at": firestore.SERVER_TIMESTAMP,
        },
        merge=True,
    )


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


def _clean_client_render_id(render_id: Optional[str]) -> Optional[str]:
    if render_id is None:
        return None
    if not re.fullmatch(r"[0-9a-fA-F-]{16,80}", render_id):
        raise HTTPException(status_code=400, detail="Invalid render id.")
    return render_id.replace("-", "").lower()


def _prepare_editor_font_dir(work_dir: Path) -> Path:
    export_font_dir = work_dir / "fonts"
    export_font_dir.mkdir(parents=True, exist_ok=True)
    for font_filename in EDITOR_SUBTITLE_FONT_FILES:
        source_path = EDITOR_SUBTITLE_FONT_DIR / font_filename
        if not source_path.exists():
            raise RuntimeError(f"Editor subtitle font is missing: {source_path}")
        shutil.copy2(source_path, export_font_dir / font_filename)
    return export_font_dir


def _latest_generation_match_for_existing_blob(
    bucket: storage.Bucket,
    blob_name: str,
) -> int:
    latest_blob = bucket.get_blob(blob_name)
    if latest_blob is None:
        raise HTTPException(
            status_code=409,
            detail=(
                "The project video changed or was deleted while the save was "
                "rendering. Refresh the project and try again."
            ),
        )
    latest_blob.reload()
    return latest_blob.generation


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


def _ass_color_from_hex(hex_color: str, alpha: int = 0) -> str:
    if not re.fullmatch(r"#[0-9A-Fa-f]{6}", hex_color):
        raise HTTPException(
            status_code=400,
            detail="Karaoke highlight color must be a #RRGGBB hex color.",
        )
    alpha = max(0, min(255, alpha))
    clean = hex_color.lstrip("#")
    red = clean[0:2]
    green = clean[2:4]
    blue = clean[4:6]
    return f"&H{alpha:02X}{blue}{green}{red}".upper()


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


def _ass_visible_width_weight(text: str) -> float:
    weight = 0.0
    for character in text:
        if character.isspace():
            weight += 0.32
        elif re.fullmatch(
            r"[\u1100-\u11FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]", character
        ):
            weight += 1.05
        elif re.fullmatch(r"[\W_]", character, re.UNICODE):
            weight += 0.36
        elif character.isupper():
            weight += 0.66
        else:
            weight += 0.58
    return weight


def _max_subtitle_line_weight(
    transform: EditorSubtitleTransform,
    editor_font_size: int,
) -> float:
    available_width = max(
        80,
        transform.width / 100 * EDITOR_REFERENCE_WIDTH
        - EDITOR_SUBTITLE_HORIZONTAL_PADDING,
    )
    average_character_width = editor_font_size * (EDITOR_ASS_SCALE_X / 100)
    return max(4.0, available_width / average_character_width)


def _wrap_subtitle_line(text: str, max_line_weight: float) -> List[str]:
    clean_text = text.strip()
    if not clean_text:
        return [""]

    tokens = (
        re.findall(r"\S+\s*", clean_text)
        if re.search(r"\s", clean_text)
        else list(clean_text)
    )
    lines: List[str] = []
    current = ""
    current_weight = 0.0

    for token in tokens:
        token_weight = _ass_visible_width_weight(token)
        if current and current_weight + token_weight > max_line_weight:
            lines.append(current.rstrip())
            current = token
            current_weight = token_weight
        else:
            current += token
            current_weight += token_weight

    if current:
        lines.append(current.rstrip())
    return lines or [clean_text]


def _format_karaoke_wrapped_ass_text(
    text: str,
    duration: float,
    max_line_weight: float,
) -> Tuple[str, int]:
    segments = _karaoke_line_segments(text.strip())
    if not segments:
        return "", 1

    total_weight = sum(weight for _, weight in segments) or 1.0
    remaining_centiseconds = max(1, round(duration * 100))
    remaining_weight = total_weight
    ass_parts: List[str] = []
    line_count = 1
    current_line_weight = 0.0

    for token, weight in segments:
        token_width = _ass_visible_width_weight(token)
        if (
            current_line_weight > 0
            and current_line_weight + token_width > max_line_weight
        ):
            ass_parts.append(r"\N")
            line_count += 1
            current_line_weight = 0.0

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
        current_line_weight += token_width

    return "".join(ass_parts), line_count


def _write_editor_subtitles(
    request: SaveEditorProjectRequest,
    ass_path: Path,
    vtt_path: Path,
) -> None:
    transform = request.subtitle_transform
    margin = round((100 - transform.width) / 200 * EDITOR_REFERENCE_WIDTH)
    position_x = round(transform.x / 100 * EDITOR_REFERENCE_WIDTH)
    position_y = round(transform.y / 100 * EDITOR_REFERENCE_HEIGHT)
    ass_font_size = max(1, round(request.subtitle_font_size * EDITOR_ASS_FONT_SCALE))
    outline_width = max(1.25, round(ass_font_size / 25, 2))
    shadow_depth = max(0.85, round(ass_font_size / 38, 2))
    glow_outline_width = max(2.8, round(ass_font_size / 9, 2))
    glow_blur = max(2.4, round(ass_font_size / 11, 2))
    primary_color = (
        _ass_color_from_hex(request.karaoke_highlight_color)
        if request.karaoke_enabled
        else "&H00FFFFFF"
    )
    secondary_color = "&H00FFFFFF" if request.karaoke_enabled else "&H000000FF"
    glow_primary_color = _ass_color_from_hex(request.karaoke_highlight_color, alpha=10)
    glow_secondary_color = _ass_color_from_hex("#FFFFFF", alpha=255)
    glow_outline_color = _ass_color_from_hex("#FFEAF4", alpha=20)
    max_line_weight = _max_subtitle_line_weight(transform, request.subtitle_font_size)
    ass_lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {EDITOR_REFERENCE_WIDTH}",
        f"PlayResY: {EDITOR_REFERENCE_HEIGHT}",
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
            f"Style: Default,{EDITOR_SUBTITLE_FONT},{ass_font_size},{primary_color},"
            f"{secondary_color},&H00101A24,&H80000000,-1,0,0,0,"
            f"{EDITOR_ASS_SCALE_X},100,{EDITOR_ASS_SPACING},0,"
            f"1,{outline_width},{shadow_depth},"
            f"5,{margin},{margin},0,1"
        ),
        (
            f"Style: KaraokeGlow,{EDITOR_SUBTITLE_FONT},{ass_font_size},{glow_primary_color},"
            f"{glow_secondary_color},{glow_outline_color},&HFF000000,-1,0,0,0,"
            f"{EDITOR_ASS_SCALE_X},100,{EDITOR_ASS_SPACING},0,"
            f"1,{glow_outline_width},0,"
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
            rendered_lines: List[Tuple[str, int]] = []
            for line in cue_lines:
                if not line:
                    continue
                rendered_text, visual_line_count = _format_karaoke_wrapped_ass_text(
                    line,
                    cue.end - cue.start,
                    max_line_weight,
                )
                if rendered_text:
                    rendered_lines.append((rendered_text, visual_line_count))

            visual_line_total = max(1, sum(count for _, count in rendered_lines))
            visual_line_cursor = 0
            for rendered_text, visual_line_count in rendered_lines:
                visual_line_center = visual_line_cursor + (visual_line_count - 1) / 2
                offset_y = round(
                    (visual_line_center - (visual_line_total - 1) / 2) * line_height
                )
                visual_line_cursor += visual_line_count
                overrides = (
                    rf"{{\an5\pos({position_x},{position_y + offset_y})"
                    rf"\frz{transform.rotation:.2f}}}"
                )
                glow_overrides = (
                    rf"{{\an5\pos({position_x},{position_y + offset_y})"
                    rf"\frz{transform.rotation:.2f}\blur{glow_blur}}}"
                )
                ass_lines.append(
                    "Dialogue: 0,"
                    f"{_format_ass_timestamp(cue.start)},"
                    f"{_format_ass_timestamp(cue.end)},"
                    f"KaraokeGlow,,0,0,0,,{glow_overrides}"
                    f"{rendered_text}"
                )
                ass_lines.append(
                    "Dialogue: 1,"
                    f"{_format_ass_timestamp(cue.start)},"
                    f"{_format_ass_timestamp(cue.end)},"
                    f"Default,,0,0,0,,{overrides}"
                    f"{rendered_text}"
                )
        else:
            wrapped_text_lines: List[str] = []
            for line in cue.text.replace("\r", "").split("\n"):
                wrapped_text_lines.extend(_wrap_subtitle_line(line, max_line_weight))
            overrides = (
                rf"{{\an5\pos({position_x},{position_y})"
                rf"\frz{transform.rotation:.2f}}}"
            )
            ass_lines.append(
                "Dialogue: 0,"
                f"{_format_ass_timestamp(cue.start)},"
                f"{_format_ass_timestamp(cue.end)},"
                f"Default,,0,0,0,,{overrides}"
                f"{_escape_ass_text(chr(10).join(wrapped_text_lines))}"
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


def _render_editor_project_in_process(
    *,
    request: SaveEditorProjectRequest,
    source_path: Path,
    ass_path: Path,
    vtt_path: Path,
    rendered_path: Path,
    work_dir: Path,
    render_id: str,
) -> Dict[str, int]:
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
    except BrowserSubtitleRendererUnavailable as error:
        warnings.warn(
            f"Browser subtitle renderer unavailable; falling back to ASS: {error}",
            RuntimeWarning,
        )
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
        warnings.warn(
            f"Browser subtitle renderer failed; falling back to ASS: {error}",
            RuntimeWarning,
        )
        render_video_with_ass_subtitles(
            video_path=str(source_path),
            ass_path=str(ass_path),
            output_path=str(rendered_path),
            fonts_dir=str(render_font_dir),
            process_id=render_id,
            pitch_semitones=request.pitch_semitones,
        )
    if not rendered_path.exists() or rendered_path.stat().st_size == 0:
        raise RuntimeError("The rendered video is empty")

    return {
        "rendered_size": rendered_path.stat().st_size,
        "vtt_size": vtt_path.stat().st_size,
    }


def _run_editor_render_job(
    *,
    bucket: storage.Bucket,
    job_id: str,
    render_id: str,
    request: SaveEditorProjectRequest,
    render_request_blob_name: str,
    render_status_blob_name: str,
    render_source_blob_name: str,
    render_source_generation: int,
    staging_video_name: str,
    staging_vtt_name: str,
) -> Dict[str, Any]:
    request_blob = bucket.blob(render_request_blob_name)
    status_blob = bucket.blob(render_status_blob_name)
    request_blob.upload_from_string(
        request.model_dump_json(),
        content_type="application/json",
    )
    try:
        job_name = create_k8s_editor_render_job(
            job_id=job_id,
            render_id=render_id,
            render_request_blob_name=render_request_blob_name,
            render_status_blob_name=render_status_blob_name,
            render_source_blob_name=render_source_blob_name,
            render_source_generation=render_source_generation,
            staging_video_blob_name=staging_video_name,
            staging_vtt_blob_name=staging_vtt_name,
        )
        try:
            wait_for_jobs(
                [job_name],
                poll_interval_seconds=5,
                timeout_seconds=EDITOR_RENDER_JOB_TIMEOUT_SECONDS,
            )
        except Exception as error:
            if is_ffmpeg_process_cancelled(render_id):
                raise RuntimeError("Export render cancelled.") from error
            status_snapshot = bucket.get_blob(render_status_blob_name)
            if status_snapshot is not None:
                try:
                    status_payload = json.loads(
                        status_snapshot.download_as_text(encoding="utf-8")
                    )
                    if status_payload.get("error"):
                        raise RuntimeError(status_payload["error"]) from error
                except RuntimeError:
                    raise
                except Exception:
                    pass
            raise

        status_snapshot = bucket.get_blob(render_status_blob_name)
        if status_snapshot is None:
            raise RuntimeError("Editor render job completed without a status file.")
        status_payload = json.loads(status_snapshot.download_as_text(encoding="utf-8"))
        if status_payload.get("status") != "completed":
            raise RuntimeError(
                status_payload.get("error") or "Editor render job did not complete."
            )
        return status_payload
    except Exception:
        try:
            delete_k8s_editor_render_jobs(render_id)
        except Exception as cleanup_error:
            warnings.warn(
                f"failed to clean up editor render job for {render_id}: {cleanup_error}",
                RuntimeWarning,
            )
        raise
    finally:
        clear_ffmpeg_process_cancelled(render_id)
        try:
            request_blob.delete()
        except Exception:
            pass
        try:
            status_blob.delete()
        except Exception:
            pass


@app.get("/")
def root():
    """
    Note: this is basically only here for testing if the server is running successfully with curl
    """
    return {"status": "ok", "message": "inference server is running"}


@app.get("/health/check_gke_ready")
def check_gke_readiness():
    """
    Check and report whether this API can reach the Kubernetes Jobs API used for orchestration.

    This endpoint is intentionally public so the landing page can report backend
    availability before a user signs in.
    """
    api_client = None
    try:
        from kubernetes import client

        api_client = get_k8s_api_client()
        batch_v1 = client.BatchV1Api(api_client=api_client)
        batch_v1.list_namespaced_job(
            namespace=K8S_NAMESPACE,
            limit=1,
            _request_timeout=(2, 4),
        )
        return {"status": "ready"}
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"status": "unavailable"},
        )
    finally:
        if api_client is not None:
            try:
                api_client.close()
            except Exception:
                pass


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
    job_id: str,
    filename: str = "vocals.mp3",
    language: str = None,
    target_language: str = "en",
    should_translate: bool = Form(True),
    should_romanize: bool = Form(True),
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
        target_language = (target_language or "en").strip() or "en"
        srt_output_path = run_srt_inference(
            audio_path=str(local_audio_path),
            output_path=str(output_dir),
            language=language,
            target_language=target_language,
            should_translate=should_translate,
            should_romanize=should_romanize,
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
    should_translate: bool = Form(True),
    should_romanize: bool = Form(True),
    language: Union[str, None] = Form(None),
    target_language: str = Form("en"),
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
    transcription_res = await run_transcription(
        job_id=job_id,
        language=language,
        target_language=(target_language or "en").strip() or "en",
        should_translate=should_translate,
        should_romanize=should_romanize,
    )
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
def convert_to_vtt(
    job_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
) -> dict:
    """
    This function takes in an srt file and converts it to a vtt file, which can be used for subtitles in the video player.

    Args:
        job_id (str): The job id of the inference job, used to locate the srt file in the gcs bucket.
    """
    job_id = _validated_job_id(job_id)
    _get_owned_project(job_id, user)
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
    vtt_blob_name = f"outputs/{job_id}/vocals.vtt"
    try:
        upload_file_to_gcs(
            local_path=str(vtt_path),
            bucket_name=GCS_BUCKET,
            destination_blob_name=vtt_blob_name,
        )
    except Exception as e:
        raise HTTPException(
            status_code=500, detail=f"file upload to GCS failed: {str(e)}"
        )

    bucket = storage.Client().bucket(GCS_BUCKET)
    return {
        "status": "vtt converted",
        "job_id": job_id,
        "vtt_link": _signed_gcs_url(bucket, vtt_blob_name),
        "vtt_url": _signed_gcs_url(bucket, vtt_blob_name),
    }


# @app.post("/jobs")
async def create_inference_job(
    file: UploadFile = File(...),
    should_decrowd: bool = Form(False),
    should_translate: bool = Form(True),
    should_romanize: bool = Form(True),
    language: Union[str, None] = Form(None),
    target_language: str = Form("en"),
) -> Dict:
    """
    Adapted function from run_full_inference to support K8 job creation to run inference on GKE per request, versus keeping the pod open in an always "on-deployment" state.
    Here, a k8s job is created for full inference initialization but now we pass the actual inference to the k8s job instead of running it in the fastapi app
    Args:
        file: the input file from the user, either video or audio, uploaded through the FastAPI endpoint
        should_decrowd: whether to run the decrowding model after source separation
        language: input file audio language
        target_language: target language to translate to
    Returns:
        dict containing job_id and status message
    """
    job_id = create_job_id()

    try:
        target_language = (target_language or "en").strip() or "en"
        input_gcs_path, input_blob_name, filename = await upload_input_file_to_gcs(
            file=file, job_id=job_id
        )

        job_name = create_k8s_inference_job(
            job_id=job_id,
            input_gcs_path=input_gcs_path,
            input_blob_name=input_blob_name,
            filename=filename,
            should_decrowd=should_decrowd,
            should_translate=should_translate,
            should_romanize=should_romanize,
            language=language,
            target_language=target_language,
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
    should_transcribe: bool = Form(True),
    should_translate: bool = Form(True),
    should_romanize: bool = Form(True),
    language: Union[str, None] = Form(None),
    target_language: str = Form("en"),
    project_title: Union[str, None] = Form(None),
    user: AuthenticatedUser = Depends(get_current_user),
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
        target_language = (target_language or "en").strip() or "en"
        input_gcs_path, input_blob_name, filename = await upload_input_file_to_gcs(
            file=file,
            job_id=job_id,
        )

        clean_title = (
            _clean_project_title(project_title)
            if project_title and project_title.strip()
            else _clean_project_title(Path(filename).stem)
        )

        _upsert_project_record(
            job_id,
            {
                "owner_uid": user.uid,
                "owner_email": user.email,
                "title": clean_title,
                "gcs_prefix": f"outputs/{job_id}/",
                "input_blob_name": input_blob_name,
                "status": "queued",
                "created_at": (
                    firestore.SERVER_TIMESTAMP
                    if _use_firestore_project_index()
                    else _project_timestamp()
                ),
            },
        )

        orchestration_job_name = create_k8s_orchestration_job(
            job_id=job_id,
            input_blob_name=input_blob_name,
            filename=filename,
            content_type=file.content_type,
            should_decrowd=should_decrowd,
            fast_decrowd=fast_decrowd,
            should_transcribe=should_transcribe,
            should_translate=should_translate,
            should_romanize=should_romanize,
            language=language,
            target_language=target_language,
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
        try:
            _upsert_project_record(
                job_id,
                {
                    "owner_uid": user.uid,
                    "owner_email": user.email,
                    "status": "failed",
                    "error": str(e),
                },
            )
        except Exception:
            pass
        raise HTTPException(
            status_code=500,
            detail=f"inference orchestration job creation failed: {str(e)}",
        )


@app.post("/projects/save")
def save_editor_project(
    request: SaveEditorProjectRequest,
    user: AuthenticatedUser = Depends(get_current_user),
) -> Dict[str, object]:
    """
    Render editor subtitle changes and publish them without deleting the source first.
    """
    source_blob_name = _validated_project_video_blob_name(request.source_blob_name)
    job_id, owned_project = _assert_owned_project_blob(source_blob_name, user)
    clean_title = _clean_project_title(request.title)

    source_parent = source_blob_name.rsplit("/", 1)[0]
    destination_blob_name = f"{source_parent}/{clean_title}.mp4"
    save_id = _clean_client_render_id(request.client_render_id) or uuid.uuid4().hex
    subtitle_blob_name = f"outputs/{job_id}/editor/{clean_title}-{save_id}.vtt"
    staging_prefix = f"outputs/{job_id}/.editor-staging/{save_id}"
    staging_video_name = f"{staging_prefix}.mp4"
    staging_vtt_name = f"{staging_prefix}.vtt"
    render_request_blob_name = (
        f"outputs/{job_id}/.editor-render-requests/{save_id}.json"
    )
    render_status_blob_name = f"outputs/{job_id}/.editor-render-status/{save_id}.json"
    render_source_blob_name = f"outputs/{job_id}/editor/source.mp4"
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
    render_result: Dict[str, Any] = {}

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
        if EDITOR_RENDER_USE_K8S:
            render_result = _run_editor_render_job(
                bucket=bucket,
                job_id=job_id,
                render_id=save_id,
                request=request,
                render_request_blob_name=render_request_blob_name,
                render_status_blob_name=render_status_blob_name,
                render_source_blob_name=render_source_blob_name,
                render_source_generation=render_source_blob.generation,
                staging_video_name=staging_video_name,
                staging_vtt_name=staging_vtt_name,
            )
        else:
            render_source_blob.download_to_filename(
                str(source_path),
                if_generation_match=render_source_blob.generation,
            )
            render_result = _render_editor_project_in_process(
                request=request,
                source_path=source_path,
                ass_path=ass_path,
                vtt_path=vtt_path,
                rendered_path=rendered_path,
                work_dir=work_dir,
                render_id=save_id,
            )
            staging_video_upload = bucket.blob(staging_video_name)
            staging_video_upload.upload_from_filename(
                str(rendered_path), content_type="video/mp4"
            )
            staging_vtt_upload = bucket.blob(staging_vtt_name)
            staging_vtt_upload.upload_from_filename(
                str(vtt_path), content_type="text/vtt"
            )

        staging_video = bucket.get_blob(staging_video_name)
        if staging_video is None:
            raise RuntimeError("The staged video was not created.")
        staging_video.reload()
        expected_video_size = render_result.get("rendered_size")
        if expected_video_size and staging_video.size != expected_video_size:
            raise RuntimeError("The staged video failed size verification.")

        staging_vtt = bucket.get_blob(staging_vtt_name)
        if staging_vtt is None:
            raise RuntimeError("The staged subtitle file was not created.")
        staging_vtt.reload()
        expected_vtt_size = render_result.get("vtt_size")
        if expected_vtt_size and staging_vtt.size != expected_vtt_size:
            raise RuntimeError("The staged subtitle file failed size verification.")

        published_vtt = bucket.copy_blob(
            staging_vtt,
            bucket,
            subtitle_blob_name,
            if_generation_match=0,
        )
        published_vtt.reload()

        if destination_blob_name == source_blob_name:
            destination_generation_match = _latest_generation_match_for_existing_blob(
                bucket,
                destination_blob_name,
            )
        else:
            destination_generation_match = 0
        try:
            published_video = bucket.copy_blob(
                staging_video,
                bucket,
                destination_blob_name,
                if_generation_match=destination_generation_match,
            )
        except Exception as error:
            if destination_blob_name != source_blob_name or "412" not in str(error):
                raise
            published_video = bucket.copy_blob(
                staging_video,
                bucket,
                destination_blob_name,
                if_generation_match=_latest_generation_match_for_existing_blob(
                    bucket,
                    destination_blob_name,
                ),
            )
        published_video.reload()
        if published_video.size != staging_video.size:
            raise RuntimeError("The published video failed size verification.")

        _upsert_project_record(
            job_id,
            {
                "owner_uid": owned_project.get("owner_uid", user.uid),
                "owner_email": owned_project.get("owner_email", user.email),
                "title": clean_title,
                "gcs_prefix": f"outputs/{job_id}/",
                "media_blob_name": destination_blob_name,
                "subtitle_blob_name": subtitle_blob_name,
                "render_source_blob_name": render_source_blob_name,
                "pitch_semitones": request.pitch_semitones,
                "status": "completed",
            },
        )

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
            "media_url": _signed_gcs_url(bucket, destination_blob_name),
            "render_source_object_name": render_source_blob_name,
            "render_source_url": _signed_gcs_url(bucket, render_source_blob_name),
            "subtitle_object_name": subtitle_blob_name,
            "subtitle_url": _signed_gcs_url(bucket, subtitle_blob_name),
            "generation": published_video.generation,
            "pitch_semitones": request.pitch_semitones,
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
        if "cancelled" in str(error).lower():
            raise HTTPException(status_code=499, detail="Export render cancelled.")
        raise HTTPException(
            status_code=500,
            detail=f"edited video save failed before replacing the original: {error}",
        )
    finally:
        for blob_name in (
            staging_video_name,
            staging_vtt_name,
            render_request_blob_name,
            render_status_blob_name,
        ):
            try:
                bucket.blob(blob_name).delete()
            except Exception:
                pass
        shutil.rmtree(work_dir, ignore_errors=True)


@app.post("/projects/render-cancel/{render_id}")
def cancel_project_render(
    render_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
) -> Dict[str, object]:
    clean_render_id = _clean_client_render_id(render_id)
    if clean_render_id is None:
        raise HTTPException(status_code=400, detail="Invalid render id.")
    k8s_deleted = False
    if EDITOR_RENDER_USE_K8S:
        try:
            k8s_deleted = delete_k8s_editor_render_jobs(clean_render_id)
        except Exception as error:
            warnings.warn(
                f"failed to delete editor render job for {clean_render_id}: {error}",
                RuntimeWarning,
            )
    ffmpeg_cancelled = cancel_ffmpeg_process(clean_render_id)
    return {
        "status": "cancelled" if k8s_deleted or ffmpeg_cancelled else "not_running",
        "render_id": clean_render_id,
        "k8s_deleted": k8s_deleted,
        "ffmpeg_cancelled": ffmpeg_cancelled,
    }


@app.get("/projects")
def list_projects(
    user: AuthenticatedUser = Depends(get_current_user),
) -> Dict[str, object]:
    try:
        bucket = storage.Client().bucket(GCS_BUCKET)
        if _use_firestore_project_index():
            query = (
                _firestore_client()
                .collection(PROJECTS_COLLECTION)
                .where("owner_uid", "==", user.uid)
            )
            project_records = [snapshot.to_dict() or {} for snapshot in query.stream()]
        else:
            project_records = _list_gcs_project_records(user)

        projects = []
        for project in project_records:
            response = _project_response(project, bucket)
            if response is not None:
                projects.append(response)
        projects.sort(key=lambda item: item.get("media_updated") or "", reverse=True)
        return {"projects": projects}
    except HTTPException:
        raise
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"project library lookup failed: {error}",
        ) from error


@app.get("/jobs/{job_id}/objects")
def list_job_objects(
    job_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
) -> Dict[str, object]:
    job_id = _validated_job_id(job_id)
    _get_owned_project(job_id, user)
    prefix = f"outputs/{job_id}/"
    bucket = storage.Client().bucket(GCS_BUCKET)
    objects = [
        {
            "name": blob.name,
            "updated": blob.updated.isoformat() if blob.updated else None,
            "size": str(blob.size or ""),
            "contentType": blob.content_type,
        }
        for blob in bucket.list_blobs(prefix=prefix)
    ]
    return {"items": objects}


@app.get("/projects/download")
def download_project(
    source_blob_name: str,
    user: AuthenticatedUser = Depends(get_current_user),
) -> StreamingResponse:
    source_blob_name = _validated_project_video_blob_name(source_blob_name)
    _assert_owned_project_blob(source_blob_name, user)
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


@app.get("/projects/download-audio")
def download_project_audio(
    source_blob_name: str,
    user: AuthenticatedUser = Depends(get_current_user),
) -> StreamingResponse:
    source_blob_name = _validated_project_video_blob_name(source_blob_name)
    _assert_owned_project_blob(source_blob_name, user)
    bucket = storage.Client().bucket(GCS_BUCKET)
    source_blob = bucket.get_blob(source_blob_name)
    if source_blob is None:
        raise HTTPException(
            status_code=404, detail="The project video no longer exists."
        )

    source_blob.reload()
    work_dir = Path(f"/tmp/benzaiten-audio-export-{uuid.uuid4().hex}")
    source_path = work_dir / "source.mp4"
    audio_path = work_dir / "audio.mp3"
    filename = f"{Path(source_blob_name).stem}.mp3"

    try:
        work_dir.mkdir(parents=True, exist_ok=True)
        source_blob.download_to_filename(
            str(source_path),
            if_generation_match=source_blob.generation,
        )
        extract_audio_from_video(str(source_path), str(audio_path))
        if not audio_path.exists() or audio_path.stat().st_size == 0:
            raise RuntimeError("The exported audio file is empty.")
    except Exception as error:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise HTTPException(
            status_code=500, detail=f"audio export failed: {error}"
        ) from error

    def stream_audio():
        try:
            with audio_path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    yield chunk
        finally:
            shutil.rmtree(work_dir, ignore_errors=True)

    return StreamingResponse(
        stream_audio(),
        media_type="audio/mpeg",
        headers={
            "Content-Disposition": (
                f"attachment; filename*=UTF-8''{quote(filename, safe='')}"
            ),
            "Content-Length": str(audio_path.stat().st_size),
        },
    )


@app.post("/projects/rename")
def rename_project(
    request: RenameProjectRequest,
    user: AuthenticatedUser = Depends(get_current_user),
) -> Dict[str, object]:
    source_blob_name = _validated_project_video_blob_name(request.source_blob_name)
    job_id, owned_project = _assert_owned_project_blob(source_blob_name, user)
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
        _upsert_project_record(
            job_id,
            {
                "owner_uid": owned_project.get("owner_uid", user.uid),
                "owner_email": owned_project.get("owner_email", user.email),
                "title": clean_title,
                "media_blob_name": source_blob_name,
            },
        )
        return {
            "status": "renamed",
            "title": clean_title,
            "media_object_name": source_blob_name,
            "media_url": _signed_gcs_url(bucket, source_blob_name),
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

    _upsert_project_record(
        job_id,
        {
            "owner_uid": owned_project.get("owner_uid", user.uid),
            "owner_email": owned_project.get("owner_email", user.email),
            "title": clean_title,
            "media_blob_name": destination_blob_name,
        },
    )

    return {
        "status": "renamed",
        "title": clean_title,
        "media_object_name": destination_blob_name,
        "media_url": _signed_gcs_url(bucket, destination_blob_name),
    }


@app.delete("/projects/{job_id}")
def delete_project(
    job_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
) -> Dict[str, object]:
    job_id = _validated_job_id(job_id)
    _get_owned_project(job_id, user)
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

    _delete_project_record(job_id, user)

    return {
        "status": "deleted",
        "job_id": job_id,
        "deleted_objects": deleted_objects,
        "deleted_prefix": prefix,
    }


@app.get("/jobs/{job_id}")
def get_inference_job_status(
    job_id: str,
    user: AuthenticatedUser = Depends(get_current_user),
) -> Dict[str, str]:
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

    job_id = _validated_job_id(job_id)
    _get_owned_project(job_id, user)

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

        bucket = storage.Client().bucket(GCS_BUCKET)
        video_blob_name = _gcs_object_name_from_url(result.get("video_url"))
        audio_blob_name = _gcs_object_name_from_url(result.get("audio_url"))
        subtitle_blob_name = _gcs_object_name_from_url(result.get("subtitle_url"))
        media_blob_name = video_blob_name or audio_blob_name
        if media_blob_name is None or subtitle_blob_name is None:
            return None

        _upsert_project_record(
            job_id,
            {
                "owner_uid": user.uid,
                "owner_email": user.email,
                "media_blob_name": media_blob_name,
                "subtitle_blob_name": subtitle_blob_name,
                "render_source_blob_name": media_blob_name if video_blob_name else None,
                "status": "completed",
            },
        )

        response = {
            "job_id": job_id,
            "status": "completed",
            "subtitle_url": _signed_gcs_url(bucket, subtitle_blob_name),
        }
        if video_blob_name:
            response["video_url"] = _signed_gcs_url(bucket, video_blob_name)
        if audio_blob_name:
            response["audio_url"] = _signed_gcs_url(bucket, audio_blob_name)

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

        _upsert_project_record(
            job_id,
            {
                "owner_uid": user.uid,
                "owner_email": user.email,
                "status": "failed",
            },
        )

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
    allow_origin_regex=r"^http://(localhost|127\.0\.0\.1):\d+$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# testing
if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
