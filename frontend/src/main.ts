import "./style.css";
import editorPageHtml from "./pages/editor.html?raw";
import landingPageHtml from "./pages/landing.html?raw";
import { initializeApp } from "firebase/app";
import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
  type Auth,
  type User,
} from "firebase/auth";

const GCS_BUCKET = "benzaiten-outputs";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const SELF_HOSTED_API_BASE_URL_STORAGE_KEY = "benzaiten-self-hosted-api-base-url";
const FIREBASE_CONFIG = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};
const PROJECT_STORAGE_KEY = "benzaiten-editor-project";
const LOG_PREFIX = "[Benzaiten]";
const DEFAULT_KARAOKE_HIGHLIGHT_COLOR = "#f4a6c1";
let landingDocumentListeners: AbortController | null = null;
let firebaseAuth: Auth | null = null;
let currentUser: User | null = null;
let authReady = false;
let authReadyResolve: (() => void) | null = null;
let firebaseConfigWarningLogged = false;

const authReadyPromise = new Promise<void>(resolve => {
  authReadyResolve = resolve;
});

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

type ProjectListItemResponse = {
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
};

type ProjectListResponse = {
  projects: ProjectListItemResponse[];
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
  volumePercent?: number;
  playbackRate?: number;
  isBlank?: boolean;
  isLocalMedia?: boolean;
  karaokeEnabled?: boolean;
  karaokeHighlightColor?: string;
  apiBaseUrl?: string;
};

type LibraryProject = {
  title: string;
  jobId: string;
  mediaObject: GcsObject;
  mediaUrl: string;
  renderSourceObject?: GcsObject;
  renderSourceUrl?: string;
  subtitleObject?: GcsObject;
  subtitleUrl?: string;
};

type InferenceMode = "cloud" | "self_hosted";

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

type KaraokeToken = {
  text: string;
  weight: number;
  lineBreak?: false;
};

type KaraokeLineBreak = {
  lineBreak: true;
};

type TimedKaraokeToken = KaraokeToken & {
  start: number;
  end: number;
};

const appRoot = document.querySelector<HTMLDivElement>("#app");
if (!appRoot) {
  throw new Error("Application root is missing");
}
const app = appRoot;

function hasFirebaseConfig(): boolean {
  return Boolean(
    FIREBASE_CONFIG.apiKey
    && FIREBASE_CONFIG.authDomain
    && FIREBASE_CONFIG.projectId
    && FIREBASE_CONFIG.appId,
  );
}

function initializeFirebaseAuth(): void {
  if (!hasFirebaseConfig()) {
    authReady = true;
    authReadyResolve?.();
    return;
  }
  const firebaseApp = initializeApp(FIREBASE_CONFIG);
  firebaseAuth = getAuth(firebaseApp);
  onAuthStateChanged(firebaseAuth, user => {
    currentUser = user;
    authReady = true;
    authReadyResolve?.();
    window.dispatchEvent(new CustomEvent("benzaiten-auth-changed"));
  });
}

async function waitForAuthReady(): Promise<void> {
  if (authReady) {
    return;
  }
  await authReadyPromise;
}

async function getAuthToken(): Promise<string> {
  await waitForAuthReady();
  if (!firebaseAuth) {
    console.warn(`${LOG_PREFIX} Firebase is not configured. Add the VITE_FIREBASE_* env vars.`);
    throw new Error("Project authentication is not configured.");
  }
  if (!currentUser) {
    throw new Error("Sign in with Google before using project features.");
  }
  return currentUser.getIdToken();
}

async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

async function authJsonFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return authFetch(input, { ...init, headers });
}

function normalizeApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  const url = new URL(trimmed);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Backend URL must start with http:// or https://.");
  }
  return url.toString().replace(/\/+$/, "");
}

function getStoredSelfHostedApiBaseUrl(): string {
  const rawValue = localStorage.getItem(SELF_HOSTED_API_BASE_URL_STORAGE_KEY) || "";
  try {
    return normalizeApiBaseUrl(rawValue);
  } catch {
    return "";
  }
}

function getProjectApiBaseUrl(project: EditorProject): string {
  return project.apiBaseUrl || API_BASE_URL;
}

