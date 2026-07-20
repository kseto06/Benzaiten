import { DEFAULT_KARAOKE_HIGHLIGHT_COLOR } from "../common/config";
import { clamp, getKaraokeLineTokens } from "../common/utils";
import type { SubtitleCue } from "../common/types";

export function waitForMediaEvent(
  element: HTMLMediaElement,
  eventName: "loadedmetadata" | "canplaythrough",
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Export was cancelled.", "AbortError"));
      return;
    }
    const cleanup = (): void => {
      element.removeEventListener(eventName, onEvent);
      element.removeEventListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onEvent = (): void => {
      cleanup();
      resolve();
    };
    const onError = (): void => {
      cleanup();
      reject(new Error("Local media could not be loaded for export."));
    };
    const onAbort = (): void => {
      cleanup();
      reject(new DOMException("Export was cancelled.", "AbortError"));
    };
    element.addEventListener(eventName, onEvent, { once: true });
    element.addEventListener("error", onError, { once: true });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function drawCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fillStyle: string,
  fontSize: number,
  glow = false,
): void {
  context.save();
  context.lineJoin = "round";
  context.miterLimit = 2;
  context.strokeStyle = glow ? "rgba(255, 248, 253, 0.95)" : "rgba(0, 0, 0, 0.88)";
  context.lineWidth = glow ? Math.max(1, fontSize * 0.035) : Math.max(2, fontSize * 0.12);
  context.shadowColor = glow ? "rgba(255, 210, 230, 0.7)" : "rgba(0, 0, 0, 0.8)";
  context.shadowBlur = glow ? fontSize * 0.18 : fontSize * 0.12;
  context.shadowOffsetY = glow ? fontSize * 0.04 : fontSize * 0.08;
  context.strokeText(text, x, y);
  context.fillStyle = fillStyle;
  context.fillText(text, x, y);
  context.restore();
}

export function drawKaraokeLineOnCanvas(
  context: CanvasRenderingContext2D,
  cue: SubtitleCue,
  line: string,
  centerX: number,
  baselineY: number,
  fontSize: number,
  time: number,
  karaokeHighlightColor = DEFAULT_KARAOKE_HIGHLIGHT_COLOR,
): void {
  const tokens = getKaraokeLineTokens(line);
  if (!tokens.length) {
    return;
  }
  const text = tokens.map(token => token.text).join("");
  const totalWidth = context.measureText(text).width;
  let cursorX = centerX - totalWidth / 2;
  const cueDuration = Math.max(0.01, cue.end - cue.start);
  const lineWeight = tokens.reduce((total, token) => total + token.weight, 0);
  let tokenStart = cue.start;

  drawCanvasText(context, text, centerX, baselineY, "#fff", fontSize);

  context.save();
  context.textAlign = "left";
  for (const token of tokens) {
    const tokenDuration = cueDuration * (token.weight / Math.max(0.25, lineWeight));
    const tokenEnd = tokenStart + tokenDuration;
    const tokenWidth = context.measureText(token.text).width;
    const progress = clamp((time - tokenStart) / Math.max(0.01, tokenDuration), 0, 1);
    if (progress > 0) {
      context.save();
      context.beginPath();
      context.rect(
        cursorX - fontSize * 0.08,
        baselineY - fontSize,
        tokenWidth * progress + fontSize * 0.16,
        fontSize * 1.35,
      );
      context.clip();
      drawCanvasText(
        context,
        token.text,
        cursorX,
        baselineY,
        karaokeHighlightColor,
        fontSize,
        true,
      );
      context.restore();
    }
    cursorX += tokenWidth;
    tokenStart = tokenEnd;
  }
  context.restore();
}
