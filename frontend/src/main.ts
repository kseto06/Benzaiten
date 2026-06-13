import "./style.css";
import editorPageHtml from "./pages/editor.html?raw";
import landingPageHtml from "./pages/landing.html?raw";

const GCS_BUCKET = "benzaiten-outputs";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const PROJECT_STORAGE_KEY = "benzaiten-editor-project";
const LOG_PREFIX = "[Benzaiten]";
let landingDocumentListeners: AbortController | null = null;

type JobStartResponse = {
  status: "queued";
  job_id: string;
};

type JobStatusResponse = {
  status: "queued" | "running" | "completed" | "failed";
  job_id: string;
  video_url?: string;
  audio_url?: string;
  subtitle_url?: string;
  error?: string;
};

type SaveProjectResponse = {
  status: "saved";
  title: string;
  media_object_name: string;
  media_url: string;
  render_source_object_name: string;
  render_source_url: string;
  subtitle_object_name: string;
  subtitle_url: string;
  generation: number;
  cleanup_warning?: string;
};

type RenameProjectResponse = {
  status: "renamed";
  title: string;
  media_object_name: string;
  media_url: string;
};

type DeleteProjectResponse = {
  status: "deleted";
  job_id: string;
  deleted_objects: number;
};

type GcsObject = {
  name: string;
  updated?: string;
  size?: string;
  contentType?: string;
};

type GcsObjectListResponse = {
  items?: GcsObject[];
  nextPageToken?: string;
};

type EditorProject = {
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
};

type LibraryProject = {
  title: string;
  jobId: string;
  mediaObject: GcsObject;
  renderSourceObject?: GcsObject;
  subtitleObject?: GcsObject;
};

type SubtitleTransform = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

type SubtitleCue = {
  id: string;
  start: number;
  end: number;
  text: string;
};

type TimelineSource = {
  id: string;
  name: string;
  type: "video" | "audio";
  url: string;
  start: number;
  duration: number;
  isPrimary: boolean;
  element?: HTMLMediaElement;
};

type PipelineStage = {
  id: string;
  label: string;
  complete: boolean;
  skipped?: boolean;
};

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) {
  throw new Error("Application root is missing");
}
const app = appRoot;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function queryElement<T extends Element>(selector: string, root: ParentNode = document): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function getApiError(response: Response): Promise<string> {
  return response.text().then(body => {
    try {
      const parsed = JSON.parse(body) as { detail?: string };
      return parsed.detail || body || `Request failed with status ${response.status}`;
    } catch {
      return body || `Request failed with status ${response.status}`;
    }
  });
}

function buildGcsObjectUrl(objectName: string): string {
  const encodedName = objectName
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
  return `https://storage.googleapis.com/${GCS_BUCKET}/${encodedName}`;
}

function getGcsObjectName(url?: string): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const parsedUrl = new URL(url);
    const prefix = `/${GCS_BUCKET}/`;
    if (!parsedUrl.pathname.startsWith(prefix)) {
      return undefined;
    }
    return decodeURIComponent(parsedUrl.pathname.slice(prefix.length));
  } catch {
    return undefined;
  }
}

function getObjectFilename(objectName: string): string {
  return objectName.split("/").at(-1) || objectName;
}

function filenameWithoutExtension(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function getSearchBigrams(value: string): Set<string> {
  const compact = value.replace(/\s/g, "");
  if (compact.length < 2) {
    return new Set([compact]);
  }

  const bigrams = new Set<string>();
  for (let index = 0; index < compact.length - 1; index += 1) {
    bigrams.add(compact.slice(index, index + 2));
  }
  return bigrams;
}

function getFuzzyMatchScore(query: string, candidate: string): number {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedCandidate = normalizeSearchText(candidate);
  if (!normalizedQuery || !normalizedCandidate) {
    return 0;
  }
  if (normalizedCandidate === normalizedQuery) {
    return 1;
  }
  if (normalizedCandidate.includes(normalizedQuery)) {
    return 0.96;
  }

  const queryTokens = normalizedQuery.split(" ");
  const candidateTokens = new Set(normalizedCandidate.split(" "));
  const tokenCoverage = (
    queryTokens.filter(token => candidateTokens.has(token)).length / queryTokens.length
  );
  const queryBigrams = getSearchBigrams(normalizedQuery);
  const candidateBigrams = getSearchBigrams(normalizedCandidate);
  const shared = [...queryBigrams].filter(bigram => candidateBigrams.has(bigram));
  const dice = (2 * shared.length) / (queryBigrams.size + candidateBigrams.size);
  return Math.max(tokenCoverage * 0.9, dice);
}

function isSearchableMediaObject(objectName: string): boolean {
  const parts = objectName.split("/");
  const filename = getObjectFilename(objectName).toLocaleLowerCase();
  const extension = filename.split(".").at(-1);
  const intermediates = new Set([
    "input_video.mp4",
    "vocals.mp3",
    "instrumental.mp3",
    "instrumental_(decrowd).mp3",
  ]);

  return (
    parts[0] === "outputs"
    && parts.length >= 3
    && ["mp4", "mp3"].includes(extension || "")
    && !intermediates.has(filename)
    && (parts.length === 3 || parts.includes("final_output"))
  );
}

async function listGcsObjects(prefix = "outputs/"): Promise<GcsObject[]> {
  const objects: GcsObject[] = [];
  let pageToken: string | undefined;

  do {
    const params = new URLSearchParams({
      prefix,
      maxResults: "1000",
      fields: "items(name,updated,size,contentType),nextPageToken",
    });
    if (pageToken) {
      params.set("pageToken", pageToken);
    }

    const response = await fetch(
      `https://storage.googleapis.com/storage/v1/b/${GCS_BUCKET}/o?${params}`,
    );
    if (!response.ok) {
      throw new Error(`GCS listing failed with status ${response.status}`);
    }

    const data = await response.json() as GcsObjectListResponse;
    objects.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);

  return objects;
}

function getLibraryProjects(objects: GcsObject[]): LibraryProject[] {
  return objects
    .filter(object => (
      isSearchableMediaObject(object.name)
      && object.name.toLocaleLowerCase().endsWith(".mp4")
    ))
    .map(mediaObject => {
      const jobId = mediaObject.name.split("/")[1];
      const subtitleObjects = objects
        .filter(object => (
          object.name.startsWith(`outputs/${jobId}/`)
          && object.name.toLocaleLowerCase().endsWith(".vtt")
        ))
        .sort((left, right) => {
          const editorPriority = Number(right.name.includes("/editor/"))
            - Number(left.name.includes("/editor/"));
          return editorPriority || (
            Date.parse(right.updated || "") - Date.parse(left.updated || "")
          );
        });
      return {
        title: filenameWithoutExtension(getObjectFilename(mediaObject.name)),
        jobId,
        mediaObject,
        renderSourceObject: objects.find(
          object => object.name === `outputs/${jobId}/editor/source.mp4`,
        ),
        subtitleObject: subtitleObjects[0],
      };
    })
    .sort((left, right) => (
      Date.parse(right.mediaObject.updated || "") - Date.parse(left.mediaObject.updated || "")
    ));
}

function openLibraryProject(project: LibraryProject): void {
  openEditor({
    title: project.title,
    originalTitle: project.title,
    jobId: project.jobId,
    mediaUrl: buildGcsObjectUrl(
      project.renderSourceObject?.name || project.mediaObject.name,
    ),
    mediaObjectName: project.mediaObject.name,
    subtitleUrl: project.subtitleObject
      ? buildGcsObjectUrl(project.subtitleObject.name)
      : undefined,
    subtitleObjectName: project.subtitleObject?.name,
    mediaType: "video",
  });
}

function saveEditorProject(project: EditorProject): void {
  sessionStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(project));
}

