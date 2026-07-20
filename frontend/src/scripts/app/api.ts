import { API_BASE_URL } from "../common/config";
import { getApiError } from "../common/errors";
import type { GcsObject, GcsObjectListResponse, LibraryProject, ProjectListResponse } from "../common/types";
import { authFetch } from "./auth";

export async function listJobObjects(jobId: string): Promise<GcsObject[]> {
  const response = await authFetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}/objects`);
  if (!response.ok) {
    throw new Error(await getApiError(response));
  }
  const data = await response.json() as GcsObjectListResponse;
  return data.items || [];
}

export async function listLibraryProjects(): Promise<LibraryProject[]> {
  const response = await authFetch(`${API_BASE_URL}/projects`);
  if (!response.ok) {
    throw new Error(await getApiError(response));
  }
  const data = await response.json() as ProjectListResponse;
  return data.projects.map(project => ({
    title: project.title,
    jobId: project.job_id,
    mediaUrl: project.media_url,
    mediaObject: {
      name: project.media_object_name,
      updated: project.media_updated || undefined,
      size: project.media_size,
      contentType: project.media_content_type,
    },
    renderSourceUrl: project.render_source_url || undefined,
    renderSourceObject: project.render_source_object_name
      ? { name: project.render_source_object_name }
      : undefined,
    subtitleUrl: project.subtitle_url || undefined,
    subtitleObject: project.subtitle_object_name
      ? { name: project.subtitle_object_name }
      : undefined,
  }));
}
