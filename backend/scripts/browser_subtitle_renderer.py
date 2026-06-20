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


PROJECT_ROOT = Path(__file__).resolve().parents[2]
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
    return f"""
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    {_font_face_css(font_dir)}
    html,
    body {{
      width: {viewport_width}px;
      height: {viewport_height}px;
      margin: 0;
      overflow: hidden;
      background: transparent;
      font-family: BenzaitenSubtitle, "DM Sans", Arial, sans-serif;
      font-synthesis: none;
      text-rendering: optimizeLegibility;
    }}

    * {{
      box-sizing: border-box;
    }}

    .subtitle-transform-box {{
      position: absolute;
      z-index: 4;
      display: grid;
      min-width: 48px;
      min-height: 32px;
      place-items: center;
      transform-origin: center;
    }}

    .subtitle-overlay {{
      --subtitle-preview-scale: 1;
      --karaoke-highlight-color: #f4a6c1;
      --subtitle-shadow:
        0 calc(2px * var(--subtitle-preview-scale))
          calc(5px * var(--subtitle-preview-scale)) #000,
        0 0 calc(2px * var(--subtitle-preview-scale)) #000;
      width: 100%;
      padding:
        calc(8px * var(--subtitle-preview-scale))
        calc(14px * var(--subtitle-preview-scale));
      color: #fff;
      font-family: BenzaitenSubtitle, "DM Sans", Arial, sans-serif;
      font-weight: 700;
      line-height: 1.25;
      text-align: center;
      text-shadow: var(--subtitle-shadow);
      white-space: pre-line;
      pointer-events: none;
    }}

    .karaoke-segment {{
      position: relative;
      display: inline-block;
      color: #fff;
      text-shadow: var(--subtitle-shadow);
      vertical-align: baseline;
      white-space: pre;
    }}

    .karaoke-segment-base {{
      color: #fff;
      -webkit-text-fill-color: currentColor;
      text-shadow: var(--subtitle-shadow);
    }}

    .karaoke-segment-fill {{
      position: absolute;
      inset: 0 auto 0 0;
      display: inline-block;
      width: var(--karaoke-progress);
      max-width: 100%;
      overflow: hidden;
      color: var(--karaoke-highlight-color);
      -webkit-text-fill-color: currentColor;
      -webkit-text-stroke: calc(0.35px * var(--subtitle-preview-scale))
        rgba(255, 248, 253, 0.95);
      filter:
        drop-shadow(0 0 calc(3px * var(--subtitle-preview-scale)) rgba(255, 226, 240, 0.7))
        drop-shadow(0 calc(2px * var(--subtitle-preview-scale))
          calc(4px * var(--subtitle-preview-scale)) rgba(0, 0, 0, 0.75));
      text-shadow:
        0 0 calc(2px * var(--subtitle-preview-scale)) rgba(255, 248, 253, 0.95),
        var(--subtitle-shadow);
      white-space: pre;
    }}

    #fontProbe {{
      position: absolute;
      left: -10000px;
      top: -10000px;
      font-family: BenzaitenSubtitle, "DM Sans", Arial, sans-serif;
      font-size: 48px;
      font-weight: 700;
      white-space: nowrap;
    }}
  </style>
</head>
<body>
  <div class="subtitle-transform-box" id="subtitleBox">
    <div class="subtitle-overlay" id="subtitleOverlay"></div>
  </div>
  <div id="fontProbe" aria-hidden="true">Benzaiten English subtitle sample</div>
  <script>
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const escapeHtml = (value) => String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

    function getKaraokeTokenWeight(text) {{
      let weight = 0;
      for (const character of Array.from(String(text).trim())) {{
        if (/\\s/u.test(character)) {{
          continue;
        }}
        weight += /[\\W_]/u.test(character) ? 0.25 : 1;
      }}
      return Math.max(0.25, weight);
    }}

    function getKaraokeLineTokens(line) {{
      if (!line) {{
        return [];
      }}
      if (/\\s/u.test(line.trim())) {{
        return (line.match(/\\S+\\s*/gu) || []).map(token => ({{
          text: token,
          weight: getKaraokeTokenWeight(token),
        }}));
      }}
      return Array.from(line).map(character => ({{
        text: character,
        weight: getKaraokeTokenWeight(character),
      }}));
    }}

    function getTimedKaraokeTokens(cue) {{
      const lines = cue.text.replace(/\\r/g, "").split("\\n");
      const cueDuration = Math.max(0.01, cue.end - cue.start);
      const timedSegments = [];
      for (const [lineIndex, line] of lines.entries()) {{
        if (lineIndex > 0) {{
          timedSegments.push({{ lineBreak: true }});
        }}
        const lineTokens = getKaraokeLineTokens(line);
        const lineWeight = lineTokens.reduce((total, segment) => total + segment.weight, 0);
        let cursor = cue.start;
        for (const segment of lineTokens) {{
          const segmentDuration = cueDuration * (segment.weight / Math.max(0.25, lineWeight));
          const timedSegment = {{
            ...segment,
            start: cursor,
            end: cursor + segmentDuration,
          }};
          timedSegments.push(timedSegment);
          cursor = timedSegment.end;
        }}
      }}
      return timedSegments;
    }}

    function renderKaraokeSubtitle(cue, time) {{
      return getTimedKaraokeTokens(cue).map(segment => {{
        if (segment.lineBreak === true) {{
          return "\\n";
        }}
        const progress = clamp(
          (time - segment.start) / Math.max(0.01, segment.end - segment.start),
          0,
          1,
        );
        const text = escapeHtml(segment.text);
        return (
          `<span class="karaoke-segment" style="--karaoke-progress:${{(progress * 100).toFixed(2)}}%">`
          + `<span class="karaoke-segment-base">${{text}}</span>`
          + `<span class="karaoke-segment-fill" aria-hidden="true">${{text}}</span>`
          + "</span>"
        );
      }}).join("");
    }}

    window.configureSubtitleRenderer = (settings) => {{
      window.__benzaitenSubtitleSettings = settings;
      const box = document.getElementById("subtitleBox");
      const overlay = document.getElementById("subtitleOverlay");
      const transform = settings.transform;
      box.style.left = `${{transform.x}}%`;
      box.style.top = `${{transform.y}}%`;
      box.style.width = `${{transform.width}}%`;
      box.style.height = `${{transform.height}}%`;
      box.style.transform = `translate(-50%, -50%) rotate(${{transform.rotation}}deg)`;
      overlay.style.setProperty("--subtitle-preview-scale", settings.previewScale);
      overlay.style.fontSize = `${{settings.subtitleFontSize * settings.previewScale}}px`;
      overlay.style.setProperty("--karaoke-highlight-color", settings.karaokeHighlightColor);
    }};

    window.renderSubtitleAt = (time) => {{
      const settings = window.__benzaitenSubtitleSettings;
      const overlay = document.getElementById("subtitleOverlay");
      const cue = settings.cues.find(item => time >= item.start && time < item.end);
      overlay.innerHTML = cue
        ? settings.karaokeEnabled
          ? renderKaraokeSubtitle(cue, time)
          : escapeHtml(cue.text)
        : "";
    }};
  </script>
</body>
</html>
"""


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
