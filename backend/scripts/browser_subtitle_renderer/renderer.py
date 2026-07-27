import base64
import math
import os
import shutil
from pathlib import Path
from typing import Dict, List, Optional

from backend.scripts.ffmpeg import (
    clear_ffmpeg_process_cancelled,
    get_media_dimensions,
    get_media_duration,
    get_media_frame_rate,
    is_ffmpeg_process_cancelled,
    render_video_with_png_overlay,
)


class BrowserSubtitleRendererUnavailable(RuntimeError):
    pass


PROJECT_ROOT = Path(__file__).resolve().parents[3]
RENDERER_DIR = Path(__file__).resolve().parent
LOCAL_PLAYWRIGHT_BROWSERS = PROJECT_ROOT / ".cache" / "ms-playwright"
LOCAL_CHROME_FOR_TESTING = (
    LOCAL_PLAYWRIGHT_BROWSERS
    / "chromium-1223"
    / "chrome-mac-arm64"
    / "Google Chrome for Testing.app"
    / "Contents"
    / "MacOS"
    / "Google Chrome for Testing"
)


def _read_renderer_asset(filename: str) -> str:
    return (RENDERER_DIR / filename).read_text(encoding="utf-8")


def _font_face_css(font_dir: Optional[str]) -> str:
    if not font_dir:
        return ""
    font_path = Path(font_dir) / "DMSans-Bold.ttf"
    if not font_path.exists():
        return ""
    encoded_font = base64.b64encode(font_path.read_bytes()).decode("ascii")
    return (
        "@font-face {"
        "font-family: BenzaitenSubtitle;"
        "font-style: normal;"
        "font-weight: 700;"
        "font-display: block;"
        f"src: url('data:font/truetype;base64,{encoded_font}') format('truetype');"
        "}"
    )


def _renderer_html(
    *,
    font_dir: Optional[str],
    viewport_width: int,
    viewport_height: int,
) -> str:
    renderer_css = (
        _read_renderer_asset("renderer.css")
        .replace("__FONT_FACE_CSS__", _font_face_css(font_dir))
        .replace("__VIEWPORT_WIDTH__", str(viewport_width))
        .replace("__VIEWPORT_HEIGHT__", str(viewport_height))
    )
    renderer_js = _read_renderer_asset("renderer.js")
    return (
        _read_renderer_asset("renderer.html")
        .replace("__RENDERER_CSS__", renderer_css)
        .replace("__RENDERER_JS__", renderer_js)
    )


def render_video_with_browser_subtitles(
    *,
    video_path: str,
    output_path: str,
    cues: List[Dict[str, object]],
    subtitle_font_size: int,
    subtitle_transform: Dict[str, float],
    karaoke_enabled: bool,
    karaoke_highlight_color: str,
    fonts_dir: Optional[str] = None,
    process_id: Optional[str] = None,
    reference_width: int = 960,
    reference_height: int = 540,
) -> Path:
    if LOCAL_PLAYWRIGHT_BROWSERS.exists():
        os.environ.setdefault(
            "PLAYWRIGHT_BROWSERS_PATH",
            str(LOCAL_PLAYWRIGHT_BROWSERS),
        )
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as error:
        raise BrowserSubtitleRendererUnavailable(
            "Playwright is not installed for browser subtitle export."
        ) from error

    video_path_object = Path(video_path)
    output_path_object = Path(output_path)
    frames_dir = (
        output_path_object.parent / f"{output_path_object.stem}-subtitle-frames"
    )
    if frames_dir.exists():
        shutil.rmtree(frames_dir)
    frames_dir.mkdir(parents=True, exist_ok=True)

    duration = get_media_duration(str(video_path_object))
    output_width, output_height = get_media_dimensions(str(video_path_object))
    preview_scale = output_width / reference_width
    frame_rate = min(30.0, max(12.0, get_media_frame_rate(str(video_path_object))))
    frame_count = max(1, math.ceil(duration * frame_rate))
    frame_pattern = str(frames_dir / "frame_%08d.png")

    try:
        with sync_playwright() as playwright:
            launch_options = {
                "headless": True,
                "args": ["--disable-dev-shm-usage"],
            }
            if LOCAL_CHROME_FOR_TESTING.exists():
                launch_options["executable_path"] = str(LOCAL_CHROME_FOR_TESTING)
            browser = playwright.chromium.launch(**launch_options)
            page = browser.new_page(
                viewport={"width": output_width, "height": output_height},
                device_scale_factor=1,
            )
            page.set_content(
                _renderer_html(
                    font_dir=fonts_dir,
                    viewport_width=output_width,
                    viewport_height=output_height,
                ),
                wait_until="load",
            )
            page.evaluate(
                "settings => window.configureSubtitleRenderer(settings)",
                {
                    "cues": cues,
                    "subtitleFontSize": subtitle_font_size,
                    "previewScale": preview_scale,
                    "transform": subtitle_transform,
                    "karaokeEnabled": karaoke_enabled,
                    "karaokeHighlightColor": karaoke_highlight_color,
                },
            )
            font_ready = page.evaluate(
                """async () => {
                    await document.fonts.ready;
                    return document.fonts.check(
                        '700 48px BenzaitenSubtitle',
                        'Benzaiten English subtitle sample'
                    );
                }"""
            )
            if not font_ready:
                raise RuntimeError("browser subtitle renderer could not load DM Sans")

            for frame_index in range(frame_count):
                if is_ffmpeg_process_cancelled(process_id):
                    raise RuntimeError("browser subtitle rendering cancelled")
                time_seconds = frame_index / frame_rate
                page.evaluate("time => window.renderSubtitleAt(time)", time_seconds)
                page.screenshot(
                    path=str(frames_dir / f"frame_{frame_index + 1:08d}.png"),
                    omit_background=True,
                    animations="disabled",
                    caret="hide",
                )

            browser.close()

        if is_ffmpeg_process_cancelled(process_id):
            raise RuntimeError("browser subtitle rendering cancelled")

        render_video_with_png_overlay(
            str(video_path_object),
            frame_pattern,
            str(output_path_object),
            frame_rate=frame_rate,
            process_id=process_id,
        )
    finally:
        if process_id is not None and is_ffmpeg_process_cancelled(process_id):
            clear_ffmpeg_process_cancelled(process_id)

    return output_path_object
