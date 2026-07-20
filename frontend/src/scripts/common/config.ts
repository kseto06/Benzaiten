import type { BrowserExportFormat } from "./types";

export const GCS_BUCKET = "benzaiten-outputs";
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
export const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
export const PROJECT_STORAGE_KEY = "benzaiten-editor-project";
export const LOG_PREFIX = "[Benzaiten]";
export const DEFAULT_KARAOKE_HIGHLIGHT_COLOR = "#f4a6c1";
export const VOLATILE_SIGNED_OUT_WARNING = "You're not signed in, so your project won't be saved.";
export const VOLATILE_GOOGLE_ERROR_WARNING = "Google error - project won't be saved.";

export const BROWSER_EXPORT_FORMAT_CANDIDATES: BrowserExportFormat[] = [
  {
    label: "MP4",
    extension: "mp4",
    mimeType: "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    isFallback: false,
  },
  {
    label: "MP4",
    extension: "mp4",
    mimeType: "video/mp4",
    isFallback: false,
  },
  {
    label: "WEBM",
    extension: "webm",
    mimeType: "video/webm;codecs=vp9,opus",
    isFallback: true,
  },
  {
    label: "WEBM",
    extension: "webm",
    mimeType: "video/webm;codecs=vp8,opus",
    isFallback: true,
  },
  {
    label: "WEBM",
    extension: "webm",
    mimeType: "video/webm",
    isFallback: true,
  },
];

export function getPreferredBrowserExportFormat(): BrowserExportFormat | null {
  if (!("MediaRecorder" in window)) {
    return null;
  }
  return BROWSER_EXPORT_FORMAT_CANDIDATES.find(format => (
    MediaRecorder.isTypeSupported(format.mimeType)
  )) || null;
}