function loadEditorProject(): EditorProject | null {
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

function openEditor(project: EditorProject): void {
  saveEditorProject(project);
  window.location.hash = "editor";
}

function setLandingStatus(message: string, isError = false): void {
  const status = document.querySelector<HTMLParagraphElement>("#statusText");
  if (!status) {
    return;
  }
  status.textContent = message;
  status.classList.toggle("is-error", isError);
  console.log(`${LOG_PREFIX} ${message}`);
}

function renderLanding(): void {
  document.title = "Benzaiten | Karaoke Orchestration Video Maker";
  app.innerHTML = landingPageHtml;
  setupLandingInteractions();
}

function setupLandingInteractions(): void {
  landingDocumentListeners?.abort();
  landingDocumentListeners = new AbortController();
  const documentListenerOptions = { signal: landingDocumentListeners.signal };
  const fileInput = queryElement<HTMLInputElement>("#fileInput");
  const uploadZone = queryElement<HTMLDivElement>("#uploadZone");
  const selectedFile = queryElement<HTMLDivElement>("#selectedFile");
  const shouldDecrowd = queryElement<HTMLInputElement>("#shouldDecrowdInput");
  const fastDecrowd = queryElement<HTMLInputElement>("#fastDecrowdInput");
  const runButton = queryElement<HTMLButtonElement>("#runInferenceButton");
  const searchInput = queryElement<HTMLInputElement>("#videoNameInput");
  const searchButton = queryElement<HTMLButtonElement>("#loadButton");
  const libraryToggle = queryElement<HTMLButtonElement>("#libraryToggle");
  const libraryGallery = queryElement<HTMLDivElement>("#libraryGallery");
  const libraryStatus = queryElement<HTMLDivElement>("#libraryGalleryStatus");
  const libraryGrid = queryElement<HTMLDivElement>("#libraryVideoGrid");
  const deleteDialog = queryElement<HTMLDialogElement>("#deleteProjectDialog");
  const deleteProjectName = queryElement<HTMLElement>("#deleteProjectName");
  const cancelProjectDelete = queryElement<HTMLButtonElement>("#cancelProjectDelete");
  const confirmProjectDelete = queryElement<HTMLButtonElement>("#confirmProjectDelete");
  let libraryProjects: LibraryProject[] | null = null;
  let pendingDelete: { project: LibraryProject; index: number } | null = null;
  setupWorkflowZoom();

  const closeLibraryMenus = (): void => {
    for (const openMenu of libraryGrid.querySelectorAll<HTMLDivElement>(
      ".library-video-menu:not([hidden])",
    )) {
      openMenu.hidden = true;
      openMenu.parentElement
        ?.querySelector<HTMLButtonElement>('[data-library-action="menu"]')
        ?.setAttribute("aria-expanded", "false");
    }
  };

  const showSelectedFile = (): void => {
    const file = fileInput.files?.[0];
    if (!file) {
      selectedFile.classList.remove("is-visible");
      selectedFile.textContent = "";
      return;
    }
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    selectedFile.innerHTML = `
      <span><strong>${escapeHtml(file.name)}</strong><br><small>${sizeMb} MB</small></span>
      <span>Ready</span>
    `;
    selectedFile.classList.add("is-visible");
  };

  fileInput.addEventListener("change", showSelectedFile);
  for (const eventName of ["dragenter", "dragover"]) {
    uploadZone.addEventListener(eventName, () => uploadZone.classList.add("is-dragging"));
  }
  for (const eventName of ["dragleave", "drop"]) {
    uploadZone.addEventListener(eventName, () => uploadZone.classList.remove("is-dragging"));
  }

  shouldDecrowd.addEventListener("change", () => {
    fastDecrowd.disabled = !shouldDecrowd.checked;
    if (fastDecrowd.disabled) {
      fastDecrowd.checked = false;
    }
  });

  runButton.addEventListener("click", () => {
    void handleRunInference();
  });
  searchButton.addEventListener("click", () => {
    void handleLibrarySearch();
  });
  searchInput.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      void handleLibrarySearch();
    }
  });

  const renderLibrary = (projects: LibraryProject[]): void => {
    libraryStatus.hidden = projects.length > 0;
    if (!projects.length) {
      libraryStatus.textContent = "No completed videos were found.";
    }
    libraryGrid.innerHTML = projects.map((project, index) => `
      <article
        class="library-video-card"
        data-library-project="${index}"
      >
        <div class="library-video-thumbnail">
          <button
            class="library-video-open"
            type="button"
            data-library-action="edit"
            aria-label="Open ${escapeHtml(project.title)} in the editor"
          >
            <video
              src="${buildGcsObjectUrl(project.mediaObject.name)}"
              preload="metadata"
              muted
              playsinline
            ></video>
          </button>
          <span class="library-video-duration">--:--</span>
          <div class="library-video-actions">
            <a
              class="library-video-action"
              href="${API_BASE_URL}/projects/download?source_blob_name=${
                encodeURIComponent(project.mediaObject.name)
              }"
              aria-label="Download ${escapeHtml(project.title)} as MP4"
              title="Download MP4"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M12 3v11m0 0 4-4m-4 4-4-4M5 18v2h14v-2"></path>
              </svg>
            </a>
            <button
              class="library-video-action"
              type="button"
              data-library-action="menu"
              aria-label="More options for ${escapeHtml(project.title)}"
              aria-expanded="false"
              aria-haspopup="menu"
              title="More options"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="5" r="1.5"></circle>
                <circle cx="12" cy="12" r="1.5"></circle>
                <circle cx="12" cy="19" r="1.5"></circle>
              </svg>
            </button>
          </div>
        </div>
        <span class="library-video-title">${escapeHtml(project.title)}</span>
        <div class="library-video-rename" hidden>
          <input
            class="library-video-rename-input"
            type="text"
            value="${escapeHtml(project.title)}"
            maxlength="180"
            aria-label="New project name"
          />
          <button
            type="button"
            data-library-action="rename-save"
            aria-label="Save project name"
            title="Save"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m5 12 4 4L19 6"></path>
            </svg>
          </button>
          <button
            type="button"
            data-library-action="rename-cancel"
            aria-label="Cancel rename"
            title="Cancel"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m6 6 12 12M18 6 6 18"></path>
            </svg>
          </button>
        </div>
        <span class="library-video-meta">${
          project.mediaObject.updated
            ? `Updated ${new Date(project.mediaObject.updated).toLocaleDateString()}`
            : "Ready to edit"
        }</span>
        <div class="library-video-menu" hidden>
          <button type="button" data-library-action="edit">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="6" cy="7" r="3"></circle>
              <circle cx="6" cy="17" r="3"></circle>
              <path d="m8.5 8.5 10 8M8.5 15.5l10-8"></path>
            </svg>
            Edit
          </button>
          <button type="button" data-library-action="rename">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m4 20 4.5-1 10-10-3.5-3.5-10 10L4 20Z"></path>
              <path d="m13.5 6.5 3.5 3.5"></path>
            </svg>
            Rename
          </button>
          <button class="is-danger" type="button" data-library-action="delete">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7"></path>
              <path d="M10 11v5m4-5v5"></path>
            </svg>
            Delete
          </button>
        </div>
      </article>
    `).join("");

    for (const video of libraryGrid.querySelectorAll<HTMLVideoElement>("video")) {
      video.addEventListener("loadedmetadata", () => {
        const durationLabel = video.closest(".library-video-thumbnail")
          ?.querySelector<HTMLElement>(".library-video-duration");
        if (durationLabel && Number.isFinite(video.duration)) {
          durationLabel.textContent = formatTime(video.duration);
        }
        video.currentTime = Math.min(1, Math.max(0, video.duration * 0.08));
      }, { once: true });
    }
  };

  const cancelInlineRename = (card: HTMLElement): void => {
    const projectIndex = Number(card.dataset.libraryProject);
    const project = libraryProjects?.[projectIndex];
    const title = card.querySelector<HTMLElement>(".library-video-title");
    const editor = card.querySelector<HTMLDivElement>(".library-video-rename");
    const input = card.querySelector<HTMLInputElement>(".library-video-rename-input");
    if (!project || !title || !editor || !input || editor.hidden) {
      return;
    }
    input.value = project.title;
    input.disabled = false;
    for (const button of editor.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = false;
    }
    editor.hidden = true;
    title.hidden = false;
    card.classList.remove("is-renaming");
  };

  const submitInlineRename = async (
    card: HTMLElement,
    project: LibraryProject,
  ): Promise<void> => {
    const editor = queryElement<HTMLDivElement>(".library-video-rename", card);
    const input = queryElement<HTMLInputElement>(".library-video-rename-input", editor);
    const nextTitle = input.value.trim();
    if (!nextTitle || nextTitle === project.title) {
      cancelInlineRename(card);
      return;
    }

    input.disabled = true;
    for (const button of editor.querySelectorAll<HTMLButtonElement>("button")) {
      button.disabled = true;
    }
    setLandingStatus(`Renaming "${project.title}"...`);
    try {
      const response = await fetch(`${API_BASE_URL}/projects/rename`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_blob_name: project.mediaObject.name,
          title: nextTitle,
        }),
      });
      if (!response.ok) {
        throw new Error(await getApiError(response));
      }
      const renamed = await response.json() as RenameProjectResponse;
      project.title = renamed.title;
      project.mediaObject = {
        ...project.mediaObject,
        name: renamed.media_object_name,
        updated: new Date().toISOString(),
      };
      renderLibrary(libraryProjects || []);
      setLandingStatus(`Renamed project to "${renamed.title}".`);
    } catch (error) {
      input.disabled = false;
      for (const button of editor.querySelectorAll<HTMLButtonElement>("button")) {
        button.disabled = false;
      }
      input.focus();
      input.select();
      const message = error instanceof Error ? error.message : String(error);
      setLandingStatus(`Rename failed: ${message}`, true);
    }
  };

  const closeDeleteDialog = (): void => {
    pendingDelete = null;
    if (deleteDialog.open) {
      deleteDialog.close();
    }
  };

  const deletePendingProject = async (): Promise<void> => {
    if (!pendingDelete) {
      return;
    }
    const { project, index: removedIndex } = pendingDelete;
    pendingDelete = null;
    deleteDialog.close();

    libraryProjects = (libraryProjects || []).filter(
      item => item.jobId !== project.jobId,
    );
    renderLibrary(libraryProjects);
    setLandingStatus(`Deleting "${project.title}" and its related assets...`);

    try {
      const response = await fetch(
        `${API_BASE_URL}/projects/${encodeURIComponent(project.jobId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        throw new Error(await getApiError(response));
      }
      const deleted = await response.json() as DeleteProjectResponse;
      setLandingStatus(
        `Deleted "${project.title}" and ${deleted.deleted_objects} related assets.`,
      );
    } catch (error) {
      const restoredProjects = [...(libraryProjects || [])];
      if (!restoredProjects.some(item => item.jobId === project.jobId)) {
        restoredProjects.splice(
          Math.min(removedIndex, restoredProjects.length),
          0,
          project,
        );
      }
      libraryProjects = restoredProjects;
      renderLibrary(libraryProjects);
      const message = error instanceof Error ? error.message : String(error);
      setLandingStatus(`Delete failed: ${message}`, true);
    }
  };

  cancelProjectDelete.addEventListener("click", closeDeleteDialog);
  confirmProjectDelete.addEventListener("click", () => {
    void deletePendingProject();
  });
  deleteDialog.addEventListener("click", event => {
    if (event.target === deleteDialog) {
      closeDeleteDialog();
    }
  });
  deleteDialog.addEventListener("cancel", event => {
    event.preventDefault();
    closeDeleteDialog();
  });

  libraryToggle.addEventListener("click", async () => {
    const isOpening = libraryToggle.getAttribute("aria-expanded") !== "true";
    libraryToggle.setAttribute("aria-expanded", String(isOpening));
    libraryGallery.hidden = !isOpening;
    if (!isOpening || libraryProjects) {
      return;
    }

    libraryStatus.hidden = false;
    libraryStatus.classList.remove("is-error");
    libraryStatus.textContent = "Loading videos from GCS...";
    try {
      libraryProjects = getLibraryProjects(await listGcsObjects());
      libraryStatus.textContent = libraryProjects.length
        ? ""
        : "No completed videos were found.";
      renderLibrary(libraryProjects);
    } catch (error) {
      libraryStatus.classList.add("is-error");
      libraryStatus.textContent = error instanceof Error
        ? error.message
        : "Unable to load the project library.";
    }
  });

  libraryGrid.addEventListener("click", async event => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>("[data-library-project]");
    const projectIndex = Number(card?.dataset.libraryProject);
    const project = libraryProjects?.[projectIndex];
    const actionElement = target.closest<HTMLElement>("[data-library-action]");
    const action = actionElement?.dataset.libraryAction;
    if (!project || !card || !action) {
      return;
    }

    if (action === "menu") {
      const menu = queryElement<HTMLDivElement>(".library-video-menu", card);
      const menuButton = actionElement as HTMLButtonElement;
      const shouldOpen = menu.hidden;
      closeLibraryMenus();
      menu.hidden = !shouldOpen;
      menuButton.setAttribute("aria-expanded", String(shouldOpen));
      return;
    }

    if (action === "edit") {
      openLibraryProject(project);
      return;
    }

    if (action === "rename") {
      closeLibraryMenus();
      for (const otherCard of libraryGrid.querySelectorAll<HTMLElement>(
        ".library-video-card.is-renaming",
      )) {
        cancelInlineRename(otherCard);
      }
      const title = queryElement<HTMLElement>(".library-video-title", card);
      const editor = queryElement<HTMLDivElement>(".library-video-rename", card);
      const input = queryElement<HTMLInputElement>(".library-video-rename-input", editor);
      title.hidden = true;
      editor.hidden = false;
      card.classList.add("is-renaming");
      input.value = project.title;
      input.focus();
      input.select();
      return;
    }

    if (action === "rename-save") {
      await submitInlineRename(card, project);
      return;
    }

    if (action === "rename-cancel") {
      cancelInlineRename(card);
      return;
    }

    if (action === "delete") {
      closeLibraryMenus();
      pendingDelete = { project, index: projectIndex };
      deleteProjectName.textContent = `"${project.title}"`;
      deleteDialog.showModal();
      cancelProjectDelete.focus();
    }
  });

  libraryGrid.addEventListener("keydown", event => {
    const input = (event.target as HTMLElement).closest<HTMLInputElement>(
      ".library-video-rename-input",
    );
    const card = input?.closest<HTMLElement>("[data-library-project]");
    const project = libraryProjects?.[Number(card?.dataset.libraryProject)];
    if (!input || !card || !project) {
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void submitInlineRename(card, project);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelInlineRename(card);
    }
  });

  document.addEventListener("click", event => {
    const target = event.target as Element;
    if (
      target.closest(".library-video-menu")
      || target.closest('[data-library-action="menu"]')
      || target.closest(".library-video-rename")
    ) {
      return;
    }
    closeLibraryMenus();
    for (const card of libraryGrid.querySelectorAll<HTMLElement>(
      ".library-video-card.is-renaming",
    )) {
      cancelInlineRename(card);
    }
  }, documentListenerOptions);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeLibraryMenus();
      for (const card of libraryGrid.querySelectorAll<HTMLElement>(
        ".library-video-card.is-renaming",
      )) {
        cancelInlineRename(card);
      }
    }
  }, documentListenerOptions);
}

function setupWorkflowZoom(): void {
  const shell = queryElement<HTMLDivElement>(".workflow-canvas-shell");
  const canvas = queryElement<HTMLDivElement>(".workflow-canvas", shell);
  const zoomSurface = document.createElement("div");
  const baseWidth = 1260;
  const baseHeight = 470;
  const minimumScale = 0.5;
  const maximumScale = 1.75;
  let scale = 1;
  let panStart: {
    pointerId: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null = null;

  zoomSurface.className = "workflow-canvas-zoom-surface";
  canvas.replaceWith(zoomSurface);
  zoomSurface.append(canvas);

  const setBoundedScroll = (left: number, top: number): void => {
    const maximumLeft = Math.max(0, shell.scrollWidth - shell.clientWidth);
    const maximumTop = Math.max(0, shell.scrollHeight - shell.clientHeight);
    shell.scrollLeft = clamp(left, 0, maximumLeft);
    shell.scrollTop = clamp(top, 0, maximumTop);
  };

  const applyScale = (nextScale: number, clientX: number, clientY: number): void => {
    const clampedScale = clamp(nextScale, minimumScale, maximumScale);
    if (clampedScale === scale) {
      return;
    }

    const shellRect = shell.getBoundingClientRect();
    const pointerX = clientX - shellRect.left;
    const pointerY = clientY - shellRect.top;
    const contentX = (shell.scrollLeft + pointerX) / scale;
    const contentY = (shell.scrollTop + pointerY) / scale;

    scale = clampedScale;
    zoomSurface.style.width = `${baseWidth * scale}px`;
    zoomSurface.style.height = `${baseHeight * scale}px`;
    canvas.style.transform = `scale(${scale})`;
    setBoundedScroll(
      contentX * scale - pointerX,
      contentY * scale - pointerY,
    );
    shell.setAttribute(
      "aria-label",
      `Benzaiten inference workflow diagram, ${Math.round(scale * 100)}% zoom`,
    );
  };

  shell.addEventListener("wheel", event => {
    event.preventDefault();
    const zoomFactor = Math.exp(-event.deltaY * 0.0015);
    applyScale(scale * zoomFactor, event.clientX, event.clientY);
  }, { passive: false });

  shell.addEventListener("pointerdown", event => {
    if (
      event.button !== 0
      || (event.target as Element).closest(".workflow-node")
    ) {
      return;
    }

    panStart = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: shell.scrollLeft,
      scrollTop: shell.scrollTop,
    };
    shell.setPointerCapture(event.pointerId);
    shell.classList.add("is-panning");
    event.preventDefault();
  });

  shell.addEventListener("pointermove", event => {
    if (!panStart || event.pointerId !== panStart.pointerId) {
      return;
    }
    setBoundedScroll(
      panStart.scrollLeft - (event.clientX - panStart.x),
      panStart.scrollTop - (event.clientY - panStart.y),
    );
  });

  const stopPanning = (event: PointerEvent): void => {
    if (!panStart || event.pointerId !== panStart.pointerId) {
      return;
    }
    if (shell.hasPointerCapture(event.pointerId)) {
      shell.releasePointerCapture(event.pointerId);
    }
    panStart = null;
    shell.classList.remove("is-panning");
  };

  shell.addEventListener("pointerup", stopPanning);
  shell.addEventListener("pointercancel", stopPanning);
}

function renderPipelineStages(stages: PipelineStage[], activeIndex: number): void {
  const stageList = queryElement<HTMLDivElement>("#stageList");
  stageList.innerHTML = stages.map((stage, index) => {
    const classes = [
      "stage-item",
      stage.complete ? "is-complete" : "",
      index === activeIndex && !stage.complete ? "is-active" : "",
      stage.skipped ? "is-skipped" : "",
    ].filter(Boolean).join(" ");
    return `<div class="${classes}" data-stage="${stage.id}">${escapeHtml(stage.label)}</div>`;
  }).join("");
}

function createProgressController(shouldDecrowd: boolean): {
  update: (objects: GcsObject[], status: JobStatusResponse["status"]) => void;
  finish: () => void;
  stop: () => void;
} {
  const panel = queryElement<HTMLDivElement>("#progressPanel");
  const fill = queryElement<HTMLDivElement>("#progressFill");
  const number = queryElement<HTMLSpanElement>("#progressNumber");
  const title = queryElement<HTMLHeadingElement>("#progressTitle");
  const detail = queryElement<HTMLParagraphElement>("#progressDetail");
  let displayed = 4;
  let target = 9;

  panel.classList.add("is-visible");
  const stages: PipelineStage[] = [
    { id: "separate", label: "Separate audio", complete: false },
    {
      id: "decrowd",
      label: shouldDecrowd ? "Reduce crowd" : "Crowd reduction skipped",
      complete: !shouldDecrowd,
      skipped: !shouldDecrowd,
    },
    { id: "transcribe", label: "Transcribe lyrics", complete: false },
    { id: "compose", label: "Compose video", complete: false },
  ];

  const paint = (): void => {
    displayed += (target - displayed) * 0.075;
    if (Math.abs(target - displayed) < 0.15) {
      displayed = target;
    }
    const rounded = Math.round(displayed);
    fill.style.width = `${rounded}%`;
    number.textContent = `${rounded}%`;
  };

  const timer = window.setInterval(() => {
    if (displayed < target) {
      paint();
    } else if (displayed < 94) {
      target = Math.min(94, target + 0.18);
      paint();
    }
  }, 400);

  const update = (objects: GcsObject[], status: JobStatusResponse["status"]): void => {
    const names = objects.map(object => object.name);
    const sourceComplete = names.some(name => (
      name.includes("/source_separation/")
      || name.endsWith("/vocals.mp3")
      || name.endsWith("/instrumental.mp3")
    ));
    const decrowdComplete = !shouldDecrowd || names.some(name => (
      name.includes("/decrowd/")
      || name.endsWith("/instrumental_(decrowd).mp3")
    ));
    const transcriptionComplete = names.some(name => (
      name.includes("/transcription/vocals.vtt")
      || name.endsWith("/vocals.vtt")
    ));
    const compositionComplete = names.some(name => name.endsWith("/result.json"));

    stages[0].complete = sourceComplete;
    stages[1].complete = decrowdComplete;
    stages[2].complete = transcriptionComplete;
    stages[3].complete = compositionComplete;

    const completedCount = stages.filter(stage => stage.complete).length;
    const activeIndex = Math.min(
      stages.findIndex(stage => !stage.complete),
      stages.length - 1,
    );
    renderPipelineStages(stages, activeIndex < 0 ? stages.length - 1 : activeIndex);

    if (compositionComplete || status === "completed") {
      target = 100;
      title.textContent = "Project complete";
      detail.textContent = "Opening the browser editor.";
      return;
    }

    const milestoneFloor = [10, 28, 51, 76, 96][completedCount];
    target = Math.max(target, milestoneFloor);
    if (!sourceComplete) {
      title.textContent = "Separating the performance";
      detail.textContent = "Extracting vocals and instrumental audio.";
    } else if (!decrowdComplete || !transcriptionComplete) {
      title.textContent = "Refining audio and lyrics";
      detail.textContent = shouldDecrowd
        ? "Crowd reduction and transcription are running."
        : "Transcription is running.";
    } else {
      title.textContent = "Composing the final media";
      detail.textContent = "Combining the processed audio, video, and subtitles.";
    }
  };

  renderPipelineStages(stages, 0);
  paint();
  return {
    update,
    finish: () => {
      target = 100;
      displayed = 100;
      paint();
      title.textContent = "Project complete";
      detail.textContent = "Opening the browser editor.";
    },
    stop: () => window.clearInterval(timer),
  };
}

async function handleRunInference(): Promise<void> {
  const fileInput = queryElement<HTMLInputElement>("#fileInput");
  const languageInput = queryElement<HTMLInputElement>("#languageInput");
  const projectNameInput = queryElement<HTMLInputElement>("#projectNameInput");
  const shouldDecrowdInput = queryElement<HTMLInputElement>("#shouldDecrowdInput");
  const fastDecrowdInput = queryElement<HTMLInputElement>("#fastDecrowdInput");
  const runButton = queryElement<HTMLButtonElement>("#runInferenceButton");
  const file = fileInput.files?.[0];
  const language = languageInput.value.trim();

  if (!file) {
    setLandingStatus("Choose a video or audio file first.", true);
    return;
  }
  if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
    setLandingStatus("The selected file must be video or audio.", true);
    return;
  }
  if (!language) {
    setLandingStatus("Enter an audio language code.", true);
    return;
  }

  runButton.disabled = true;
  const progress = createProgressController(shouldDecrowdInput.checked);

  try {
    setLandingStatus("Uploading media and starting orchestration...");
    const formData = new FormData();
    formData.append("file", file);
    formData.append("language", language);
    formData.append("should_decrowd", shouldDecrowdInput.checked ? "true" : "false");
    formData.append(
      "fast_decrowd",
      shouldDecrowdInput.checked && fastDecrowdInput.checked ? "true" : "false",
    );

    const response = await fetch(`${API_BASE_URL}/jobs`, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      throw new Error(await getApiError(response));
    }

    const startData = await response.json() as JobStartResponse;
    localStorage.setItem("job_id", startData.job_id);
    setLandingStatus(`Job ${startData.job_id} is running.`);
    const completed = await pollInferenceJob(startData.job_id, progress);
    if (completed.status === "failed") {
      throw new Error(completed.error || "Inference job failed");
    }

    const mediaUrl = completed.video_url || completed.audio_url;
    if (!mediaUrl) {
      throw new Error("The completed job did not return a media URL");
    }

    progress.finish();
    await new Promise(resolve => window.setTimeout(resolve, 650));
    openEditor({
      title: projectNameInput.value.trim() || filenameWithoutExtension(file.name),
      originalTitle: projectNameInput.value.trim() || filenameWithoutExtension(file.name),
      jobId: startData.job_id,
      mediaUrl,
      mediaObjectName: getGcsObjectName(mediaUrl),
      subtitleUrl: completed.subtitle_url,
      subtitleObjectName: getGcsObjectName(completed.subtitle_url),
      mediaType: completed.video_url ? "video" : "audio",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLandingStatus(`Inference failed: ${message}`, true);
    console.error(`${LOG_PREFIX} Inference failed`, error);
  } finally {
    progress.stop();
    runButton.disabled = false;
  }
}

async function pollInferenceJob(
  jobId: string,
  progress: ReturnType<typeof createProgressController>,
): Promise<JobStatusResponse> {
  while (true) {
    const [statusResponse, jobObjects] = await Promise.all([
      fetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`),
      listGcsObjects(`outputs/${jobId}/`).catch(() => []),
    ]);
    if (!statusResponse.ok) {
      throw new Error(await getApiError(statusResponse));
    }

    const status = await statusResponse.json() as JobStatusResponse;
    progress.update(jobObjects, status.status);
    if (status.status === "completed" || status.status === "failed") {
      return status;
    }
    await new Promise(resolve => window.setTimeout(resolve, 4000));
  }
}