async function validateSelfHostedBackend(apiBaseUrl: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/health`);
  if (!response.ok) {
    throw new Error(`Self-hosted backend health check failed with ${response.status}.`);
  }
  const payload = await response.json() as {
    status?: string;
    self_hosted_inference_enabled?: boolean;
  };
  if (payload.status !== "ok") {
    throw new Error("Self-hosted backend did not return a healthy status.");
  }
  if (!payload.self_hosted_inference_enabled) {
    throw new Error(
      "Self-hosted inference is disabled on that backend. "
      + "Start it with ENABLE_SELF_HOSTED_INFERENCE=true.",
    );
  }
}

async function downloadAuthenticatedFile(
  url: string,
  filename: string,
  apiBaseUrl = API_BASE_URL,
): Promise<void> {
  const routedUrl = url.startsWith(API_BASE_URL)
    ? `${apiBaseUrl}${url.slice(API_BASE_URL.length)}`
    : url;
  const response = await authFetch(routedUrl);
  if (!response.ok) {
    throw new Error(await getApiError(response));
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

initializeFirebaseAuth();

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

function getKaraokeTokenWeight(text: string): number {
  let weight = 0;
  for (const character of Array.from(text.trim())) {
    if (/\s/u.test(character)) {
      continue;
    }
    weight += /\p{P}|\p{S}/u.test(character) ? 0.25 : 1;
  }
  return Math.max(0.25, weight);
}

function getKaraokeLineTokens(line: string): KaraokeToken[] {
  if (!line) {
    return [];
  }
  if (/\s/u.test(line.trim())) {
    return (line.match(/\S+\s*/gu) || []).map(token => ({
      text: token,
      weight: getKaraokeTokenWeight(token),
    }));
  }
  return Array.from(line).map(character => ({
    text: character,
    weight: getKaraokeTokenWeight(character),
  }));
}

function getTimedKaraokeTokens(cue: SubtitleCue): Array<TimedKaraokeToken | KaraokeLineBreak> {
  const lines = cue.text.replace(/\r/g, "").split("\n");
  const cueDuration = Math.max(0.01, cue.end - cue.start);
  const timedSegments: Array<TimedKaraokeToken | KaraokeLineBreak> = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (lineIndex > 0) {
      timedSegments.push({ lineBreak: true });
    }
    const lineTokens = getKaraokeLineTokens(line);
    const lineWeight = lineTokens.reduce((total, segment) => total + segment.weight, 0);
    let cursor = cue.start;
    for (const segment of lineTokens) {
      const segmentDuration = cueDuration * (segment.weight / Math.max(0.25, lineWeight));
      const timedSegment: TimedKaraokeToken = {
        ...segment,
        start: cursor,
        end: cursor + segmentDuration,
      };
      timedSegments.push(timedSegment);
      cursor = timedSegment.end;
    }
  }
  return timedSegments;
}

function renderKaraokeSubtitle(cue: SubtitleCue, time: number): string {
  return getTimedKaraokeTokens(cue).map(segment => {
    if (segment.lineBreak === true) {
      return "\n";
    }
    const progress = clamp(
      (time - segment.start) / Math.max(0.01, segment.end - segment.start),
      0,
      1,
    );
    const text = escapeHtml(segment.text);
    return (
      `<span class="karaoke-segment" style="--karaoke-progress:${(progress * 100).toFixed(2)}%">`
      + `<span class="karaoke-segment-base">${text}</span>`
      + `<span class="karaoke-segment-fill" aria-hidden="true">${text}</span>`
      + "</span>"
    );
  }).join("");
}

function formatApiErrorDetail(detail: unknown): string {
  if (typeof detail === "string") {
    return detail;
  }
  if (Array.isArray(detail)) {
    return detail.map(item => {
      if (item && typeof item === "object") {
        const record = item as { loc?: unknown; msg?: unknown; type?: unknown };
        const location = Array.isArray(record.loc) ? record.loc.join(".") : "";
        const message = typeof record.msg === "string" ? record.msg : JSON.stringify(item);
        return location ? `${location}: ${message}` : message;
      }
      return String(item);
    }).join("; ");
  }
  if (detail && typeof detail === "object") {
    return JSON.stringify(detail);
  }
  return "";
}

function getApiError(response: Response): Promise<string> {
  return response.text().then(body => {
    try {
      const parsed = JSON.parse(body) as { detail?: unknown };
      return (
        formatApiErrorDetail(parsed.detail)
        || body
        || `Request failed with status ${response.status}`
      );
    } catch {
      return body || `Request failed with status ${response.status}`;
    }
  });
}

function getFirebaseAuthErrorMessage(error: unknown): string {
  const code = (
    typeof error === "object"
    && error !== null
    && "code" in error
    && typeof (error as { code?: unknown }).code === "string"
  )
    ? (error as { code: string }).code
    : "";

  switch (code) {
    case "auth/email-already-in-use":
      return "An account already exists for this email.";
    case "auth/invalid-email":
      return "Enter a valid email address.";
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "The email or password is incorrect.";
    case "auth/missing-email":
      return "Enter your email address.";
    case "auth/missing-password":
      return "Enter your password.";
    case "auth/weak-password":
      return "Use a stronger password with at least 6 characters.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait a moment and try again.";
    case "auth/popup-closed-by-user":
      return "Sign-in was cancelled.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    default:
      return error instanceof Error ? error.message : "Authentication failed.";
  }
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

async function listJobObjects(jobId: string, apiBaseUrl = API_BASE_URL): Promise<GcsObject[]> {
  const response = await authFetch(`${apiBaseUrl}/jobs/${encodeURIComponent(jobId)}/objects`);
  if (!response.ok) {
    throw new Error(await getApiError(response));
  }
  const data = await response.json() as GcsObjectListResponse;
  return data.items || [];
}

async function listLibraryProjects(): Promise<LibraryProject[]> {
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

function openLibraryProject(project: LibraryProject): void {
  openEditor({
    title: project.title,
    originalTitle: project.title,
    jobId: project.jobId,
    mediaUrl: project.renderSourceUrl || project.mediaUrl,
    mediaObjectName: project.mediaObject.name,
    subtitleUrl: project.subtitleUrl,
    subtitleObjectName: project.subtitleObject?.name,
    mediaType: "video",
  });
}

function openBlankEditor(): void {
  openEditor({
    title: "Untitled project",
    mediaUrl: "",
    mediaType: "video",
    isBlank: true,
    isLocalMedia: true,
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
  document.title = "Benzaiten | AI-Powered Karaoke Orchestration Video Studio";
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
  const executionModeInput = queryElement<HTMLSelectElement>("#executionModeInput");
  const selfHostedBackendField = queryElement<HTMLDivElement>("#selfHostedBackendField");
  const selfHostedApiBaseUrlInput = queryElement<HTMLInputElement>("#selfHostedApiBaseUrlInput");
  const shouldDecrowd = queryElement<HTMLInputElement>("#shouldDecrowdInput");
  const fastDecrowd = queryElement<HTMLInputElement>("#fastDecrowdInput");
  const runButton = queryElement<HTMLButtonElement>("#runInferenceButton");
  const searchInput = queryElement<HTMLInputElement>("#videoNameInput");
  const searchButton = queryElement<HTMLButtonElement>("#loadButton");
  const libraryToggle = queryElement<HTMLButtonElement>("#libraryToggle");
  const libraryGallery = queryElement<HTMLDivElement>("#libraryGallery");
  const libraryStatus = queryElement<HTMLDivElement>("#libraryGalleryStatus");
  const libraryGrid = queryElement<HTMLDivElement>("#libraryVideoGrid");
  const libraryAuthenticatedContent = queryElement<HTMLDivElement>("#libraryAuthenticatedContent");
  const librarySignedOutPrompt = queryElement<HTMLDivElement>("#librarySignedOutPrompt");
  const deleteDialog = queryElement<HTMLDialogElement>("#deleteProjectDialog");
  const deleteProjectName = queryElement<HTMLElement>("#deleteProjectName");
  const cancelProjectDelete = queryElement<HTMLButtonElement>("#cancelProjectDelete");
  const confirmProjectDelete = queryElement<HTMLButtonElement>("#confirmProjectDelete");
  const authPanel = queryElement<HTMLDivElement>("#authPanel");
  const authStatus = queryElement<HTMLElement>("#authStatus");
  const authUser = queryElement<HTMLElement>("#authUser");
  const loginButton = queryElement<HTMLButtonElement>("#loginButton");
  const accountMenuButton = queryElement<HTMLButtonElement>("#accountMenuButton");
  const accountMenu = queryElement<HTMLDivElement>("#accountMenu");
  const accountAvatarImage = queryElement<HTMLImageElement>("#accountAvatarImage");
  const accountAvatarFallback = queryElement<HTMLElement>("#accountAvatarFallback");
  const accountMenuAvatarImage = queryElement<HTMLImageElement>("#accountMenuAvatarImage");
  const accountMenuAvatarFallback = queryElement<HTMLElement>("#accountMenuAvatarFallback");
  const accountMenuName = queryElement<HTMLElement>("#accountMenuName");
  const accountMenuEmail = queryElement<HTMLElement>("#accountMenuEmail");
  const logoutButton = queryElement<HTMLButtonElement>("#logoutButton");
  const authDialog = queryElement<HTMLDialogElement>("#authDialog");
  const authDialogClose = queryElement<HTMLButtonElement>("#authDialogClose");
  const authProviderList = queryElement<HTMLDivElement>("#authProviderList");
  const googleAuthButton = queryElement<HTMLButtonElement>("#googleAuthButton");
  const emailAuthButton = queryElement<HTMLButtonElement>("#emailAuthButton");
  const authEmailForm = queryElement<HTMLFormElement>("#authEmailForm");
  const authEmailInput = queryElement<HTMLInputElement>("#authEmailInput");
  const authPasswordInput = queryElement<HTMLInputElement>("#authPasswordInput");
  const emailCreateAccountButton = queryElement<HTMLButtonElement>("#emailCreateAccountButton");
  const emailResetPasswordButton = queryElement<HTMLButtonElement>("#emailResetPasswordButton");
  const authProvidersBackButton = queryElement<HTMLButtonElement>("#authProvidersBackButton");
  const authDialogStatus = queryElement<HTMLElement>("#authDialogStatus");
  let libraryProjects: LibraryProject[] | null = null;
  let pendingDelete: { project: LibraryProject; index: number } | null = null;
  let loadedLibraryUid: string | null = null;
  let libraryLoadPromise: Promise<void> | null = null;
  let authStateVersion = 0;
  setupWorkflowZoom();

  const invalidateLibraryRequests = (): number => {
    authStateVersion += 1;
    libraryLoadPromise = null;
    loadedLibraryUid = null;
    return authStateVersion;
  };

  const setProjectControlsEnabled = (enabled: boolean): void => {
    runButton.disabled = !enabled;
    searchButton.disabled = !enabled;
    searchInput.disabled = !enabled;
    libraryToggle.disabled = !enabled;
  };

  const setLibraryAuthenticated = (authenticated: boolean, message: string): void => {
    libraryAuthenticatedContent.hidden = !authenticated;
    librarySignedOutPrompt.hidden = authenticated;
    if (!authenticated) {
      libraryProjects = null;
      loadedLibraryUid = null;
      libraryGrid.innerHTML = "";
      libraryStatus.hidden = true;
      libraryStatus.classList.remove("is-error");
      libraryStatus.textContent = "";
      librarySignedOutPrompt.textContent = message;
    }
  };

  const renderAuthState = (): void => {
    const configured = Boolean(firebaseAuth);
    authPanel.classList.toggle("is-warning", !configured);
    loginButton.hidden = Boolean(currentUser);
    accountMenuButton.hidden = !currentUser;
    authUser.hidden = !currentUser;
    googleAuthButton.disabled = false;
    emailAuthButton.disabled = false;
    if (!configured) {
      if (!firebaseConfigWarningLogged) {
        firebaseConfigWarningLogged = true;
        console.warn(
          `${LOG_PREFIX} Firebase login is not configured. `
          + "Add VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN, "
          + "VITE_FIREBASE_PROJECT_ID, and VITE_FIREBASE_APP_ID.",
        );
      }
      authStatus.textContent = "Project accounts are unavailable.";
      authUser.textContent = "";
      accountMenu.hidden = true;
      accountMenuButton.setAttribute("aria-expanded", "false");
      setProjectControlsEnabled(false);
      setLibraryAuthenticated(
        false,
        "Project accounts are unavailable in this environment.",
      );
      return;
    }
    if (!currentUser) {
      authStatus.textContent = "Sign in to create and view your projects.";
      authUser.textContent = "";
      accountMenu.hidden = true;
      accountMenuButton.setAttribute("aria-expanded", "false");
      setProjectControlsEnabled(false);
      setLibraryAuthenticated(
        false,
        "Sign in to view your project library and create projects.",
      );
      return;
    }
    authStatus.textContent = "Signed in";
    authUser.textContent = currentUser.email || currentUser.displayName || currentUser.uid;
    accountMenuName.textContent = currentUser.displayName || "Benzaiten user";
    accountMenuEmail.textContent = currentUser.email || currentUser.uid;
    if (currentUser.photoURL) {
      accountAvatarImage.src = currentUser.photoURL;
      accountMenuAvatarImage.src = currentUser.photoURL;
      accountAvatarImage.hidden = false;
      accountMenuAvatarImage.hidden = false;
      accountAvatarFallback.hidden = true;
      accountMenuAvatarFallback.hidden = true;
    } else {
      accountAvatarImage.removeAttribute("src");
      accountMenuAvatarImage.removeAttribute("src");
      accountAvatarImage.hidden = true;
      accountMenuAvatarImage.hidden = true;
      accountAvatarFallback.hidden = false;
      accountMenuAvatarFallback.hidden = false;
    }
    setLibraryAuthenticated(true, "");
    setProjectControlsEnabled(true);
  };

  const refreshLibrary = async (requestVersion = authStateVersion): Promise<void> => {
    if (!currentUser) {
      libraryProjects = null;
      loadedLibraryUid = null;
      renderAuthState();
      return;
    }
    const uid = currentUser.uid;
    if (loadedLibraryUid === uid && libraryProjects !== null) {
      return;
    }
    if (libraryLoadPromise) {
      await libraryLoadPromise;
      return;
    }

    let loadPromise!: Promise<void>;
    loadPromise = (async () => {
      libraryStatus.hidden = false;
      libraryStatus.classList.remove("is-error");
      libraryStatus.textContent = "Loading your saved videos...";
      try {
        const projects = await listLibraryProjects();
        if (requestVersion !== authStateVersion || currentUser?.uid !== uid) {
          return;
        }
        libraryProjects = projects;
        loadedLibraryUid = uid;
        renderLibrary(libraryProjects);
        libraryStatus.textContent = libraryProjects.length
          ? ""
          : "No completed videos were found for this account.";
      } catch (error) {
        if (requestVersion !== authStateVersion || currentUser?.uid !== uid) {
          return;
        }
        loadedLibraryUid = null;
        libraryStatus.classList.add("is-error");
        libraryStatus.textContent = error instanceof Error
          ? error.message
          : "Unable to load the project library.";
      } finally {
        if (libraryLoadPromise === loadPromise) {
          libraryLoadPromise = null;
        }
      }
    })();
    libraryLoadPromise = loadPromise;
    await loadPromise;
  };

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

  const syncSelfHostedBackendField = (): void => {
    const isSelfHosted = executionModeInput.value === "self_hosted";
    selfHostedBackendField.hidden = !isSelfHosted;
    if (isSelfHosted && !selfHostedApiBaseUrlInput.value.trim()) {
      selfHostedApiBaseUrlInput.value = getStoredSelfHostedApiBaseUrl();
    }
  };

  fileInput.addEventListener("change", showSelectedFile);
  executionModeInput.addEventListener("change", syncSelfHostedBackendField);
  selfHostedApiBaseUrlInput.addEventListener("change", () => {
    const value = selfHostedApiBaseUrlInput.value.trim();
    if (!value) {
      localStorage.removeItem(SELF_HOSTED_API_BASE_URL_STORAGE_KEY);
      return;
    }
    try {
      const normalized = normalizeApiBaseUrl(value);
      selfHostedApiBaseUrlInput.value = normalized;
      localStorage.setItem(SELF_HOSTED_API_BASE_URL_STORAGE_KEY, normalized);
    } catch (error) {
      setLandingStatus(error instanceof Error ? error.message : String(error), true);
    }
  });
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
  syncSelfHostedBackendField();

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
  const openAuthDialog = (): void => {
    authDialogStatus.textContent = firebaseAuth
      ? ""
      : "Authentication is not configured in this environment.";
    showAuthProviderOptions();
    authDialog.showModal();
  };

  const closeAuthDialog = (): void => {
    if (authDialog.open) {
      authDialog.close();
    }
  };

  const setAuthBusy = (busy: boolean): void => {
    googleAuthButton.disabled = busy;
    emailAuthButton.disabled = busy;
    authEmailInput.disabled = busy;
    authPasswordInput.disabled = busy;
    emailCreateAccountButton.disabled = busy;
    emailResetPasswordButton.disabled = busy;
    authProvidersBackButton.disabled = busy;
  };

  function showAuthProviderOptions(): void {
    authProviderList.hidden = false;
    authEmailForm.hidden = true;
    authDialogStatus.textContent = firebaseAuth
      ? ""
      : "Authentication is not configured in this environment.";
  }

  const showEmailAuthForm = (): void => {
    authProviderList.hidden = true;
    authEmailForm.hidden = false;
    authDialogStatus.textContent = "";
    authEmailInput.focus();
  };

  const getEmailCredentials = (): { email: string; password: string } | null => {
    const email = authEmailInput.value.trim();
    const password = authPasswordInput.value;
    if (!email) {
      authDialogStatus.textContent = "Enter your email address.";
      authEmailInput.focus();
      return null;
    }
    if (!password) {
      authDialogStatus.textContent = "Enter your password.";
      authPasswordInput.focus();
      return null;
    }
    return { email, password };
  };

  const signInWithEmail = async (): Promise<void> => {
    if (!firebaseAuth) {
      console.warn(`${LOG_PREFIX} Firebase login is not configured.`);
      authDialogStatus.textContent = "Authentication is not configured in this environment.";
      return;
    }
    const credentials = getEmailCredentials();
    if (!credentials) {
      return;
    }
    setAuthBusy(true);
    authDialogStatus.textContent = "Signing in...";
    try {
      await signInWithEmailAndPassword(
        firebaseAuth,
        credentials.email,
        credentials.password,
      );
      closeAuthDialog();
      setLandingStatus("Signed in.");
    } catch (error) {
      console.warn(`${LOG_PREFIX} Email sign-in failed`, error);
      authDialogStatus.textContent = getFirebaseAuthErrorMessage(error);
    } finally {
      setAuthBusy(false);
    }
  };

  const createEmailAccount = async (): Promise<void> => {
    if (!firebaseAuth) {
      console.warn(`${LOG_PREFIX} Firebase login is not configured.`);
      authDialogStatus.textContent = "Authentication is not configured in this environment.";
      return;
    }
    const credentials = getEmailCredentials();
    if (!credentials) {
      return;
    }
    setAuthBusy(true);
    authDialogStatus.textContent = "Creating account...";
    try {
      await createUserWithEmailAndPassword(
        firebaseAuth,
        credentials.email,
        credentials.password,
      );
      closeAuthDialog();
      setLandingStatus("Account created.");
    } catch (error) {
      console.warn(`${LOG_PREFIX} Email account creation failed`, error);
      authDialogStatus.textContent = getFirebaseAuthErrorMessage(error);
    } finally {
      setAuthBusy(false);
    }
  };

  const sendEmailPasswordReset = async (): Promise<void> => {
    if (!firebaseAuth) {
      console.warn(`${LOG_PREFIX} Firebase login is not configured.`);
      authDialogStatus.textContent = "Authentication is not configured in this environment.";
      return;
    }
    const email = authEmailInput.value.trim();
    if (!email) {
      authDialogStatus.textContent = "Enter your email address first.";
      authEmailInput.focus();
      return;
    }
    setAuthBusy(true);
    authDialogStatus.textContent = "Sending password reset email...";
    try {
      await sendPasswordResetEmail(firebaseAuth, email);
      authDialogStatus.textContent = "Password reset email sent.";
    } catch (error) {
      console.warn(`${LOG_PREFIX} Password reset failed`, error);
      authDialogStatus.textContent = getFirebaseAuthErrorMessage(error);
    } finally {
      setAuthBusy(false);
    }
  };

  const signInWithGoogle = async (): Promise<void> => {
    if (!firebaseAuth) {
      console.warn(`${LOG_PREFIX} Firebase login is not configured.`);
      authDialogStatus.textContent = "Authentication is not configured in this environment.";
      return;
    }
    setAuthBusy(true);
    authDialogStatus.textContent = "Opening Google sign-in...";
    try {
      await signInWithPopup(firebaseAuth, new GoogleAuthProvider());
      closeAuthDialog();
      setLandingStatus("Signed in.");
    } catch (error) {
      console.warn(`${LOG_PREFIX} Google sign-in failed`, error);
      authDialogStatus.textContent = getFirebaseAuthErrorMessage(error);
    } finally {
      setAuthBusy(false);
    }
  };

  loginButton.addEventListener("click", openAuthDialog);
  authDialogClose.addEventListener("click", closeAuthDialog);
  authDialog.addEventListener("click", event => {
    if (event.target === authDialog) {
      closeAuthDialog();
    }
  });
  authDialog.addEventListener("cancel", () => {
    authDialogStatus.textContent = "";
  });
  googleAuthButton.addEventListener("click", () => {
    void signInWithGoogle();
  });
  emailAuthButton.addEventListener("click", showEmailAuthForm);
  authProvidersBackButton.addEventListener("click", showAuthProviderOptions);
  authEmailForm.addEventListener("submit", event => {
    event.preventDefault();
    void signInWithEmail();
  });
  emailCreateAccountButton.addEventListener("click", () => {
    void createEmailAccount();
  });
  emailResetPasswordButton.addEventListener("click", () => {
    void sendEmailPasswordReset();
  });
  accountMenuButton.addEventListener("click", () => {
    const shouldOpen = accountMenu.hidden;
    accountMenu.hidden = !shouldOpen;
    accountMenuButton.setAttribute("aria-expanded", String(shouldOpen));
  });
  logoutButton.addEventListener("click", async () => {
    if (!firebaseAuth) {
      return;
    }
    accountMenu.hidden = true;
    accountMenuButton.setAttribute("aria-expanded", "false");
    invalidateLibraryRequests();
    await signOut(firebaseAuth);
    libraryProjects = null;
    loadedLibraryUid = null;
    libraryGrid.innerHTML = "";
    setLandingStatus("Signed out.");
  });
  window.addEventListener("benzaiten-auth-changed", () => {
    const requestVersion = invalidateLibraryRequests();
    renderAuthState();
    void refreshLibrary(requestVersion);
  }, documentListenerOptions);

  const renderLibrary = (projects: LibraryProject[]): void => {
    if (!currentUser) {
      libraryStatus.hidden = true;
      libraryGrid.innerHTML = "";
      return;
    }
    libraryStatus.hidden = true;
    if (!projects.length) {
      libraryStatus.textContent = "";
    }
    libraryGrid.innerHTML = `
      <article class="library-video-card library-create-card">
        <button
          class="library-create-open"
          type="button"
          data-library-action="create"
          aria-label="Create a new blank video project"
        >
          <span class="library-create-plus" aria-hidden="true">+</span>
          <strong>Create new project</strong>
          <span>Start with a blank editor</span>
        </button>
      </article>
    ` + projects.map((project, index) => `
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
              src="${project.mediaUrl}"
              preload="metadata"
              muted
              playsinline
            ></video>
          </button>
          <span class="library-video-duration">--:--</span>
          <div class="library-video-actions">
            <a
              class="library-video-action"
              href="#"
              data-library-action="download"
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
      const response = await authJsonFetch(`${API_BASE_URL}/projects/rename`, {
        method: "POST",
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
      project.mediaUrl = renamed.media_url;
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
      const response = await authFetch(
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

    await refreshLibrary();
  });

  libraryGrid.addEventListener("click", async event => {
    const target = event.target as HTMLElement;
    const actionElement = target.closest<HTMLElement>("[data-library-action]");
    const action = actionElement?.dataset.libraryAction;
    if (action === "create") {
      openBlankEditor();
      return;
    }
    const card = target.closest<HTMLElement>("[data-library-project]");
    const projectIndex = Number(card?.dataset.libraryProject);
    const project = libraryProjects?.[projectIndex];
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

    if (action === "download") {
      event.preventDefault();
      try {
        await downloadAuthenticatedFile(
          `${API_BASE_URL}/projects/download?source_blob_name=${
            encodeURIComponent(project.mediaObject.name)
          }`,
          `${project.title || "benzaiten-video"}.mp4`,
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setLandingStatus(`Download failed: ${message}`, true);
      }
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
      || target.closest("#accountMenu")
      || target.closest("#accountMenuButton")
    ) {
      return;
    }
    accountMenu.hidden = true;
    accountMenuButton.setAttribute("aria-expanded", "false");
    closeLibraryMenus();
    for (const card of libraryGrid.querySelectorAll<HTMLElement>(
      ".library-video-card.is-renaming",
    )) {
      cancelInlineRename(card);
    }
  }, documentListenerOptions);

  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      accountMenu.hidden = true;
      accountMenuButton.setAttribute("aria-expanded", "false");
      closeLibraryMenus();
      for (const card of libraryGrid.querySelectorAll<HTMLElement>(
        ".library-video-card.is-renaming",
      )) {
        cancelInlineRename(card);
      }
    }
  }, documentListenerOptions);

  void (async () => {
    await waitForAuthReady();
    renderAuthState();
    await refreshLibrary();
  })();
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
  const executionModeInput = queryElement<HTMLSelectElement>("#executionModeInput");
  const selfHostedApiBaseUrlInput = queryElement<HTMLInputElement>("#selfHostedApiBaseUrlInput");
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
  const executionMode = executionModeInput.value as InferenceMode;
  let inferenceApiBaseUrl = API_BASE_URL;
  if (executionMode === "self_hosted") {
    try {
      inferenceApiBaseUrl = normalizeApiBaseUrl(
        selfHostedApiBaseUrlInput.value || getStoredSelfHostedApiBaseUrl(),
      );
    } catch (error) {
      setLandingStatus(error instanceof Error ? error.message : String(error), true);
      return;
    }
    if (!inferenceApiBaseUrl) {
      setLandingStatus("Enter the FastAPI URL for your self-hosted backend.", true);
      selfHostedApiBaseUrlInput.focus();
      return;
    }
    selfHostedApiBaseUrlInput.value = inferenceApiBaseUrl;
    localStorage.setItem(SELF_HOSTED_API_BASE_URL_STORAGE_KEY, inferenceApiBaseUrl);
  }

  runButton.disabled = true;
  const progress = createProgressController(shouldDecrowdInput.checked);

  try {
    if (executionMode === "self_hosted") {
      setLandingStatus("Checking self-hosted backend...");
      await validateSelfHostedBackend(inferenceApiBaseUrl);
    }
    setLandingStatus("Uploading media and starting orchestration...");
    const formData = new FormData();
    formData.append("file", file);
    formData.append("language", language);
    formData.append("execution_mode", executionMode);
    formData.append("should_decrowd", shouldDecrowdInput.checked ? "true" : "false");
    formData.append(
      "fast_decrowd",
      shouldDecrowdInput.checked && fastDecrowdInput.checked ? "true" : "false",
    );
    const projectTitle = projectNameInput.value.trim();
    if (projectTitle) {
      formData.append("project_title", projectTitle);
    }

    const response = await authFetch(`${inferenceApiBaseUrl}/jobs`, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      throw new Error(await getApiError(response));
    }

    const startData = await response.json() as JobStartResponse;
    localStorage.setItem("job_id", startData.job_id);
    setLandingStatus(`Job ${startData.job_id} is running.`);
    const completed = await pollInferenceJob(startData.job_id, progress, inferenceApiBaseUrl);
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
      title: projectTitle || filenameWithoutExtension(file.name),
      originalTitle: projectTitle || filenameWithoutExtension(file.name),
      jobId: startData.job_id,
      mediaUrl,
      mediaObjectName: getGcsObjectName(mediaUrl),
      subtitleUrl: completed.subtitle_url,
      subtitleObjectName: getGcsObjectName(completed.subtitle_url),
      mediaType: completed.video_url ? "video" : "audio",
      apiBaseUrl: executionMode === "self_hosted" ? inferenceApiBaseUrl : undefined,
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
  apiBaseUrl = API_BASE_URL,
): Promise<JobStatusResponse> {
  while (true) {
    const [statusResponse, jobObjects] = await Promise.all([
      authFetch(`${apiBaseUrl}/jobs/${encodeURIComponent(jobId)}`),
      listJobObjects(jobId, apiBaseUrl).catch(() => []),
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
    const projects = await listLibraryProjects();
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

function renderEditor(project: EditorProject): void {
  document.title = `${project.title} | Benzaiten Editor`;
  app.innerHTML = editorPageHtml
    .replaceAll("{{PROJECT_TITLE}}", escapeHtml(project.title))
    .replace("{{SUBTITLE_FONT_SIZE}}", String(project.subtitleFontSize || 30));
  setupEditor(project);
}

function setupEditor(project: EditorProject): void {
  const editorHeader = queryElement<HTMLElement>(".editor-header");
  const editorMain = queryElement<HTMLElement>(".editor-main");
  const editorWorkspace = queryElement<HTMLElement>(".editor-workspace");
  const subtitlePanel = queryElement<HTMLElement>("#subtitlePanel");
  const panelResizer = queryElement<HTMLDivElement>("#panelResizer");
  const panelCollapseButton = queryElement<HTMLButtonElement>("#panelCollapseButton");
  const timelineResizer = queryElement<HTMLDivElement>("#timelineResizer");
  const timelineCollapseButton = queryElement<HTMLButtonElement>("#timelineCollapseButton");
  const backButton = queryElement<HTMLButtonElement>("#backButton");
  const projectTitle = queryElement<HTMLLabelElement>(".editor-project-title");
  const projectTitleInput = queryElement<HTMLInputElement>("#projectTitleInput");
  const editorActions = queryElement<HTMLDivElement>(".editor-actions");
  const saveChangesButton = queryElement<HTMLButtonElement>("#saveChangesButton");
  const editorSaveStatus = queryElement<HTMLSpanElement>("#editorSaveStatus");
  const subtitleFontSizeInput = queryElement<HTMLInputElement>("#subtitleFontSizeInput");
  const karaokeToggleInput = queryElement<HTMLInputElement>("#karaokeToggleInput");
  const media = queryElement<HTMLVideoElement>("#editorMedia");
  const previewArea = queryElement<HTMLDivElement>(".preview-area");
  const previewStack = queryElement<HTMLDivElement>(".preview-stack");
  const previewStage = queryElement<HTMLDivElement>(".preview-stage");
  const blankEditorDrop = queryElement<HTMLButtonElement>("#blankEditorDrop");
  const editorMediaInput = queryElement<HTMLInputElement>("#editorMediaInput");
  const videoLoadingSpinner = queryElement<HTMLDivElement>("#videoLoadingSpinner");
  const audioPreview = queryElement<HTMLDivElement>("#audioPreview");
  const audioPreviewTitle = queryElement<HTMLElement>("#audioPreview strong");
  const subtitleList = queryElement<HTMLDivElement>("#subtitleList");
  const subtitleTransformBox = queryElement<HTMLDivElement>("#subtitleTransformBox");
  const overlay = queryElement<HTMLDivElement>("#subtitleOverlay");
  const timelineContent = queryElement<HTMLDivElement>("#timelineContent");
  const timelineShell = queryElement<HTMLDivElement>("#timelineShell");
  const timelineScroll = queryElement<HTMLDivElement>("#timelineScroll");
  const playButton = queryElement<HTMLButtonElement>("#playButton");
  const skipBackButton = queryElement<HTMLButtonElement>("#skipBackButton");
  const skipForwardButton = queryElement<HTMLButtonElement>("#skipForwardButton");
  const exportVideoButton = queryElement<HTMLButtonElement>("#exportVideoButton");
  const timeDisplay = queryElement<HTMLSpanElement>("#timeDisplay");
  const zoomInput = queryElement<HTMLInputElement>("#zoomInput");
  const mediaAdjustments = queryElement<HTMLDivElement>("#mediaAdjustments");
  const volumeButton = queryElement<HTMLButtonElement>("#volumeButton");
  const speedButton = queryElement<HTMLButtonElement>("#speedButton");
  const volumePopover = queryElement<HTMLDivElement>("#volumePopover");
  const speedPopover = queryElement<HTMLDivElement>("#speedPopover");
  const volumeSlider = queryElement<HTMLInputElement>("#volumeSlider");
  const volumeInput = queryElement<HTMLInputElement>("#volumeInput");
  const speedSlider = queryElement<HTMLInputElement>("#speedSlider");
  const speedInput = queryElement<HTMLInputElement>("#speedInput");
  const exportPreviewModal = queryElement<HTMLDivElement>("#exportPreviewModal");
  const exportPreviewVideo = queryElement<HTMLVideoElement>("#exportPreviewVideo");
  const exportPreviewTitle = queryElement<HTMLElement>("#exportPreviewTitle");
  const exportRenderProgress = queryElement<HTMLDivElement>("#exportRenderProgress");
  const exportRenderPercent = queryElement<HTMLElement>("#exportRenderPercent");
  const exportRenderStatus = queryElement<HTMLElement>("#exportRenderStatus");
  const exportProgressFill = queryElement<HTMLDivElement>("#exportProgressFill");
  const downloadMp4Button = queryElement<HTMLButtonElement>("#downloadMp4Button");
  const downloadMp3Button = queryElement<HTMLButtonElement>("#downloadMp3Button");
  let exportProgressTimer: number | null = null;
  let exportAbortController: AbortController | null = null;
  let activeExportRenderId: string | null = null;
  let latestRenderedPreviewUrl: string | null = null;
  let exportWasCancelled = false;
  let saveInFlight = false;
  let cues: SubtitleCue[] = [];
  let sources: TimelineSource[] = [];
  let duration = project.isBlank ? 60 : 120;
  let zoom = Number(zoomInput.value);
  let selectedCueId: string | null = null;
  const selectedCueIds = new Set<string>();
  const selectedSourceIds = new Set<string>();
  let savedProjectSnapshot: string | null = null;
  let activeCueId: string | null = null;
  let timelineSnapTime: number | null = null;
  let previousSidebarWidth = 350;
  let previousTimelineHeight = 300;
  let mediaReady = false;
  let subtitlesReady = false;
  let volumePercent = clamp(project.volumePercent ?? 100, 0, 200);
  let playbackRate = clamp(project.playbackRate ?? 1, 0.25, 2);
  let karaokeEnabled = project.karaokeEnabled ?? true;
  const karaokeHighlightColor = project.karaokeHighlightColor || DEFAULT_KARAOKE_HIGHLIGHT_COLOR;
  let playbackRequested = false;
  let previewAnimationId: number | null = null;
  let audioContext: AudioContext | null = null;
  let mediaGain: GainNode | null = null;
  const previewReferenceWidth = 960;
  const subtitleTransform: SubtitleTransform = {
    x: project.subtitleTransform?.x ?? 50,
    y: project.subtitleTransform?.y ?? 82,
    width: project.subtitleTransform?.width ?? 82,
    height: project.subtitleTransform?.height ?? 22,
    rotation: project.subtitleTransform?.rotation ?? 0,
  };

  const finiteOrDefault = (value: number | undefined, fallback: number): number => (
    Number.isFinite(value) ? Number(value) : fallback
  );

  const getSerializableSubtitleTransform = (): SubtitleTransform => ({
    x: clamp(finiteOrDefault(subtitleTransform.x, 50), 0, 100),
    y: clamp(finiteOrDefault(subtitleTransform.y, 82), 0, 100),
    width: clamp(finiteOrDefault(subtitleTransform.width, 82), 5, 120),
    height: clamp(finiteOrDefault(subtitleTransform.height, 22), 5, 100),
    rotation: clamp(finiteOrDefault(subtitleTransform.rotation, 0), -180, 180),
  });

  const getSerializableCues = (): Array<{ start: number; end: number; text: string }> => (
    cues.map(cue => {
      const start = Math.max(0, finiteOrDefault(cue.start, 0));
      const end = Math.max(start + 0.1, finiteOrDefault(cue.end, start + 0.1));
      return {
        start,
        end,
        text: cue.text.length > 0 ? cue.text : " ",
      };
    })
  );

  const normalizeSnapshotNumber = (value: number): number => (
    Math.round(value * 1000) / 1000
  );

  const getProjectSaveSnapshot = (): string => JSON.stringify({
    title: project.title.trim() || "Untitled project",
    cues: getSerializableCues().map(cue => ({
      start: normalizeSnapshotNumber(cue.start),
      end: normalizeSnapshotNumber(cue.end),
      text: cue.text,
    })),
    subtitleFontSize: normalizeSnapshotNumber(project.subtitleFontSize || 30),
    subtitleTransform: {
      x: normalizeSnapshotNumber(getSerializableSubtitleTransform().x),
      y: normalizeSnapshotNumber(getSerializableSubtitleTransform().y),
      width: normalizeSnapshotNumber(getSerializableSubtitleTransform().width),
      height: normalizeSnapshotNumber(getSerializableSubtitleTransform().height),
      rotation: normalizeSnapshotNumber(getSerializableSubtitleTransform().rotation),
    },
    karaokeEnabled,
    karaokeHighlightColor,
  });

  const hasPersistableChanges = (): boolean => (
    savedProjectSnapshot !== null && getProjectSaveSnapshot() !== savedProjectSnapshot
  );

  if (project.mediaUrl) {
    media.src = project.mediaUrl;
  }
  media.style.display = !project.isBlank && project.mediaType === "video" ? "block" : "none";
  audioPreview.classList.toggle(
    "is-visible",
    !project.isBlank && project.mediaType === "audio",
  );
  blankEditorDrop.hidden = !project.isBlank;
  playButton.disabled = Boolean(project.isBlank);
  skipBackButton.disabled = Boolean(project.isBlank);
  skipForwardButton.disabled = Boolean(project.isBlank);
  exportVideoButton.disabled = Boolean(project.isBlank);
  volumeSlider.value = String(volumePercent);
  volumeInput.value = String(Math.round(volumePercent));
  speedSlider.value = playbackRate.toFixed(2);
  speedInput.value = playbackRate.toFixed(2);
  karaokeToggleInput.checked = karaokeEnabled;
  overlay.style.setProperty("--karaoke-highlight-color", karaokeHighlightColor);

  const isMultiSelectEvent = (event: MouseEvent | PointerEvent): boolean => (
    event.metaKey || event.ctrlKey
  );

  const clearTimelineSelection = (): void => {
    selectedCueIds.clear();
    selectedSourceIds.clear();
    selectedCueId = null;
  };

  const selectCue = (cueId: string, additive = false): void => {
    if (additive) {
      selectedSourceIds.clear();
      if (selectedCueIds.has(cueId)) {
        selectedCueIds.delete(cueId);
      } else {
        selectedCueIds.add(cueId);
      }
      selectedCueId = selectedCueIds.has(cueId)
        ? cueId
        : Array.from(selectedCueIds).at(-1) || null;
      return;
    }
    selectedCueIds.clear();
    selectedSourceIds.clear();
    selectedCueIds.add(cueId);
    selectedCueId = cueId;
  };

  const selectSource = (sourceId: string, additive = false): void => {
    if (additive) {
      selectedCueIds.clear();
      selectedCueId = null;
      if (selectedSourceIds.has(sourceId)) {
        selectedSourceIds.delete(sourceId);
      } else {
        selectedSourceIds.add(sourceId);
      }
      return;
    }
    selectedCueIds.clear();
    selectedSourceIds.clear();
    selectedSourceIds.add(sourceId);
    selectedCueId = null;
  };

  const fitEditorTitle = (): void => {
    if (window.getComputedStyle(projectTitle).position !== "absolute") {
      projectTitle.style.removeProperty("width");
      return;
    }
    const headerBounds = editorHeader.getBoundingClientRect();
    const backBounds = backButton.getBoundingClientRect();
    const actionsBounds = editorActions.getBoundingClientRect();
    const center = headerBounds.left + headerBounds.width / 2;
    const safeGap = 14;
    const availableHalfWidth = Math.max(
      0,
      Math.min(
        center - backBounds.right - safeGap,
        actionsBounds.left - center - safeGap,
      ),
    );
    projectTitle.style.width = `${Math.min(580, availableHalfWidth * 2)}px`;
  };

  const headerResizeObserver = new ResizeObserver(fitEditorTitle);
  headerResizeObserver.observe(editorHeader);
  headerResizeObserver.observe(backButton);
  headerResizeObserver.observe(editorActions);
  window.requestAnimationFrame(fitEditorTitle);

  const ensureMediaGain = (): GainNode | null => {
    if (mediaGain) {
      return mediaGain;
    }
    try {
      audioContext = new AudioContext();
      const source = audioContext.createMediaElementSource(media);
      mediaGain = audioContext.createGain();
      source.connect(mediaGain).connect(audioContext.destination);
      media.volume = 1;
      return mediaGain;
    } catch (error) {
      console.error(`${LOG_PREFIX} Could not initialize amplified volume control`, error);
      return null;
    }
  };

  const applyVolume = (value: number, syncNumberInput = true): void => {
    volumePercent = clamp(Math.round(value), 0, 200);
    const gain = ensureMediaGain();
    if (gain) {
      gain.gain.value = volumePercent / 100;
      void audioContext?.resume();
    } else {
      media.volume = Math.min(1, volumePercent / 100);
    }
    for (const source of sources) {
      if (source.element) {
        source.element.volume = Math.min(1, volumePercent / 100);
      }
    }
    volumeSlider.value = String(volumePercent);
    if (syncNumberInput) {
      volumeInput.value = String(volumePercent);
    }
    project.volumePercent = volumePercent;
    saveEditorProject(project);
  };

  const applyPlaybackRate = (value: number, syncNumberInput = true): void => {
    playbackRate = Math.round(clamp(value, 0.25, 2) * 100) / 100;
    media.playbackRate = playbackRate;
    for (const source of sources) {
      if (source.element) {
        source.element.playbackRate = playbackRate;
      }
    }
    speedSlider.value = playbackRate.toFixed(2);
    if (syncNumberInput) {
      speedInput.value = playbackRate.toFixed(2);
    }
    project.playbackRate = playbackRate;
    saveEditorProject(project);
  };

  const updateExportAvailability = (): void => {
    exportVideoButton.disabled = (
      saveInFlight
      || project.isBlank
      || project.mediaType !== "video"
    );
  };

  const updateSaveAvailability = (): void => {
    saveChangesButton.disabled = (
      saveInFlight
      || project.mediaType !== "video"
      || project.isLocalMedia
      || !mediaReady
      || !subtitlesReady
      || !hasPersistableChanges()
    );
    updateExportAvailability();
  };

  const markProjectClean = (): void => {
    savedProjectSnapshot = getProjectSaveSnapshot();
    updateSaveAvailability();
  };

  const hasSavePrerequisites = (): boolean => (
      project.mediaType !== "video"
      || project.isLocalMedia
      || !mediaReady
      || !subtitlesReady
  );

  const persistSubtitleTransform = (): void => {
    project.subtitleTransform = { ...subtitleTransform };
    saveEditorProject(project);
    updateSaveAvailability();
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

  const updateSubtitlePreviewRendering = (): void => {
    const previewScale = Math.max(
      0.1,
      previewStage.getBoundingClientRect().width / previewReferenceWidth,
    );
    const fontSize = project.subtitleFontSize || 30;
    overlay.style.setProperty("--subtitle-preview-scale", String(previewScale));
    overlay.style.fontSize = `${fontSize * previewScale}px`;
  };

  applySubtitleTransform();
  updateSubtitlePreviewRendering();

  const getTimelineWidth = (): number => Math.max(900, Math.ceil(duration * zoom));
  const pixelsPerSecond = (): number => getTimelineWidth() / duration;

  const activeCueAt = (time: number): SubtitleCue | undefined => (
    cues.find(cue => time >= cue.start && time < cue.end)
  );

  const subtitleMinimumDuration = 0.1;
  const timelineSnapThresholdPixels = 6;

  const normalizeSubtitleTiming = (): void => {
    cues.sort((left, right) => left.start - right.start);
    for (let index = 1; index < cues.length; index += 1) {
      const previousCue = cues[index - 1];
      const cue = cues[index];
      if (previousCue.end <= cue.start) {
        continue;
      }
      if (cue.start - previousCue.start >= subtitleMinimumDuration) {
        previousCue.end = cue.start;
      } else {
        cue.start = previousCue.end;
        cue.end = Math.max(cue.end, cue.start + subtitleMinimumDuration);
      }
    }
  };

  const getSubtitleNeighborBounds = (cue: SubtitleCue): {
    previousEnd: number;
    nextStart: number;
  } => {
    const cueIndex = cues.findIndex(item => item.id === cue.id);
    return {
      previousEnd: cueIndex > 0 ? cues[cueIndex - 1].end : 0,
      nextStart: cueIndex >= 0 && cueIndex < cues.length - 1
        ? cues[cueIndex + 1].start
        : duration,
    };
  };

  const getTimelineSnapCandidates = (
    excludedCueId?: string,
    excludedSourceId?: string,
  ): number[] => {
    const candidates = new Set<number>([0, duration, media.currentTime]);
    for (const cue of cues) {
      if (cue.id !== excludedCueId) {
        candidates.add(cue.start);
        candidates.add(cue.end);
      }
    }
    for (const source of sources) {
      if (source.id !== excludedSourceId) {
        candidates.add(source.start);
        candidates.add(source.start + source.duration);
      }
    }
    return [...candidates];
  };

  const snapTimelineValue = (
    value: number,
    candidates: number[],
    minimum: number,
    maximum: number,
    snappingDisabled: boolean,
  ): { value: number; snapTime: number | null } => {
    const clampedValue = clamp(value, minimum, maximum);
    if (snappingDisabled) {
      return { value: clampedValue, snapTime: null };
    }
    const thresholdSeconds = timelineSnapThresholdPixels / pixelsPerSecond();
    let closest: number | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      if (candidate < minimum || candidate > maximum) {
        continue;
      }
      const distance = Math.abs(candidate - clampedValue);
      if (distance <= thresholdSeconds && distance < closestDistance) {
        closest = candidate;
        closestDistance = distance;
      }
    }
    return {
      value: closest ?? clampedValue,
      snapTime: closest,
    };
  };

  const snapTimelineRange = (
    start: number,
    rangeDuration: number,
    candidates: number[],
    minimumStart: number,
    maximumStart: number,
    snappingDisabled: boolean,
  ): { start: number; snapTime: number | null } => {
    const clampedStart = clamp(start, minimumStart, maximumStart);
    if (snappingDisabled) {
      return { start: clampedStart, snapTime: null };
    }
    const thresholdSeconds = timelineSnapThresholdPixels / pixelsPerSecond();
    let snappedStart = clampedStart;
    let snapTime: number | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      for (const edge of [clampedStart, clampedStart + rangeDuration]) {
        const distance = Math.abs(candidate - edge);
        const adjustedStart = clampedStart + candidate - edge;
        if (
          distance <= thresholdSeconds
          && distance < closestDistance
          && adjustedStart >= minimumStart
          && adjustedStart <= maximumStart
        ) {
          snappedStart = adjustedStart;
          snapTime = candidate;
          closestDistance = distance;
        }
      }
    }
    return { start: snappedStart, snapTime };
  };

  const setVideoLoading = (isLoading: boolean): void => {
    videoLoadingSpinner.hidden = !isLoading || project.mediaType !== "video";
  };

  const requestPlayback = (
    element: HTMLMediaElement,
    label: string,
  ): void => {
    void element.play().catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        if (element === media && playbackRequested) {
          setVideoLoading(true);
        }
        return;
      }
      if (element === media) {
        playbackRequested = false;
        setVideoLoading(false);
        setPlayButtonState(false);
      }
      console.error(`${LOG_PREFIX} Could not play ${label}`, error);
    });
  };

  const syncSubtitleSelection = (scrollIntoView = false): void => {
    for (const card of subtitleList.querySelectorAll<HTMLElement>(".subtitle-card")) {
      const cueId = card.dataset.cueId;
      card.classList.toggle(
        "is-active",
        Boolean(cueId && selectedCueIds.has(cueId)),
      );
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
    overlay.innerHTML = activeCue
      ? karaokeEnabled
        ? renderKaraokeSubtitle(activeCue, currentTime)
        : escapeHtml(activeCue.text)
      : "";
    if (activeCue?.id !== activeCueId) {
      activeCueId = activeCue?.id || null;
      if (activeCue && selectedCueIds.size <= 1 && selectedSourceIds.size === 0) {
        selectCue(activeCue.id);
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
      source.element.playbackRate = playbackRate;
      source.element.volume = Math.min(1, volumePercent / 100);
      if (shouldPlay) {
        if (Math.abs(source.element.currentTime - sourceTime) > 0.35) {
          source.element.currentTime = sourceTime;
        }
        if (source.element.paused) {
          requestPlayback(source.element, source.name);
        }
      } else {
        source.element.pause();
      }
    }
  };

  const stopPreviewLoop = (): void => {
    if (previewAnimationId !== null) {
      window.cancelAnimationFrame(previewAnimationId);
      previewAnimationId = null;
    }
  };

  const startPreviewLoop = (): void => {
    if (previewAnimationId !== null) {
      return;
    }
    const tick = (): void => {
      updatePreview();
      if (!media.paused && !media.ended) {
        previewAnimationId = window.requestAnimationFrame(tick);
      } else {
        previewAnimationId = null;
      }
    };
    previewAnimationId = window.requestAnimationFrame(tick);
  };

  const renderSubtitleList = (): void => {
    if (cues.length === 0) {
      subtitleList.innerHTML = `
        <div class="empty-subtitles">
          No subtitle cues were found. Add a cue to begin editing.
        </div>
      `;
      updateSaveAvailability();
      return;
    }

    subtitleList.innerHTML = cues.map(cue => {
      const { previousEnd, nextStart } = getSubtitleNeighborBounds(cue);
      return `
        <article class="subtitle-card ${selectedCueIds.has(cue.id) ? "is-active" : ""}" data-cue-id="${cue.id}">
          <div class="subtitle-time-row">
            <div class="subtitle-time">
              <input
                class="time-input"
                data-time="start"
                type="number"
                min="${previousEnd.toFixed(2)}"
                max="${Math.max(previousEnd, cue.end - subtitleMinimumDuration).toFixed(2)}"
                step="0.01"
                value="${cue.start.toFixed(2)}"
                aria-label="Start seconds"
              />
              <span>to</span>
              <input
                class="time-input"
                data-time="end"
                type="number"
                min="${(cue.start + subtitleMinimumDuration).toFixed(2)}"
                max="${nextStart.toFixed(2)}"
                step="0.01"
                value="${cue.end.toFixed(2)}"
                aria-label="End seconds"
              />
            </div>
            <button class="icon-button" data-delete-cue="${cue.id}" title="Delete subtitle">x</button>
          </div>
          <textarea data-cue-text="${cue.id}" aria-label="Subtitle text">${escapeHtml(cue.text)}</textarea>
        </article>
      `;
    }).join("");
    syncSubtitleSelection();
    updateSaveAvailability();
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
              class="clip ${sourceClass} ${selectedSourceIds.has(source.id) ? "is-selected" : ""}"
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
        class="clip subtitle-clip ${selectedCueIds.has(cue.id) ? "is-selected" : ""}"
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
      ${timelineSnapTime === null ? "" : `
        <div
          class="timeline-snap-guide"
          style="left:${118 + timelineSnapTime * pixelsPerSecond()}px"
        ></div>
      `}
      <div class="playhead" style="left:${118 + media.currentTime * pixelsPerSecond()}px"></div>
    `;

    for (const canvas of timelineContent.querySelectorAll<HTMLCanvasElement>(".waveform")) {
      const sourceId = canvas.dataset.waveform;
      const source = sources.find(item => item.id === sourceId);
      drawWaveform(canvas, source?.isPrimary ? waveformSamples : undefined);
    }
  };

  const seekToCue = (cue: SubtitleCue): void => {
    selectCue(cue.id);
    media.currentTime = cue.start;
    updatePreview();
    renderTimeline();
    syncSubtitleSelection(true);
  };

  const deleteSubtitleCue = (cueId: string): void => {
    const cueIndex = cues.findIndex(cue => cue.id === cueId);
    if (cueIndex < 0) {
      return;
    }
    cues.splice(cueIndex, 1);
    selectedCueIds.delete(cueId);
    if (selectedCueId === cueId) {
      selectedCueId = Array.from(selectedCueIds).at(-1)
        || cues[Math.min(cueIndex, cues.length - 1)]?.id
        || null;
      if (selectedCueId) {
        selectedCueIds.add(selectedCueId);
      }
    }
    if (activeCueId === cueId) {
      activeCueId = null;
    }
    renderSubtitleList();
    renderTimeline();
    updatePreview();
  };

  const deleteSelectedSubtitleCues = (): void => {
    const selectedIds = selectedCueIds.size > 0
      ? new Set(selectedCueIds)
      : new Set(selectedCueId ? [selectedCueId] : []);
    if (selectedIds.size === 0) {
      return;
    }
    cues = cues.filter(cue => !selectedIds.has(cue.id));
    for (const cueId of selectedIds) {
      selectedCueIds.delete(cueId);
      if (activeCueId === cueId) {
        activeCueId = null;
      }
    }
    selectedCueId = cues.find(cue => cue.start >= media.currentTime)?.id
      || cues.at(-1)?.id
      || null;
    selectedCueIds.clear();
    if (selectedCueId) {
      selectedCueIds.add(selectedCueId);
    }
    renderSubtitleList();
    renderTimeline();
    updatePreview();
  };

  subtitleList.addEventListener("click", event => {
    const target = event.target as HTMLElement;
    const deleteId = target.dataset.deleteCue;
    if (deleteId) {
      deleteSubtitleCue(deleteId);
      return;
    }
    if (target.matches("textarea, input, button")) {
      return;
    }
    const card = target.closest<HTMLElement>(".subtitle-card");
    if (card?.dataset.cueId) {
      const cue = cues.find(item => item.id === card.dataset.cueId);
      if (cue) {
        selectCue(cue.id, isMultiSelectEvent(event));
        if (!isMultiSelectEvent(event)) {
          media.currentTime = cue.start;
          updatePreview();
        }
        renderTimeline();
        syncSubtitleSelection(true);
      }
    }
  });

  subtitleList.addEventListener("focusin", event => {
    const target = event.target as HTMLElement;
    const card = target.closest<HTMLElement>(".subtitle-card");
    if (!card?.dataset.cueId) {
      return;
    }
    selectCue(card.dataset.cueId);
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
      const { previousEnd } = getSubtitleNeighborBounds(cue);
      const enteredValue = Number(target.value);
      if (!Number.isFinite(enteredValue)) {
        return;
      }
      cue.start = clamp(
        enteredValue,
        previousEnd,
        cue.end - subtitleMinimumDuration,
      );
      if (cue.start !== enteredValue) {
        target.value = cue.start.toFixed(2);
      }
      const endInput = card?.querySelector<HTMLInputElement>('[data-time="end"]');
      if (endInput) {
        endInput.min = (cue.start + subtitleMinimumDuration).toFixed(2);
      }
    } else if (target.dataset.time === "end") {
      const { nextStart } = getSubtitleNeighborBounds(cue);
      const enteredValue = Number(target.value);
      if (!Number.isFinite(enteredValue)) {
        return;
      }
      cue.end = clamp(
        enteredValue,
        cue.start + subtitleMinimumDuration,
        nextStart,
      );
      if (cue.end !== enteredValue) {
        target.value = cue.end.toFixed(2);
      }
      const startInput = card?.querySelector<HTMLInputElement>('[data-time="start"]');
      if (startInput) {
        startInput.max = (cue.end - subtitleMinimumDuration).toFixed(2);
      }
    }
    renderTimeline();
    updatePreview();
  });

  queryElement<HTMLButtonElement>("#addSubtitleButton").addEventListener("click", () => {
    const start = clamp(
      media.currentTime,
      0,
      Math.max(0, duration - subtitleMinimumDuration),
    );
    const containingCueIndex = cues.findIndex(existingCue => (
      start > existingCue.start
      && start < existingCue.end
    ));

    if (containingCueIndex >= 0) {
      const containingCue = cues[containingCueIndex];
      const nextCue = cues[containingCueIndex + 1];
      const availableEnd = Math.min(duration, nextCue?.start ?? duration);
      const retainedDuration = start - containingCue.start;
      const availableNewDuration = availableEnd - start;
      if (
        retainedDuration < subtitleMinimumDuration
        || availableNewDuration < subtitleMinimumDuration
      ) {
        return;
      }

      containingCue.end = start;
      const splitCue: SubtitleCue = {
        id: crypto.randomUUID(),
        start,
        end: Math.min(start + 3, availableEnd),
        text: "New subtitle",
      };
      cues.splice(containingCueIndex + 1, 0, splitCue);
      selectCue(splitCue.id);
      activeCueId = splitCue.id;
      renderSubtitleList();
      renderTimeline();
      updatePreview();
      syncSubtitleSelection(true);
      return;
    }

    const nextCue = cues.find(existingCue => existingCue.start >= start);
    const availableEnd = Math.min(duration, nextCue?.start ?? duration);
    if (availableEnd - start < subtitleMinimumDuration) {
      return;
    }
    const cue: SubtitleCue = {
      id: crypto.randomUUID(),
      start,
      end: Math.min(availableEnd, start + 3),
      text: "New subtitle",
    };
    cues.push(cue);
    cues.sort((left, right) => left.start - right.start);
    selectCue(cue.id);
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
    updateSaveAvailability();
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
    updateSubtitlePreviewRendering();
    saveEditorProject(project);
    updateSaveAvailability();
  });
  karaokeToggleInput.addEventListener("change", () => {
    karaokeEnabled = karaokeToggleInput.checked;
    project.karaokeEnabled = karaokeEnabled;
    project.karaokeHighlightColor = karaokeHighlightColor;
    saveEditorProject(project);
    updateSaveAvailability();
    updatePreview();
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

  const projectApiBaseUrl = getProjectApiBaseUrl(project);

  const getProjectDownloadUrl = (sourceBlobName: string): string => (
    `${projectApiBaseUrl}/projects/download?source_blob_name=${encodeURIComponent(sourceBlobName)}`
  );

  const getProjectAudioDownloadUrl = (sourceBlobName: string): string => (
    `${projectApiBaseUrl}/projects/download-audio?source_blob_name=${encodeURIComponent(sourceBlobName)}`
  );

  const downloadVideoUrl = (url: string): void => {
    const link = document.createElement("a");
    link.href = url;
    link.download = `${project.title || "benzaiten-video"}.mp4`;
    document.body.append(link);
    link.click();
    link.remove();
  };

  const stopExportProgress = (): void => {
    if (exportProgressTimer !== null) {
      window.clearInterval(exportProgressTimer);
      exportProgressTimer = null;
    }
  };

  const cancelActiveExportRender = (): void => {
    if (!activeExportRenderId) {
      return;
    }
    const renderId = activeExportRenderId;
    activeExportRenderId = null;
    void authFetch(`${projectApiBaseUrl}/projects/render-cancel/${encodeURIComponent(renderId)}`, {
      method: "POST",
      keepalive: true,
    }).catch(error => {
      console.info(`${LOG_PREFIX} Could not cancel export render`, error);
    });
  };

  const cancelExportRenderForNavigation = (): void => {
    if (!exportAbortController && !activeExportRenderId) {
      return;
    }
    exportWasCancelled = true;
    cancelActiveExportRender();
    exportAbortController?.abort();
    exportAbortController = null;
    stopExportProgress();
  };

  const setExportProgress = (percent: number, status: string): void => {
    const safePercent = clamp(Math.round(percent), 0, 100);
    exportRenderPercent.textContent = `${safePercent}%`;
    exportRenderStatus.textContent = status;
    exportProgressFill.style.width = `${safePercent}%`;
  };

  const startEstimatedExportProgress = (): void => {
    stopExportProgress();
    let progress = 7;
    setExportProgress(progress, "Preparing render...");
    exportProgressTimer = window.setInterval(() => {
      progress = Math.min(88, progress + Math.max(1, (90 - progress) * 0.08));
      const status = progress < 24
        ? "Preparing render..."
        : progress < 72
          ? "Rendering subtitles into the video..."
          : "Publishing preview...";
      setExportProgress(progress, status);
      if (progress >= 88) {
        stopExportProgress();
      }
    }, 650);
  };

  const closeExportPreview = (): void => {
    stopExportProgress();
    if (exportAbortController) {
      exportWasCancelled = true;
      cancelExportRenderForNavigation();
    }
    saveChangesButton.textContent = "Save changes";
    updateSaveAvailability();
    exportPreviewModal.hidden = true;
    exportPreviewModal.classList.remove("is-open");
    exportPreviewVideo.pause();
    exportPreviewVideo.removeAttribute("src");
    exportPreviewVideo.load();
  };

  const editorNavigationAbortController = new AbortController();
  window.addEventListener(
    "hashchange",
    () => {
      if (window.location.hash !== "#editor") {
        cancelExportRenderForNavigation();
        editorNavigationAbortController.abort();
      }
    },
    { signal: editorNavigationAbortController.signal },
  );
  window.addEventListener(
    "pagehide",
    cancelExportRenderForNavigation,
    { signal: editorNavigationAbortController.signal },
  );

  const openExportProgress = (): void => {
    exportWasCancelled = false;
    media.pause();
    for (const source of sources) {
      source.element?.pause();
    }
    setPlayButtonState(false);
    playbackRequested = false;
    setVideoLoading(false);
    exportPreviewTitle.textContent = project.title || "Benzaiten video";
    exportPreviewVideo.hidden = true;
    exportPreviewVideo.removeAttribute("src");
    exportPreviewVideo.load();
    exportRenderProgress.hidden = false;
    exportPreviewModal.hidden = false;
    exportPreviewModal.classList.add("is-open");
    startEstimatedExportProgress();
  };

  const openExportPreview = (previewUrl: string): void => {
    stopExportProgress();
    setExportProgress(100, "Preview ready.");
    exportPreviewTitle.textContent = project.title || "Benzaiten video";
    exportPreviewVideo.src = previewUrl;
    exportPreviewVideo.hidden = false;
    exportRenderProgress.hidden = true;
    exportPreviewModal.hidden = false;
    exportPreviewModal.classList.add("is-open");
    exportPreviewVideo.load();
  };

  exportVideoButton.addEventListener("click", async () => {
    exportVideoButton.disabled = true;
    editorSaveStatus.textContent = "Preparing export...";
    openExportProgress();
    try {
      if (project.isLocalMedia && project.mediaType === "video" && project.mediaUrl) {
        openExportPreview(project.mediaUrl);
        editorSaveStatus.textContent = "";
        return;
      }

      const sourceBlobName = project.mediaObjectName;
      if (project.mediaType !== "video" || !sourceBlobName) {
        editorSaveStatus.textContent = "Only GCS video projects can currently be exported.";
        editorSaveStatus.classList.add("is-error");
        closeExportPreview();
        return;
      }

      exportAbortController = new AbortController();
      activeExportRenderId = crypto.randomUUID().replaceAll("-", "");
      const saved = await saveProjectChanges(
        false,
        exportAbortController.signal,
        activeExportRenderId,
      );
      exportAbortController = null;
      activeExportRenderId = null;
      if (!saved) {
        if (!exportWasCancelled) {
          closeExportPreview();
        } else {
          editorSaveStatus.textContent = "Export cancelled.";
          editorSaveStatus.classList.remove("is-error");
        }
        return;
      }

      if (!project.mediaObjectName || !latestRenderedPreviewUrl) {
        editorSaveStatus.textContent = "Unable to locate the rendered video preview.";
        editorSaveStatus.classList.add("is-error");
        closeExportPreview();
        return;
      }

      openExportPreview(latestRenderedPreviewUrl);
      editorSaveStatus.textContent = "Export preview ready.";
      editorSaveStatus.classList.remove("is-error");
    } finally {
      exportAbortController = null;
      activeExportRenderId = null;
      saveChangesButton.textContent = "Save changes";
      updateSaveAvailability();
    }
  });

  downloadMp4Button.addEventListener("click", () => {
    if (project.isLocalMedia && project.mediaType === "video" && project.mediaUrl) {
      downloadVideoUrl(project.mediaUrl);
      return;
    }
    if (!project.mediaObjectName) {
      editorSaveStatus.textContent = "Unable to locate the rendered video.";
      editorSaveStatus.classList.add("is-error");
      return;
    }
    void downloadAuthenticatedFile(
      getProjectDownloadUrl(project.mediaObjectName),
      `${project.title || "benzaiten-video"}.mp4`,
      projectApiBaseUrl,
    ).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      editorSaveStatus.textContent = `Download failed: ${message}`;
      editorSaveStatus.classList.add("is-error");
    });
  });

  downloadMp3Button.addEventListener("click", () => {
    if (!project.mediaObjectName || project.isLocalMedia) {
      editorSaveStatus.textContent = "Audio export is only available for rendered GCS projects.";
      editorSaveStatus.classList.add("is-error");
      return;
    }
    void downloadAuthenticatedFile(
      getProjectAudioDownloadUrl(project.mediaObjectName),
      `${project.title || "benzaiten-video"}.mp3`,
      projectApiBaseUrl,
    ).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      editorSaveStatus.textContent = `Audio download failed: ${message}`;
      editorSaveStatus.classList.add("is-error");
    });
  });

  exportPreviewModal.addEventListener("click", event => {
    if ((event.target as HTMLElement).closest("[data-export-preview-close]")) {
      closeExportPreview();
    }
  });

  window.addEventListener("keydown", event => {
    if (event.key === "Escape" && !exportPreviewModal.hidden) {
      closeExportPreview();
    }
  });

  const saveProjectChanges = async (
    background = false,
    signal?: AbortSignal,
    clientRenderId?: string,
  ): Promise<boolean> => {
    const sourceBlobName = project.mediaObjectName;
    const hasAddedMedia = sources.some(source => !source.isPrimary);
    const hasTimelineMediaChanges = sources.some(source => (
      source.isPrimary
      && (Math.abs(source.start) > 0.01 || Math.abs(source.duration - media.duration) > 0.05)
    ));

    editorSaveStatus.classList.remove("is-error");
    if (saveInFlight) {
      if (!background) {
        editorSaveStatus.textContent = "A save or export is already running.";
      }
      return false;
    }
    if (project.mediaType !== "video" || project.isLocalMedia || !sourceBlobName) {
      if (!background) {
        editorSaveStatus.textContent = (
          "Local projects stay in this browser until media upload is supported."
        );
        editorSaveStatus.classList.add("is-error");
      }
      return false;
    }
    if (hasAddedMedia || hasTimelineMediaChanges) {
      if (!background) {
        editorSaveStatus.textContent = (
          "Saving added or trimmed media tracks is not supported yet. "
          + "Reset those tracks before saving."
        );
        editorSaveStatus.classList.add("is-error");
      }
      return false;
    }

    saveInFlight = true;
    updateSaveAvailability();
    saveChangesButton.textContent = "Saving...";
    if (!background) {
      editorSaveStatus.textContent = "";
    }
    try {
      const response = await authJsonFetch(`${projectApiBaseUrl}/projects/save`, {
        method: "POST",
        signal,
        body: JSON.stringify({
          source_blob_name: sourceBlobName,
          title: project.title,
          cues: getSerializableCues(),
          subtitle_font_size: project.subtitleFontSize || 30,
          subtitle_transform: getSerializableSubtitleTransform(),
          karaoke_enabled: karaokeEnabled,
          karaoke_highlight_color: karaokeHighlightColor,
          client_render_id: clientRenderId,
        }),
      });
      if (!response.ok) {
        throw new Error(await getApiError(response));
      }

      const saved = await response.json() as SaveProjectResponse;
      project.title = saved.title;
      project.originalTitle = saved.title;
      project.mediaObjectName = saved.media_object_name;
      latestRenderedPreviewUrl = saved.media_url;
      project.mediaUrl = saved.render_source_url;
      project.subtitleObjectName = saved.subtitle_object_name;
      project.subtitleUrl = saved.subtitle_url;
      markProjectClean();
      if (!background) {
        projectTitleInput.value = saved.title;
        document.title = `${saved.title} | Benzaiten Editor`;
      }
      saveEditorProject(project);
      if (!background) {
        editorSaveStatus.textContent = saved.cleanup_warning || "Changes saved!";
        editorSaveStatus.classList.toggle("is-error", Boolean(saved.cleanup_warning));
      } else if (saved.cleanup_warning) {
        console.warn(`${LOG_PREFIX} Background save warning: ${saved.cleanup_warning}`);
      }
      return true;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        console.info(`${LOG_PREFIX} Project save aborted by user`);
        return false;
      }
      const errorMessage = error instanceof Error ? error.message : "";
      if (
        signal?.aborted
        || exportWasCancelled
        || /cancelled|code 255/i.test(errorMessage)
      ) {
        console.info(`${LOG_PREFIX} Project save cancelled`);
        return false;
      }
      if (!background) {
        editorSaveStatus.textContent = errorMessage || "Unable to save changes.";
        editorSaveStatus.classList.add("is-error");
      }
      console.error(`${LOG_PREFIX} Project save failed`, error);
      return false;
    } finally {
      saveInFlight = false;
      updateSaveAvailability();
      saveChangesButton.textContent = "Save changes";
    }
  };

  saveChangesButton.addEventListener("click", () => {
    if (!hasPersistableChanges()) {
      editorSaveStatus.textContent = "No changes to save.";
      editorSaveStatus.classList.remove("is-error");
      updateSaveAvailability();
      return;
    }
    void saveProjectChanges();
  });

  backButton.addEventListener("click", () => {
    if (!hasSavePrerequisites() && !saveInFlight && hasPersistableChanges()) {
      void saveProjectChanges(true);
    }
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
    if (!playbackRequested && media.paused) {
      playbackRequested = true;
      setVideoLoading(media.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
      applyVolume(volumePercent);
      applyPlaybackRate(playbackRate);
      requestPlayback(media, "editor preview");
    } else {
      playbackRequested = false;
      setVideoLoading(false);
      media.pause();
    }
  });
  skipBackButton.addEventListener("click", () => {
    media.currentTime = Math.max(0, media.currentTime - 5);
  });
  skipForwardButton.addEventListener("click", () => {
    media.currentTime = Math.min(duration, media.currentTime + 5);
  });

  const closeMediaPopovers = (): void => {
    volumePopover.hidden = true;
    speedPopover.hidden = true;
    volumeButton.setAttribute("aria-expanded", "false");
    speedButton.setAttribute("aria-expanded", "false");
  };

  volumeButton.addEventListener("click", event => {
    event.stopPropagation();
    const shouldOpen = volumePopover.hidden;
    closeMediaPopovers();
    volumePopover.hidden = !shouldOpen;
    volumeButton.setAttribute("aria-expanded", String(shouldOpen));
  });
  speedButton.addEventListener("click", event => {
    event.stopPropagation();
    const shouldOpen = speedPopover.hidden;
    closeMediaPopovers();
    speedPopover.hidden = !shouldOpen;
    speedButton.setAttribute("aria-expanded", String(shouldOpen));
  });
  mediaAdjustments.addEventListener("click", event => {
    event.stopPropagation();
  });
  volumeSlider.addEventListener("input", () => {
    applyVolume(Number(volumeSlider.value));
  });
  volumeInput.addEventListener("input", () => {
    if (volumeInput.value !== "") {
      applyVolume(Number(volumeInput.value), false);
    }
  });
  volumeInput.addEventListener("change", () => {
    applyVolume(Number(volumeInput.value) || 0);
  });
  speedSlider.addEventListener("input", () => {
    applyPlaybackRate(Number(speedSlider.value));
  });
  speedInput.addEventListener("input", () => {
    if (speedInput.value !== "") {
      applyPlaybackRate(Number(speedInput.value), false);
    }
  });
  speedInput.addEventListener("change", () => {
    applyPlaybackRate(Number(speedInput.value) || 1);
  });
  document.addEventListener("click", closeMediaPopovers);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      closeMediaPopovers();
      return;
    }
    if (event.key !== "Delete" && event.key !== "Backspace") {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (
      target?.matches("input, textarea, select")
      || target?.isContentEditable
      || (selectedCueIds.size === 0 && !selectedCueId)
    ) {
      return;
    }
    event.preventDefault();
    deleteSelectedSubtitleCues();
  });

  zoomInput.addEventListener("input", () => {
    zoom = Number(zoomInput.value);
    renderTimeline();
  });

  media.addEventListener("play", () => {
    playbackRequested = true;
    setPlayButtonState(true);
    startPreviewLoop();
  });
  media.addEventListener("playing", () => {
    setVideoLoading(false);
    startPreviewLoop();
  });
  media.addEventListener("waiting", () => {
    if (playbackRequested) {
      setVideoLoading(true);
    }
  });
  media.addEventListener("stalled", () => {
    if (playbackRequested) {
      setVideoLoading(true);
    }
  });
  media.addEventListener("canplay", () => {
    setVideoLoading(false);
  });
  media.addEventListener("pause", () => {
    stopPreviewLoop();
    setPlayButtonState(false);
    if (!playbackRequested) {
      setVideoLoading(false);
    }
    for (const source of sources) {
      source.element?.pause();
    }
  });
  media.addEventListener("ended", () => {
    stopPreviewLoop();
    playbackRequested = false;
    setVideoLoading(false);
  });
  media.addEventListener("error", () => {
    stopPreviewLoop();
    playbackRequested = false;
    setVideoLoading(false);
  });
  media.addEventListener("timeupdate", updatePreview);
  media.addEventListener("seeked", () => {
    setVideoLoading(false);
    updatePreview();
  });
  media.addEventListener("loadedmetadata", () => {
    duration = Number.isFinite(media.duration) ? media.duration : duration;
    media.playbackRate = playbackRate;
    mediaReady = true;
    project.isBlank = false;
    blankEditorDrop.hidden = true;
    playButton.disabled = false;
    skipBackButton.disabled = false;
    skipForwardButton.disabled = false;
    exportVideoButton.disabled = project.mediaType !== "video";
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
    const cueNeighborBounds = cue ? getSubtitleNeighborBounds(cue) : undefined;
    const dragPixelsPerSecond = pixelsPerSecond();
    const snapCandidates = getTimelineSnapCandidates(cue?.id, source?.id);
    if (cue) {
      selectCue(cue.id);
      syncSubtitleSelection(true);
    }
    if (source) {
      selectSource(source.id);
      syncSubtitleSelection();
    }

    const onMove = (moveEvent: PointerEvent): void => {
      const deltaSeconds = (moveEvent.clientX - startX) / dragPixelsPerSecond;
      timelineSnapTime = null;
      if (cue) {
        const cueDuration = originalEnd - originalStart;
        const previousEnd = cueNeighborBounds?.previousEnd ?? 0;
        const nextStart = cueNeighborBounds?.nextStart ?? duration;
        if (mode === "move") {
          const snapped = snapTimelineRange(
            originalStart + deltaSeconds,
            cueDuration,
            snapCandidates,
            previousEnd,
            nextStart - cueDuration,
            moveEvent.altKey,
          );
          cue.start = snapped.start;
          cue.end = cue.start + cueDuration;
          timelineSnapTime = snapped.snapTime;
        } else if (mode === "left") {
          const snapped = snapTimelineValue(
            originalStart + deltaSeconds,
            snapCandidates,
            previousEnd,
            cue.end - subtitleMinimumDuration,
            moveEvent.altKey,
          );
          cue.start = snapped.value;
          timelineSnapTime = snapped.snapTime;
        } else {
          const snapped = snapTimelineValue(
            originalEnd + deltaSeconds,
            snapCandidates,
            cue.start + subtitleMinimumDuration,
            nextStart,
            moveEvent.altKey,
          );
          cue.end = snapped.value;
          timelineSnapTime = snapped.snapTime;
        }
        selectCue(cue.id);
      }
      if (source) {
        if (mode === "move") {
          const snapped = snapTimelineRange(
            originalStart + deltaSeconds,
            source.duration,
            snapCandidates,
            0,
            Number.POSITIVE_INFINITY,
            moveEvent.altKey,
          );
          source.start = snapped.start;
          timelineSnapTime = snapped.snapTime;
          duration = Math.max(duration, source.start + source.duration);
        } else if (mode === "left") {
          const snapped = snapTimelineValue(
            originalStart + deltaSeconds,
            snapCandidates,
            0,
            originalEnd - 0.25,
            moveEvent.altKey,
          );
          source.duration = originalEnd - snapped.value;
          source.start = snapped.value;
          timelineSnapTime = snapped.snapTime;
        } else {
          const snapped = snapTimelineValue(
            originalEnd + deltaSeconds,
            snapCandidates,
            source.start + 0.25,
            duration,
            moveEvent.altKey,
          );
          source.duration = snapped.value - source.start;
          timelineSnapTime = snapped.snapTime;
        }
        selectSource(source.id);
      }
      renderTimeline();
    };

    const onUp = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      timelineSnapTime = null;
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
    if (!resize && isMultiSelectEvent(event)) {
      event.preventDefault();
      if (cueClip?.dataset.cueClip) {
        selectCue(cueClip.dataset.cueClip, true);
        syncSubtitleSelection();
        renderTimeline();
      } else if (sourceClip?.dataset.sourceId) {
        selectSource(sourceClip.dataset.sourceId, true);
        syncSubtitleSelection();
        renderTimeline();
      }
      return;
    }
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
      if (isMultiSelectEvent(event)) {
        return;
      }
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
    clearTimelineSelection();
    syncSubtitleSelection();
    renderTimeline();
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

  const fitPreviewToAvailableSpace = (): void => {
    const previewStyles = window.getComputedStyle(previewArea);
    const horizontalPadding = (
      Number.parseFloat(previewStyles.paddingLeft)
      + Number.parseFloat(previewStyles.paddingRight)
    );
    const verticalPadding = (
      Number.parseFloat(previewStyles.paddingTop)
      + Number.parseFloat(previewStyles.paddingBottom)
    );
    const stackGap = Number.parseFloat(window.getComputedStyle(previewStack).rowGap) || 0;
    const controlsHeight = mediaAdjustments.getBoundingClientRect().height;
    const availableWidth = Math.max(240, previewArea.clientWidth - horizontalPadding);
    const availableVideoHeight = Math.max(
      180,
      previewArea.clientHeight - verticalPadding - stackGap - controlsHeight,
    );
    const fittedWidth = Math.min(availableWidth, availableVideoHeight * 16 / 9);
    previewStage.style.width = `${fittedWidth}px`;
    updateSubtitlePreviewRendering();
  };

  window.requestAnimationFrame(fitPreviewToAvailableSpace);
  const previewResizeObserver = new ResizeObserver(updateSubtitlePreviewRendering);
  previewResizeObserver.observe(previewStage);

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
    const workspaceHeight = editorWorkspace.clientHeight;
    const transportHeight = queryElement<HTMLDivElement>(
      ".transport-bar",
      editorWorkspace,
    ).getBoundingClientRect().height;
    const resizerHeight = timelineResizer.getBoundingClientRect().height;
    const previewStyles = window.getComputedStyle(previewArea);
    const previewVerticalPadding = (
      Number.parseFloat(previewStyles.paddingTop)
      + Number.parseFloat(previewStyles.paddingBottom)
    );
    const mediaControlsHeight = mediaAdjustments.getBoundingClientRect().height;
    const stackGap = Number.parseFloat(window.getComputedStyle(previewStack).rowGap) || 0;
    const minimumVideoHeight = Math.min(
      280,
      Math.max(180, previewStage.getBoundingClientRect().width * 9 / 16 * 0.45),
    );
    const minimumPreviewHeight = (
      previewVerticalPadding
      + minimumVideoHeight
      + stackGap
      + mediaControlsHeight
    );
    const maximum = Math.max(
      150,
      workspaceHeight - transportHeight - resizerHeight - minimumPreviewHeight,
    );
    const clampedHeight = clamp(height, 150, maximum);
    editorWorkspace.style.setProperty("--timeline-panel-height", `${clampedHeight}px`);
    previousTimelineHeight = clampedHeight;
    window.requestAnimationFrame(fitPreviewToAvailableSpace);
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

  window.addEventListener("resize", fitPreviewToAvailableSpace);

  const addSecondaryMedia = (file: File): void => {
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
  };

  const addEditorMedia = (files: File[]): void => {
    const mediaFiles = files.filter(file => (
      file.type.startsWith("video/") || file.type.startsWith("audio/")
    ));
    if (!mediaFiles.length) {
      return;
    }

    let remainingFiles = mediaFiles;
    if (!mediaReady && project.isBlank) {
      const primaryFile = mediaFiles[0];
      const primaryUrl = URL.createObjectURL(primaryFile);
      project.title = filenameWithoutExtension(primaryFile.name) || "Untitled project";
      project.mediaUrl = primaryUrl;
      project.mediaType = primaryFile.type.startsWith("video/") ? "video" : "audio";
      project.isBlank = false;
      project.isLocalMedia = true;
      projectTitleInput.value = project.title;
      audioPreviewTitle.textContent = project.title;
      document.title = `${project.title} | Benzaiten Editor`;
      blankEditorDrop.hidden = true;
      media.style.display = project.mediaType === "video" ? "block" : "none";
      audioPreview.classList.toggle("is-visible", project.mediaType === "audio");
      media.src = primaryUrl;
      media.load();
      saveEditorProject(project);
      remainingFiles = mediaFiles.slice(1);
      if (remainingFiles.length) {
        media.addEventListener("loadedmetadata", () => {
          for (const file of remainingFiles) {
            addSecondaryMedia(file);
          }
        }, { once: true });
      }
      return;
    }

    for (const file of remainingFiles) {
      addSecondaryMedia(file);
    }
  };

  blankEditorDrop.addEventListener("click", () => {
    editorMediaInput.click();
  });
  editorMediaInput.addEventListener("change", () => {
    addEditorMedia([...(editorMediaInput.files || [])]);
    editorMediaInput.value = "";
  });

  for (const dropTarget of [previewArea, timelineShell]) {
    for (const eventName of ["dragenter", "dragover"]) {
      dropTarget.addEventListener(eventName, event => {
        event.preventDefault();
        timelineShell.classList.add("is-dragging");
        if (project.isBlank) {
          blankEditorDrop.classList.add("is-dragging");
        }
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      dropTarget.addEventListener(eventName, event => {
        event.preventDefault();
        timelineShell.classList.remove("is-dragging");
        blankEditorDrop.classList.remove("is-dragging");
      });
    }
    dropTarget.addEventListener("drop", event => {
      event.preventDefault();
      addEditorMedia([...(event.dataTransfer?.files || [])]);
    });
  }

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
      clearTimelineSelection();
      subtitlesReady = true;
      updateSaveAvailability();
      renderSubtitleList();
      renderTimeline();
      markProjectClean();
      return;
    }
    try {
      const response = await fetch(project.subtitleUrl);
      if (!response.ok) {
        throw new Error(`Subtitle request returned ${response.status}`);
      }
      cues = parseSubtitleFile(await response.text());
      normalizeSubtitleTiming();
      clearTimelineSelection();
      if (cues[0]) {
        selectCue(cues[0].id);
      }
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
    markProjectClean();
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
