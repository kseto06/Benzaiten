/*
This file contains all the common type defintions used across the frontend scripts
*/

export type BrowserExportFormat = {
  label: "MP4" | "WEBM";
  extension: "mp4" | "webm";
  mimeType: string;
  isFallback: boolean;
};

export type BackendReadinessResponse = {
  status: "ready" | "unavailable";
};

export type EditorRenderCapabilitiesResponse = {
  render_mode: "local" | "k8s";
  pitch_export_supported: boolean;
  browser_subtitle_renderer_supported: boolean;
  detail?: string;
};

export type JobStartResponse = {
  status: "queued";
  job_id: string;
};

export type JobStatusResponse = {
  status: "queued" | "running" | "completed" | "failed";
  job_id: string;
  video_url?: string;
  audio_url?: string;
  subtitle_url?: string | null;
  error?: string;
};

export type SaveProjectResponse = {
  status: "saved";
  title: string;
  media_object_name: string;
  media_url: string;
  render_source_object_name: string;
  render_source_url: string;
  subtitle_object_name: string;
  subtitle_url: string;
  generation: number;
  pitch_semitones: number;
  cleanup_warning?: string;
};

export type CreateProjectResponse = {
  status: "created";
  job_id: string;
  title: string;
  media_object_name: string;
};

export type RenameProjectResponse = {
  status: "renamed";
  title: string;
  media_object_name: string;
  media_url: string;
};

export type DeleteProjectResponse = {
  status: "deleted";
  job_id: string;
  deleted_objects: number;
};

export type ProjectListItemResponse = {
  title: string;
  job_id: string;
  media_object_name: string;
  media_url: string;
  media_updated?: string | null;
  media_size?: string;
  media_content_type?: string;
  subtitle_object_name?: string | null;
  subtitle_url?: string | null;
  render_source_object_name?: string | null;
  render_source_url?: string | null;
  pitch_semitones?: number;
};

export type ProjectListResponse = {
  projects: ProjectListItemResponse[];
};

export type GcsObject = {
  name: string;
  updated?: string;
  size?: string;
  contentType?: string;
};

export type GcsObjectListResponse = {
  items?: GcsObject[];
  nextPageToken?: string;
};

export type ProjectPersistenceMode = "cloud" | "volatile";
export type VolatileProjectReason = "signed_out" | "google_error";

export type EditorProject = {
  title: string;
  originalTitle?: string;
  jobId?: string;
  mediaUrl: string;
  mediaObjectName?: string;
  subtitleUrl?: string;
  subtitleObjectName?: string;
  mediaType: "video" | "audio";
  subtitleFontSize?: number;
  subtitleTransform?: SubtitleTransform;
  volumePercent?: number;
  playbackRate?: number;
  pitchSemitones?: number;
  isBlank?: boolean;
  isLocalMedia?: boolean;
  persistenceMode?: ProjectPersistenceMode;
  volatileReason?: VolatileProjectReason;
  karaokeEnabled?: boolean;
  karaokeHighlightColor?: string;
};

export type LibraryProject = {
  title: string;
  jobId: string;
  mediaObject: GcsObject;
  mediaUrl: string;
  renderSourceObject?: GcsObject;
  renderSourceUrl?: string;
  subtitleObject?: GcsObject;
  subtitleUrl?: string;
  pitchSemitones?: number;
};

export type SubtitleTransform = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

export type SubtitleCue = {
  id: string;
  start: number;
  end: number;
  text: string;
};

export type TimelineSource = {
  id: string;
  name: string;
  type: "video" | "audio";
  url: string;
  start: number;
  duration: number;
  isPrimary: boolean;
  element?: HTMLMediaElement;
};

export type PipelineStage = {
  id: string;
  label: string;
  complete: boolean;
  skipped?: boolean;
};

export type KaraokeToken = {
  text: string;
  weight: number;
  lineBreak?: false;
};

export type KaraokeLineBreak = {
  lineBreak: true;
};

export type TimedKaraokeToken = KaraokeToken & {
  start: number;
  end: number;
};