async function handleLibrarySearch(): Promise<void> {
  const input = queryElement<HTMLInputElement>("#videoNameInput");
  const button = queryElement<HTMLButtonElement>("#loadButton");
  const query = input.value.trim();
  if (!query) {
    setLandingStatus("Enter a song or project title.", true);
    return;
  }

  button.disabled = true;
  setLandingStatus(`Searching the project library for "${query}"...`);
  try {
    const projects = getLibraryProjects(await listGcsObjects());
    const matches = projects
      .map(project => ({
        project,
        score: getFuzzyMatchScore(query, project.title),
      }))
      .sort((left, right) => right.score - left.score);
    const match = matches[0];
    if (!match || match.score < 0.45) {
      throw new Error(`No close match was found for "${query}"`);
    }

    console.log(`${LOG_PREFIX} Library match`, {
      query,
      score: match.score,
      media: match.project.mediaObject.name,
      subtitle: match.project.subtitleObject?.name,
    });
    openLibraryProject(match.project);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLandingStatus(message, true);
    console.error(`${LOG_PREFIX} Library search failed`, error);
  } finally {
    button.disabled = false;
  }
}

function parseTimestamp(value: string): number {
  const parts = value.trim().replace(",", ".").split(":").map(Number);
  if (parts.some(Number.isNaN)) {
    return 0;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return parts[0] * 60 + parts[1];
}

function parseSubtitleFile(content: string): SubtitleCue[] {
  const normalized = content.replace(/\r/g, "").replace(/^WEBVTT[^\n]*\n+/, "");
  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").filter(Boolean);
    const timingIndex = lines.findIndex(line => line.includes("-->"));
    if (timingIndex < 0) {
      continue;
    }
    const [startValue, endPart] = lines[timingIndex].split("-->");
    const endValue = endPart.trim().split(/\s+/)[0];
    const start = parseTimestamp(startValue);
    const end = parseTimestamp(endValue);
    const text = lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "");
    if (end > start && text) {
      cues.push({
        id: crypto.randomUUID(),
        start,
        end,
        text,
      });
    }
  }
  return cues;
}

