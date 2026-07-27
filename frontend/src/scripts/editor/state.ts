import { PROJECT_STORAGE_KEY, VOLATILE_GOOGLE_ERROR_WARNING, VOLATILE_SIGNED_OUT_WARNING } from "../common/config";
import type { EditorProject, LibraryProject, VolatileProjectReason } from "../common/types";

let volatileEditorProject: EditorProject | null = null;

export function editorProjectFromLibraryProject(project: LibraryProject): EditorProject {
  return {
    title: project.title,
    originalTitle: project.title,
    jobId: project.jobId,
    mediaUrl: project.renderSourceUrl || project.mediaUrl,
    mediaObjectName: project.mediaObject.name,
    subtitleUrl: project.subtitleUrl,
    subtitleObjectName: project.subtitleObject?.name,
    pitchSemitones: project.pitchSemitones ?? 0,
    mediaType: "video",
  };
}

export function getVolatileWarning(project: EditorProject): string {
  return project.volatileReason === "google_error"
    ? VOLATILE_GOOGLE_ERROR_WARNING
    : VOLATILE_SIGNED_OUT_WARNING;
}

export function isVolatileProject(project: EditorProject): boolean {
  return project.persistenceMode === "volatile";
}

export function createBlankEditorProject(volatileReason?: VolatileProjectReason): EditorProject {
  return {
    title: "Untitled project",
    mediaUrl: "",
    mediaType: "video",
    isBlank: true,
    isLocalMedia: true,
    persistenceMode: volatileReason ? "volatile" : "cloud",
    volatileReason,
  };
}

export function saveEditorProject(project: EditorProject): void {
  if (isVolatileProject(project)) {
    volatileEditorProject = project;
    return;
  }
  sessionStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(project));
}

export function loadEditorProject(): EditorProject | null {
  if (volatileEditorProject) {
    return volatileEditorProject;
  }
  const rawProject = sessionStorage.getItem(PROJECT_STORAGE_KEY);
  if (!rawProject) {
    return null;
  }
  try {
    return JSON.parse(rawProject) as EditorProject;
  } catch {
    return null;
  }
}

export function clearVolatileEditorProject(): void {
  volatileEditorProject = null;
}