function formatTime(seconds: number, includeMilliseconds = false): string {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.round((safeSeconds % 1) * 1000);
  const base = hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(wholeSeconds).padStart(2, "0")}`;
  return includeMilliseconds ? `${base}.${String(milliseconds).padStart(3, "0")}` : base;
}

function formatVttTimestamp(seconds: number): string {
  const safeSeconds = Math.max(0, seconds);
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const wholeSeconds = Math.floor(safeSeconds % 60);
  const milliseconds = Math.round((safeSeconds % 1) * 1000);
  return (
    `${String(hours).padStart(2, "0")}:`
    + `${String(minutes).padStart(2, "0")}:`
    + `${String(wholeSeconds).padStart(2, "0")}.`
    + String(milliseconds).padStart(3, "0")
  );
}

function renderEditor(project: EditorProject): void {
  document.title = `${project.title} | Benzaiten Editor`;
  app.innerHTML = editorPageHtml
    .replaceAll("{{PROJECT_TITLE}}", escapeHtml(project.title))
    .replace("{{SUBTITLE_FONT_SIZE}}", String(project.subtitleFontSize || 30));
  setupEditor(project);
}

function setupEditor(project: EditorProject): void {
  const editorMain = queryElement<HTMLElement>(".editor-main");
  const editorWorkspace = queryElement<HTMLElement>(".editor-workspace");
  const subtitlePanel = queryElement<HTMLElement>("#subtitlePanel");
  const panelResizer = queryElement<HTMLDivElement>("#panelResizer");
  const panelCollapseButton = queryElement<HTMLButtonElement>("#panelCollapseButton");
  const timelineResizer = queryElement<HTMLDivElement>("#timelineResizer");
  const timelineCollapseButton = queryElement<HTMLButtonElement>("#timelineCollapseButton");
  const projectTitleInput = queryElement<HTMLInputElement>("#projectTitleInput");
  const saveChangesButton = queryElement<HTMLButtonElement>("#saveChangesButton");
  const editorSaveStatus = queryElement<HTMLSpanElement>("#editorSaveStatus");
  const subtitleFontSizeInput = queryElement<HTMLInputElement>("#subtitleFontSizeInput");
  const media = queryElement<HTMLVideoElement>("#editorMedia");
  const previewStage = queryElement<HTMLDivElement>(".preview-stage");
  const audioPreview = queryElement<HTMLDivElement>("#audioPreview");
  const audioPreviewTitle = queryElement<HTMLElement>("#audioPreview strong");
  const subtitleList = queryElement<HTMLDivElement>("#subtitleList");
  const subtitleTransformBox = queryElement<HTMLDivElement>("#subtitleTransformBox");
  const overlay = queryElement<HTMLDivElement>("#subtitleOverlay");
  const timelineContent = queryElement<HTMLDivElement>("#timelineContent");
  const timelineShell = queryElement<HTMLDivElement>("#timelineShell");
  const timelineScroll = queryElement<HTMLDivElement>("#timelineScroll");
  const playButton = queryElement<HTMLButtonElement>("#playButton");
  const timeDisplay = queryElement<HTMLSpanElement>("#timeDisplay");
  const zoomInput = queryElement<HTMLInputElement>("#zoomInput");
  let cues: SubtitleCue[] = [];
  let sources: TimelineSource[] = [];
  let duration = 120;
  let zoom = Number(zoomInput.value);
  let selectedCueId: string | null = null;
  let selectedSourceId: string | null = null;
  let activeCueId: string | null = null;
  let previousSidebarWidth = 350;
  let previousTimelineHeight = 300;
  let mediaReady = false;
  let subtitlesReady = false;
  const subtitleTransform: SubtitleTransform = {
    x: project.subtitleTransform?.x ?? 50,
    y: project.subtitleTransform?.y ?? 82,
    width: project.subtitleTransform?.width ?? 82,
    height: project.subtitleTransform?.height ?? 22,
    rotation: project.subtitleTransform?.rotation ?? 0,
  };

  media.src = project.mediaUrl;
  media.style.display = project.mediaType === "video" ? "block" : "none";
  audioPreview.classList.toggle("is-visible", project.mediaType === "audio");
  overlay.style.fontSize = `${project.subtitleFontSize || 30}px`;

  const updateSaveAvailability = (): void => {
    saveChangesButton.disabled = (
      project.mediaType !== "video"
      || !mediaReady
      || !subtitlesReady
    );
  };

  const persistSubtitleTransform = (): void => {
    project.subtitleTransform = { ...subtitleTransform };
    saveEditorProject(project);
  };

  const applySubtitleTransform = (): void => {
    subtitleTransformBox.style.left = `${subtitleTransform.x}%`;
    subtitleTransformBox.style.top = `${subtitleTransform.y}%`;
    subtitleTransformBox.style.width = `${subtitleTransform.width}%`;
    subtitleTransformBox.style.height = `${subtitleTransform.height}%`;
    subtitleTransformBox.style.transform = (
      `translate(-50%, -50%) rotate(${subtitleTransform.rotation}deg)`
    );
  };

  applySubtitleTransform();

  const getTimelineWidth = (): number => Math.max(900, Math.ceil(duration * zoom));
  const pixelsPerSecond = (): number => getTimelineWidth() / duration;

  const activeCueAt = (time: number): SubtitleCue | undefined => (
    cues.find(cue => time >= cue.start && time <= cue.end)
  );

  const syncSubtitleSelection = (scrollIntoView = false): void => {
    for (const card of subtitleList.querySelectorAll<HTMLElement>(".subtitle-card")) {
      card.classList.toggle("is-active", card.dataset.cueId === selectedCueId);
    }
    if (scrollIntoView && selectedCueId) {
      window.requestAnimationFrame(() => {
        subtitleList
          .querySelector<HTMLElement>(`[data-cue-id="${CSS.escape(selectedCueId || "")}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    }
  };

  const updatePreview = (): void => {
    const currentTime = media.currentTime || 0;
    const activeCue = activeCueAt(currentTime);
    overlay.textContent = activeCue?.text || "";
    if (activeCue?.id !== activeCueId) {
      activeCueId = activeCue?.id || null;
      if (activeCue) {
        selectedCueId = activeCue.id;
        syncSubtitleSelection();
      }
    }
    timeDisplay.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
    const playhead = timelineContent.querySelector<HTMLDivElement>(".playhead");
    if (playhead) {
      playhead.style.left = `${118 + currentTime * pixelsPerSecond()}px`;
    }

    for (const source of sources) {
      if (source.isPrimary || !source.element) {
        continue;
      }
      const sourceTime = currentTime - source.start;
      const shouldPlay = sourceTime >= 0 && sourceTime <= source.duration && !media.paused;
      if (shouldPlay) {
        if (Math.abs(source.element.currentTime - sourceTime) > 0.35) {
          source.element.currentTime = sourceTime;
        }
        void source.element.play().catch(() => undefined);
      } else {
        source.element.pause();
      }
    }
  };

  const renderSubtitleList = (): void => {
    if (cues.length === 0) {
      subtitleList.innerHTML = `
        <div class="empty-subtitles">
          No subtitle cues were found. Add a cue to begin editing.
        </div>
      `;
      return;
    }

    subtitleList.innerHTML = cues.map(cue => `
      <article class="subtitle-card ${cue.id === selectedCueId ? "is-active" : ""}" data-cue-id="${cue.id}">
        <div class="subtitle-time-row">
          <div class="subtitle-time">
            <input class="time-input" data-time="start" value="${cue.start.toFixed(2)}" aria-label="Start seconds" />
            <span>to</span>
            <input class="time-input" data-time="end" value="${cue.end.toFixed(2)}" aria-label="End seconds" />
          </div>
          <button class="icon-button" data-delete-cue="${cue.id}" title="Delete subtitle">x</button>
        </div>
        <textarea data-cue-text="${cue.id}" aria-label="Subtitle text">${escapeHtml(cue.text)}</textarea>
      </article>
    `).join("");
    syncSubtitleSelection();
  };

  const drawWaveform = (canvas: HTMLCanvasElement, samples?: Float32Array): void => {
    const context = canvas.getContext("2d");
    if (!context) {
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const width = Math.max(120, Math.min(6000, Math.round(bounds.width || getTimelineWidth())));
    const height = Math.max(36, Math.round(bounds.height || 46));
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(255, 255, 255, 0.62)";
    const center = height / 2;
    const bars = Math.min(900, Math.floor(width / 3));

    for (let index = 0; index < bars; index += 1) {
      let amplitude: number;
      if (samples && samples.length > 0) {
        const start = Math.floor((index / bars) * samples.length);
        const end = Math.max(start + 1, Math.floor(((index + 1) / bars) * samples.length));
        let peak = 0;
        for (let sampleIndex = start; sampleIndex < end; sampleIndex += 1) {
          peak = Math.max(peak, Math.abs(samples[sampleIndex]));
        }
        amplitude = peak;
      } else {
        amplitude = 0.22 + Math.abs(Math.sin(index * 0.37) * 0.55);
      }
      const barHeight = Math.min(height - 2, Math.max(2, amplitude * (height - 6) * 1.2));
      const x = (index / bars) * width;
      context.fillRect(x, center - barHeight / 2, Math.max(1, width / bars - 1), barHeight);
    }
  };

  let waveformSamples: Float32Array | undefined;

  const renderTimeline = (): void => {
    const width = getTimelineWidth();
    const interval = duration > 300 ? 30 : duration > 120 ? 15 : 10;
    const rulerMarks: string[] = [];
    for (let second = 0; second <= duration; second += interval) {
      rulerMarks.push(
        `<span class="ruler-mark" style="left:${second * pixelsPerSecond()}px">${formatTime(second)}</span>`,
      );
    }

    const sourceRows = sources.map(source => {
      const sourceClass = source.type === "video" ? "video-clip" : "audio-clip";
      return `
        <div class="track-row ${source.type === "audio" ? "audio-track" : ""}">
          <div class="track-label">${source.type === "video" ? "Video" : "Audio"}</div>
          <div class="track-lane" style="width:${width}px">
            <div
              class="clip ${sourceClass} ${source.id === selectedSourceId ? "is-selected" : ""}"
              data-source-id="${source.id}"
              style="left:${source.start * pixelsPerSecond()}px;width:${Math.max(20, source.duration * pixelsPerSecond())}px"
            >
              ${source.type === "audio" ? `<canvas class="waveform" data-waveform="${source.id}"></canvas>` : ""}
              <span class="resize-handle left" data-resize="left"></span>
              <span class="clip-label">${escapeHtml(source.name)}</span>
              <span class="resize-handle right" data-resize="right"></span>
            </div>
          </div>
        </div>
      `;
    }).join("");

    const subtitleClips = cues.map(cue => `
      <div
        class="clip subtitle-clip ${cue.id === selectedCueId ? "is-selected" : ""}"
        data-cue-clip="${cue.id}"
        style="left:${cue.start * pixelsPerSecond()}px;width:${Math.max(18, (cue.end - cue.start) * pixelsPerSecond())}px"
      >
        <span class="resize-handle left" data-resize="left"></span>
        <span class="clip-label">${escapeHtml(cue.text)}</span>
        <span class="resize-handle right" data-resize="right"></span>
      </div>
    `).join("");

    timelineContent.innerHTML = `
      <div class="timeline-ruler">
        <div class="ruler-label">Timeline</div>
        <div class="ruler-lane" style="width:${width}px">${rulerMarks.join("")}</div>
      </div>
      <div class="track-row subtitle-track">
        <div class="track-label">Subtitles</div>
        <div class="track-lane" style="width:${width}px">${subtitleClips}</div>
      </div>
      ${sourceRows}
      <div class="playhead" style="left:${118 + media.currentTime * pixelsPerSecond()}px"></div>
    `;

    for (const canvas of timelineContent.querySelectorAll<HTMLCanvasElement>(".waveform")) {
      const sourceId = canvas.dataset.waveform;
      const source = sources.find(item => item.id === sourceId);
      drawWaveform(canvas, source?.isPrimary ? waveformSamples : undefined);
    }
  };

  const seekToCue = (cue: SubtitleCue): void => {
    selectedCueId = cue.id;
    media.currentTime = cue.start;
    updatePreview();
    renderTimeline();
    syncSubtitleSelection(true);
  };

  subtitleList.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const deleteId = target.dataset.deleteCue;
    if (deleteId) {
      cues = cues.filter(cue => cue.id !== deleteId);
      if (selectedCueId === deleteId) {
        selectedCueId = null;
      }
      renderSubtitleList();
      renderTimeline();
      updatePreview();
      return;
    }
    if (target.matches("textarea, input, button")) {
      return;
    }
    const card = target.closest<HTMLElement>(".subtitle-card");
    if (card?.dataset.cueId) {
      const cue = cues.find(item => item.id === card.dataset.cueId);
      if (cue) {
        seekToCue(cue);
      }
    }
  });

  subtitleList.addEventListener("focusin", event => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>(".subtitle-card");
    if (!card?.dataset.cueId) {
      return;
    }
    selectedCueId = card.dataset.cueId;
    const cue = cues.find(item => item.id === selectedCueId);
    if (cue) {
      media.currentTime = cue.start;
    }
    syncSubtitleSelection();
    renderTimeline();
    updatePreview();
  });

  subtitleList.addEventListener("input", event => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    const card = target.closest<HTMLElement>(".subtitle-card");
    const cue = cues.find(item => item.id === card?.dataset.cueId);
    if (!cue) {
      return;
    }
    if (target.dataset.cueText) {
      cue.text = target.value;
    } else if (target.dataset.time === "start") {
      cue.start = clamp(Number(target.value) || 0, 0, Math.max(0, cue.end - 0.1));
    } else if (target.dataset.time === "end") {
      cue.end = clamp(Number(target.value) || cue.start + 0.1, cue.start + 0.1, duration);
    }
    renderTimeline();
    updatePreview();
  });

  queryElement<HTMLButtonElement>("#addSubtitleButton").addEventListener("click", () => {
    const start = clamp(media.currentTime, 0, Math.max(0, duration - 1));
    const cue: SubtitleCue = {
      id: crypto.randomUUID(),
      start,
      end: Math.min(duration, start + 3),
      text: "New subtitle",
    };
    cues.push(cue);
    cues.sort((left, right) => left.start - right.start);
    selectedCueId = cue.id;
    renderSubtitleList();
    renderTimeline();
  });

  projectTitleInput.addEventListener("input", () => {
    const nextTitle = projectTitleInput.value.trim() || "Untitled project";
    const previousTitle = project.title;
    project.title = nextTitle;
    document.title = `${nextTitle} | Benzaiten Editor`;
    audioPreviewTitle.textContent = nextTitle;
    for (const source of sources) {
      if (!source.isPrimary) {
        continue;
      }
      source.name = source.type === "audio" && project.mediaType === "video"
        ? `${nextTitle} - program audio`
        : nextTitle;
    }
    saveEditorProject(project);
    if (previousTitle !== nextTitle) {
      renderTimeline();
    }
  });
  projectTitleInput.addEventListener("blur", () => {
    if (!projectTitleInput.value.trim()) {
      projectTitleInput.value = project.title;
    }
  });

  subtitleFontSizeInput.addEventListener("input", () => {
    const fontSize = clamp(Number(subtitleFontSizeInput.value) || 30, 12, 72);
    project.subtitleFontSize = fontSize;
    overlay.style.fontSize = `${fontSize}px`;
    saveEditorProject(project);
  });

  const selectSubtitleTransformBox = (): void => {
    subtitleTransformBox.classList.add("is-selected");
    subtitleTransformBox.focus({ preventScroll: true });
  };

  const rotateVector = (x: number, y: number, angleDegrees: number): {
    x: number;
    y: number;
  } => {
    const angle = angleDegrees * Math.PI / 180;
    return {
      x: x * Math.cos(angle) - y * Math.sin(angle),
      y: x * Math.sin(angle) + y * Math.cos(angle),
    };
  };

  const beginSubtitleTransform = (
    event: PointerEvent,
    mode: "move" | "resize" | "rotate",
    resizeDirection = "",
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    selectSubtitleTransformBox();

    const stageBounds = previewStage.getBoundingClientRect();
    const original = { ...subtitleTransform };
    const originalCenter = {
      x: stageBounds.width * original.x / 100,
      y: stageBounds.height * original.y / 100,
    };
    const originalSize = {
      width: stageBounds.width * original.width / 100,
      height: stageBounds.height * original.height / 100,
    };
    const startPointer = {
      x: event.clientX - stageBounds.left,
      y: event.clientY - stageBounds.top,
    };
    const startRotationAngle = Math.atan2(
      startPointer.y - originalCenter.y,
      startPointer.x - originalCenter.x,
    ) * 180 / Math.PI;

    const onMove = (moveEvent: PointerEvent): void => {
      const pointer = {
        x: moveEvent.clientX - stageBounds.left,
        y: moveEvent.clientY - stageBounds.top,
      };

      if (mode === "move") {
        subtitleTransform.x = clamp(
          (originalCenter.x + pointer.x - startPointer.x) / stageBounds.width * 100,
          0,
          100,
        );
        subtitleTransform.y = clamp(
          (originalCenter.y + pointer.y - startPointer.y) / stageBounds.height * 100,
          0,
          100,
        );
      } else if (mode === "rotate") {
        const currentAngle = Math.atan2(
          pointer.y - originalCenter.y,
          pointer.x - originalCenter.x,
        ) * 180 / Math.PI;
        subtitleTransform.rotation = (
          (original.rotation + currentAngle - startRotationAngle + 540) % 360 - 180
        );
      } else {
        const pointerDelta = rotateVector(
          pointer.x - startPointer.x,
          pointer.y - startPointer.y,
          -original.rotation,
        );
        let left = -originalSize.width / 2;
        let right = originalSize.width / 2;
        let top = -originalSize.height / 2;
        let bottom = originalSize.height / 2;

        if (resizeDirection.includes("w")) {
          left = Math.min(left + pointerDelta.x, right - 48);
        }
        if (resizeDirection.includes("e")) {
          right = Math.max(right + pointerDelta.x, left + 48);
        }
        if (resizeDirection.includes("n")) {
          top = Math.min(top + pointerDelta.y, bottom - 32);
        }
        if (resizeDirection.includes("s")) {
          bottom = Math.max(bottom + pointerDelta.y, top + 32);
        }

        const localCenterShift = {
          x: (left + right) / 2,
          y: (top + bottom) / 2,
        };
        const centerShift = rotateVector(
          localCenterShift.x,
          localCenterShift.y,
          original.rotation,
        );
        subtitleTransform.x = clamp(
          (originalCenter.x + centerShift.x) / stageBounds.width * 100,
          0,
          100,
        );
        subtitleTransform.y = clamp(
          (originalCenter.y + centerShift.y) / stageBounds.height * 100,
          0,
          100,
        );
        subtitleTransform.width = clamp(
          (right - left) / stageBounds.width * 100,
          5,
          120,
        );
        subtitleTransform.height = clamp(
          (bottom - top) / stageBounds.height * 100,
          5,
          100,
        );
      }

      applySubtitleTransform();
    };

    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      persistSubtitleTransform();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  subtitleTransformBox.addEventListener("pointerdown", event => {
    const target = event.target as HTMLElement;
    const resizeHandle = target.closest<HTMLElement>("[data-subtitle-resize]");
    if (resizeHandle?.dataset.subtitleResize) {
      beginSubtitleTransform(event, "resize", resizeHandle.dataset.subtitleResize);
      return;
    }
    if (target.closest("[data-subtitle-rotate]")) {
      beginSubtitleTransform(event, "rotate");
      return;
    }
    beginSubtitleTransform(event, "move");
  });

  subtitleTransformBox.addEventListener("dblclick", event => {
    event.stopPropagation();
    if (!selectedCueId) {
      return;
    }
    subtitleList
      .querySelector<HTMLTextAreaElement>(`[data-cue-text="${CSS.escape(selectedCueId)}"]`)
      ?.focus();
  });

  previewStage.addEventListener("pointerdown", event => {
    if (!(event.target as HTMLElement).closest("#subtitleTransformBox")) {
      subtitleTransformBox.classList.remove("is-selected");
    }
  });

  queryElement<HTMLButtonElement>("#exportVttButton").addEventListener("click", () => {
    const body = cues
      .sort((left, right) => left.start - right.start)
      .map((cue, index) => (
        `${index + 1}\n${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(cue.end)}\n${cue.text}`
      ))
      .join("\n\n");
    const blob = new Blob([`WEBVTT\n\n${body}\n`], { type: "text/vtt" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${project.title.replace(/[^\p{L}\p{N}]+/gu, "-") || "subtitles"}.vtt`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  saveChangesButton.addEventListener("click", async () => {
    const sourceBlobName = project.mediaObjectName || getGcsObjectName(project.mediaUrl);
    const hasAddedMedia = sources.some(source => !source.isPrimary);
    const hasTimelineMediaChanges = sources.some(source => (
      source.isPrimary
      && (Math.abs(source.start) > 0.01 || Math.abs(source.duration - media.duration) > 0.05)
    ));

    editorSaveStatus.classList.remove("is-error");
    if (project.mediaType !== "video" || !sourceBlobName) {
      editorSaveStatus.textContent = "Only GCS video projects can currently be saved.";
      editorSaveStatus.classList.add("is-error");
      return;
    }
    if (hasAddedMedia || hasTimelineMediaChanges) {
      editorSaveStatus.textContent = (
        "Saving added or trimmed media tracks is not supported yet. "
        + "Reset those tracks before saving."
      );
      editorSaveStatus.classList.add("is-error");
      return;
    }

    saveChangesButton.disabled = true;
    saveChangesButton.textContent = "Saving...";
    editorSaveStatus.textContent = "";
    try {
      const response = await fetch(`${API_BASE_URL}/projects/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source_blob_name: sourceBlobName,
          title: project.title,
          cues: cues.map(cue => ({
            start: cue.start,
            end: cue.end,
            text: cue.text,
          })),
          subtitle_font_size: project.subtitleFontSize || 30,
          subtitle_transform: subtitleTransform,
        }),
      });
      if (!response.ok) {
        throw new Error(await getApiError(response));
      }

      const saved = await response.json() as SaveProjectResponse;
      project.title = saved.title;
      project.originalTitle = saved.title;
      project.mediaObjectName = saved.media_object_name;
      project.mediaUrl = saved.render_source_url;
      project.subtitleObjectName = saved.subtitle_object_name;
      project.subtitleUrl = saved.subtitle_url;
      projectTitleInput.value = saved.title;
      document.title = `${saved.title} | Benzaiten Editor`;
      saveEditorProject(project);
      editorSaveStatus.textContent = saved.cleanup_warning || "Changes saved!";
      editorSaveStatus.classList.toggle("is-error", Boolean(saved.cleanup_warning));
    } catch (error) {
      editorSaveStatus.textContent = error instanceof Error
        ? error.message
        : "Unable to save changes.";
      editorSaveStatus.classList.add("is-error");
      console.error(`${LOG_PREFIX} Project save failed`, error);
    } finally {
      updateSaveAvailability();
      saveChangesButton.textContent = "Save changes";
    }
  });

  queryElement<HTMLButtonElement>("#backButton").addEventListener("click", () => {
    window.location.hash = "";
  });

  const setPlayButtonState = (isPlaying: boolean): void => {
    playButton.title = isPlaying ? "Pause" : "Play";
    playButton.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    playButton.innerHTML = isPlaying
      ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h3v10H8V7Zm5 0h3v10h-3V7Z"/></svg>`
      : `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 7 8 5-8 5V7Z"/></svg>`;
  };

  playButton.addEventListener("click", () => {
    if (media.paused) {
      void media.play();
    } else {
      media.pause();
    }
  });
  queryElement<HTMLButtonElement>("#skipBackButton").addEventListener("click", () => {
    media.currentTime = Math.max(0, media.currentTime - 5);
  });
  queryElement<HTMLButtonElement>("#skipForwardButton").addEventListener("click", () => {
    media.currentTime = Math.min(duration, media.currentTime + 5);
  });
  zoomInput.addEventListener("input", () => {
    zoom = Number(zoomInput.value);
    renderTimeline();
  });

  media.addEventListener("play", () => {
    setPlayButtonState(true);
  });
  media.addEventListener("pause", () => {
    setPlayButtonState(false);
    for (const source of sources) {
      source.element?.pause();
    }
  });
  media.addEventListener("timeupdate", updatePreview);
  media.addEventListener("seeked", updatePreview);
  media.addEventListener("loadedmetadata", () => {
    duration = Number.isFinite(media.duration) ? media.duration : duration;
    mediaReady = true;
    updateSaveAvailability();
    const primarySource: TimelineSource = {
      id: crypto.randomUUID(),
      name: project.title,
      type: project.mediaType,
      url: project.mediaUrl,
      start: 0,
      duration,
      isPrimary: true,
    };
    sources = [primarySource];
    if (project.mediaType === "video") {
      sources.push({
        id: crypto.randomUUID(),
        name: `${project.title} - program audio`,
        type: "audio",
        url: project.mediaUrl,
        start: 0,
        duration,
        isPrimary: true,
      });
    }
    renderTimeline();
    updatePreview();
    void buildWaveform(project.mediaUrl).then(samples => {
      waveformSamples = samples;
      renderTimeline();
    });
  });

  const beginTimelineDrag = (
    event: PointerEvent,
    kind: "cue" | "source",
    id: string,
    mode: "move" | "left" | "right",
  ): void => {
    event.preventDefault();
    (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const cue = kind === "cue" ? cues.find(item => item.id === id) : undefined;
    const source = kind === "source" ? sources.find(item => item.id === id) : undefined;
    if (!cue && !source) {
      return;
    }
    const originalStart = cue?.start ?? source?.start ?? 0;
    const originalEnd = cue?.end ?? ((source?.start || 0) + (source?.duration || 0));
    const dragPixelsPerSecond = pixelsPerSecond();
    if (cue) {
      selectedCueId = cue.id;
      syncSubtitleSelection(true);
    }
    if (source) {
      selectedSourceId = source.id;
    }

    const onMove = (moveEvent: PointerEvent): void => {
      const deltaSeconds = (moveEvent.clientX - startX) / dragPixelsPerSecond;
      if (cue) {
        const cueDuration = originalEnd - originalStart;
        if (mode === "move") {
          cue.start = clamp(originalStart + deltaSeconds, 0, duration - cueDuration);
          cue.end = cue.start + cueDuration;
        } else if (mode === "left") {
          cue.start = clamp(originalStart + deltaSeconds, 0, cue.end - 0.1);
        } else {
          cue.end = clamp(originalEnd + deltaSeconds, cue.start + 0.1, duration);
        }
        selectedCueId = cue.id;
      }
      if (source) {
        if (mode === "move") {
          source.start = Math.max(0, originalStart + deltaSeconds);
          duration = Math.max(duration, source.start + source.duration);
        } else if (mode === "left") {
          const newStart = clamp(
            originalStart + deltaSeconds,
            0,
            originalEnd - 0.25,
          );
          source.duration = originalEnd - newStart;
          source.start = newStart;
        } else {
          source.duration = clamp(
            originalEnd + deltaSeconds - source.start,
            0.25,
            duration - source.start,
          );
        }
        selectedSourceId = source.id;
      }
      renderTimeline();
    };

    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      renderSubtitleList();
      renderTimeline();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  timelineContent.addEventListener("pointerdown", event => {
    const target = event.target as HTMLElement;
    const cueClip = target.closest<HTMLElement>("[data-cue-clip]");
    const sourceClip = target.closest<HTMLElement>("[data-source-id]");
    const resize = target.dataset.resize as "left" | "right" | undefined;
    if (cueClip?.dataset.cueClip) {
      beginTimelineDrag(event, "cue", cueClip.dataset.cueClip, resize || "move");
    } else if (sourceClip?.dataset.sourceId) {
      beginTimelineDrag(event, "source", sourceClip.dataset.sourceId, resize || "move");
    }
  });

  timelineContent.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const cueClip = target.closest<HTMLElement>("[data-cue-clip]");
    if (cueClip?.dataset.cueClip) {
      const cue = cues.find(item => item.id === cueClip.dataset.cueClip);
      if (cue) {
        seekToCue(cue);
      }
      return;
    }
    if (target.closest(".clip")) {
      return;
    }
    const lane = target.closest<HTMLElement>(".track-lane, .ruler-lane");
    if (!lane) {
      return;
    }
    const bounds = lane.getBoundingClientRect();
    media.currentTime = clamp((event.clientX - bounds.left) / pixelsPerSecond(), 0, duration);
  });

  timelineScroll.addEventListener("wheel", event => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    const bounds = timelineScroll.getBoundingClientRect();
    const pointerX = event.clientX - bounds.left + timelineScroll.scrollLeft - 118;
    const anchorTime = clamp(pointerX / pixelsPerSecond(), 0, duration);
    const direction = event.deltaY < 0 ? 1 : -1;
    zoom = clamp(zoom + direction * Math.max(0.5, Math.abs(event.deltaY) / 180), 4, 20);
    zoomInput.value = zoom.toFixed(1);
    renderTimeline();
    timelineScroll.scrollLeft = Math.max(
      0,
      118 + anchorTime * pixelsPerSecond() - (event.clientX - bounds.left),
    );
  }, { passive: false });

  const setSidebarWidth = (width: number): void => {
    const maximum = Math.max(320, editorMain.clientWidth * 0.62);
    const clampedWidth = clamp(width, 250, maximum);
    editorMain.style.setProperty("--subtitle-panel-width", `${clampedWidth}px`);
    previousSidebarWidth = clampedWidth;
    editorMain.classList.remove("is-sidebar-collapsed");
    panelCollapseButton.title = "Collapse subtitle panel";
    panelCollapseButton.setAttribute("aria-label", "Collapse subtitle panel");
    panelCollapseButton.innerHTML = `<span aria-hidden="true">&lsaquo;</span>`;
  };

  panelResizer.addEventListener("pointerdown", event => {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }
    event.preventDefault();
    panelResizer.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = subtitlePanel.getBoundingClientRect().width;

    const onMove = (moveEvent: PointerEvent): void => {
      setSidebarWidth(startWidth + moveEvent.clientX - startX);
    };
    const onUp = (): void => {
      panelResizer.removeEventListener("pointermove", onMove);
      panelResizer.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-panel");
    };

    document.body.classList.add("is-resizing-panel");
    panelResizer.addEventListener("pointermove", onMove);
    panelResizer.addEventListener("pointerup", onUp);
  });

  panelCollapseButton.addEventListener("click", () => {
    const isCollapsed = editorMain.classList.toggle("is-sidebar-collapsed");
    if (isCollapsed) {
      const currentWidth = subtitlePanel.getBoundingClientRect().width;
      if (currentWidth > 100) {
        previousSidebarWidth = currentWidth;
      }
      panelCollapseButton.title = "Expand subtitle panel";
      panelCollapseButton.setAttribute("aria-label", "Expand subtitle panel");
      panelCollapseButton.innerHTML = `<span aria-hidden="true">&rsaquo;</span>`;
    } else {
      setSidebarWidth(previousSidebarWidth);
    }
  });

  const setTimelineHeight = (height: number): void => {
    const maximum = Math.max(220, editorWorkspace.clientHeight * 0.7);
    const clampedHeight = clamp(height, 150, maximum);
    editorWorkspace.style.setProperty("--timeline-panel-height", `${clampedHeight}px`);
    previousTimelineHeight = clampedHeight;
    editorWorkspace.classList.remove("is-timeline-collapsed");
    timelineCollapseButton.title = "Collapse timeline";
    timelineCollapseButton.setAttribute("aria-label", "Collapse timeline");
    timelineCollapseButton.innerHTML = `<span aria-hidden="true">&darr;</span>`;
  };

  timelineResizer.addEventListener("pointerdown", event => {
    if ((event.target as HTMLElement).closest("button")) {
      return;
    }
    event.preventDefault();
    timelineResizer.setPointerCapture(event.pointerId);
    const startY = event.clientY;
    const startHeight = timelineShell.getBoundingClientRect().height;

    const onMove = (moveEvent: PointerEvent): void => {
      setTimelineHeight(startHeight + startY - moveEvent.clientY);
    };
    const onUp = (): void => {
      timelineResizer.removeEventListener("pointermove", onMove);
      timelineResizer.removeEventListener("pointerup", onUp);
      document.body.classList.remove("is-resizing-timeline");
    };

    document.body.classList.add("is-resizing-timeline");
    timelineResizer.addEventListener("pointermove", onMove);
    timelineResizer.addEventListener("pointerup", onUp);
  });

  timelineCollapseButton.addEventListener("click", () => {
    const isCollapsed = editorWorkspace.classList.toggle("is-timeline-collapsed");
    if (isCollapsed) {
      const currentHeight = timelineShell.getBoundingClientRect().height;
      if (currentHeight > 100) {
        previousTimelineHeight = currentHeight;
      }
      timelineCollapseButton.title = "Expand timeline";
      timelineCollapseButton.setAttribute("aria-label", "Expand timeline");
      timelineCollapseButton.innerHTML = `<span aria-hidden="true">&uarr;</span>`;
    } else {
      setTimelineHeight(previousTimelineHeight);
    }
  });

  for (const eventName of ["dragenter", "dragover"]) {
    timelineShell.addEventListener(eventName, event => {
      event.preventDefault();
      timelineShell.classList.add("is-dragging");
    });
  }
  for (const eventName of ["dragleave", "drop"]) {
    timelineShell.addEventListener(eventName, event => {
      event.preventDefault();
      timelineShell.classList.remove("is-dragging");
    });
  }
  timelineShell.addEventListener("drop", event => {
    const files = [...(event.dataTransfer?.files || [])];
    for (const file of files) {
      if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
        continue;
      }
      const url = URL.createObjectURL(file);
      const element = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
      element.src = url;
      element.preload = "metadata";
      element.addEventListener("loadedmetadata", () => {
        const sourceDuration = Number.isFinite(element.duration) ? element.duration : 10;
        sources.push({
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type.startsWith("video/") ? "video" : "audio",
          url,
          start: clamp(media.currentTime, 0, duration),
          duration: Math.min(sourceDuration, Math.max(0.25, duration - media.currentTime)),
          isPrimary: false,
          element,
        });
        renderTimeline();
      }, { once: true });
    }
  });

  async function buildWaveform(url: string): Promise<Float32Array | undefined> {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return undefined;
      }
      const buffer = await response.arrayBuffer();
      const audioContext = new AudioContext();
      const audioBuffer = await audioContext.decodeAudioData(buffer.slice(0));
      const samples = audioBuffer.getChannelData(0).slice();
      await audioContext.close();
      return samples;
    } catch (error) {
      console.info(`${LOG_PREFIX} Using fallback waveform`, error);
      return undefined;
    }
  }

  async function loadSubtitles(): Promise<void> {
    if (!project.subtitleUrl) {
      cues = [];
      subtitlesReady = true;
      updateSaveAvailability();
      renderSubtitleList();
      renderTimeline();
      return;
    }
    try {
      const response = await fetch(project.subtitleUrl);
      if (!response.ok) {
        throw new Error(`Subtitle request returned ${response.status}`);
      }
      cues = parseSubtitleFile(await response.text());
      selectedCueId = cues[0]?.id || null;
      subtitlesReady = true;
      updateSaveAvailability();
    } catch (error) {
      console.error(`${LOG_PREFIX} Could not load subtitles`, error);
      cues = [];
      subtitlesReady = false;
      editorSaveStatus.textContent = "Subtitles could not be loaded; saving is disabled.";
      editorSaveStatus.classList.add("is-error");
    }
    renderSubtitleList();
    renderTimeline();
    updatePreview();
  }

  renderTimeline();
  void loadSubtitles();
  timelineScroll.scrollLeft = 0;
}

function renderRoute(): void {
  if (window.location.hash === "#editor") {
    const project = loadEditorProject();
    if (project) {
      renderEditor(project);
      return;
    }
    window.location.hash = "";
  }
  if (!app.querySelector(".app-shell")) {
    renderLanding();
  }
}

window.addEventListener("hashchange", renderRoute);
renderRoute();
