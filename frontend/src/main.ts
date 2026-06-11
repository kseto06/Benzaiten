import "./style.css";

const GCS_BUCKET = "benzaiten-outputs";
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;
const PROJECT_STORAGE_KEY = "benzaiten-editor-project";
const LOG_PREFIX = "[Benzaiten]";

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

type GcsObject = {
  name: string;
};

type GcsObjectListResponse = {
  items?: GcsObject[];
  nextPageToken?: string;
};

type EditorProject = {
  title: string;
  jobId?: string;
  mediaUrl: string;
  subtitleUrl?: string;
  mediaType: "video" | "audio";
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
      fields: "items(name),nextPageToken",
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
  app.innerHTML = `
    <div class="app-shell">
      <header class="site-header">
        <a class="brand" href="#top" aria-label="Benzaiten home">
          <span class="brand-mark">B</span>
          <span>Benzaiten</span>
        </a>
        <nav class="header-nav" aria-label="Main navigation">
          <a href="#create">Create</a>
          <a href="#library">Library</a>
          <a href="#workflow">Workflow</a>
          <a class="button button-quiet" href="#create">Start a project</a>
        </nav>
      </header>

      <main>
        <section class="hero-section" id="top">
          <div class="hero-content">
            <div class="eyebrow"><span class="eyebrow-dot"></span> Browser-based karaoke studio</div>
            <h1 class="hero-title">Benzaiten</h1>
            <p class="hero-subtitle">Karaoke Orchestration Video Maker</p>
            <p class="hero-copy">
              Turn a performance into separated audio, timed lyrics, and an editable
              karaoke video. Build in the cloud, then refine every cue in the browser.
            </p>
            <div class="hero-actions">
              <a class="button" href="#create">Create karaoke video</a>
              <a class="button button-secondary" href="#library">Open existing project</a>
            </div>
          </div>
        </section>

        <section class="content-section" id="create">
          <div class="section-inner">
            <div class="section-heading">
              <p class="section-kicker">Create</p>
              <h2 class="section-title">From source media to an editable timeline.</h2>
              <p class="section-description">
                Upload a performance and Benzaiten will orchestrate source separation,
                optional crowd reduction, transcription, and final composition.
              </p>
            </div>

            <div class="workspace-grid">
              <section class="panel">
                <div class="panel-body">
                  <div class="panel-heading">
                    <div>
                      <h3>New inference</h3>
                      <p>Submit media to the existing orchestration API.</p>
                    </div>
                    <span class="number-badge">01</span>
                  </div>

                  <div class="upload-zone" id="uploadZone">
                    <input id="fileInput" type="file" accept="video/*,audio/*" />
                    <div>
                      <div class="upload-icon">+</div>
                      <div class="upload-title">Drop a video here or browse</div>
                      <div class="upload-help">MP4, MOV, WebM, MP3, or WAV</div>
                    </div>
                  </div>
                  <div class="selected-file" id="selectedFile"></div>

                  <div class="form-grid">
                    <div class="field">
                      <label for="languageInput">Audio language</label>
                      <input class="input" id="languageInput" value="ko" placeholder="e.g. en, ko, ja" />
                    </div>
                    <div class="field">
                      <label for="projectNameInput">Project name</label>
                      <input class="input" id="projectNameInput" placeholder="Uses the uploaded filename" />
                    </div>
                    <label class="toggle-row field-wide">
                      <input id="shouldDecrowdInput" type="checkbox" />
                      <span class="toggle-copy">
                        Reduce audience noise
                        <span>Useful for live performances and concert recordings.</span>
                      </span>
                    </label>
                    <label class="toggle-row field-wide">
                      <input id="fastDecrowdInput" type="checkbox" disabled />
                      <span class="toggle-copy">
                        Fast crowd reduction
                        <span>Only processes the first and last 30 seconds.</span>
                      </span>
                    </label>
                  </div>

                  <div class="form-actions">
                    <button class="button" id="runInferenceButton">Run orchestration</button>
                  </div>

                  <div class="progress-panel" id="progressPanel">
                    <div class="progress-header">
                      <div>
                        <h4 id="progressTitle">Preparing your project</h4>
                        <p id="progressDetail">Uploading media to the pipeline.</p>
                      </div>
                      <span class="progress-number" id="progressNumber">0%</span>
                    </div>
                    <div class="progress-track">
                      <div class="progress-fill" id="progressFill"></div>
                    </div>
                    <div class="stage-list" id="stageList"></div>
                  </div>

                  <p class="status-message" id="statusText" aria-live="polite"></p>
                </div>
              </section>

              <section class="panel" id="library">
                <div class="panel-body">
                  <div class="panel-heading">
                    <div>
                      <h3>Project library</h3>
                      <p>Search completed GCS outputs without a job ID.</p>
                    </div>
                    <span class="number-badge">02</span>
                  </div>
                  <div class="field">
                    <label for="videoNameInput">Song or project title</label>
                    <div class="search-wrap">
                      <input
                        class="input"
                        id="videoNameInput"
                        placeholder="e.g. Practice Love"
                      />
                      <button class="button" id="loadButton">Find project</button>
                    </div>
                  </div>
                  <div class="library-note">
                    Search is Unicode-aware and accepts partial or close matches. For example,
                    an English fragment can match a title that also contains foreign characters.
                  </div>
                </div>
              </section>
            </div>
          </div>
        </section>

        <section class="content-section features-section" id="workflow">
          <div class="section-inner">
            <div class="section-heading">
              <p class="section-kicker">Workflow</p>
              <h2 class="section-title">Cloud processing, browser editing.</h2>
              <p class="section-description">
                The editor reads completed media and subtitle assets directly from GCS.
                No new editing endpoints are required.
              </p>
            </div>
            <div class="feature-grid">
              <article class="feature-card">
                <span>01</span>
                <h3>Orchestrate</h3>
                <p>Track source separation, crowd reduction, transcription, and composition as they complete.</p>
              </article>
              <article class="feature-card">
                <span>02</span>
                <h3>Edit subtitles</h3>
                <p>Adjust multiline text, timing, and cue order alongside the video timeline.</p>
              </article>
              <article class="feature-card">
                <span>03</span>
                <h3>Arrange media</h3>
                <p>Drop additional local video or audio, then drag and trim clips in the browser.</p>
              </article>
            </div>
          </div>
        </section>
      </main>

      <footer class="site-footer">
        <span>Benzaiten karaoke orchestration studio</span>
        <span>Media and subtitles remain sourced from Google Cloud Storage.</span>
      </footer>
    </div>
  `;

  setupLandingInteractions();
}

function setupLandingInteractions(): void {
  const fileInput = queryElement<HTMLInputElement>("#fileInput");
  const uploadZone = queryElement<HTMLDivElement>("#uploadZone");
  const selectedFile = queryElement<HTMLDivElement>("#selectedFile");
  const shouldDecrowd = queryElement<HTMLInputElement>("#shouldDecrowdInput");
  const fastDecrowd = queryElement<HTMLInputElement>("#fastDecrowdInput");
  const runButton = queryElement<HTMLButtonElement>("#runInferenceButton");
  const searchInput = queryElement<HTMLInputElement>("#videoNameInput");
  const searchButton = queryElement<HTMLButtonElement>("#loadButton");

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
      jobId: startData.job_id,
      mediaUrl,
      subtitleUrl: completed.subtitle_url,
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
    const objects = await listGcsObjects();
    const matches = objects
      .filter(object => isSearchableMediaObject(object.name))
      .map(object => ({
        object,
        score: getFuzzyMatchScore(query, getObjectFilename(object.name)),
      }))
      .sort((left, right) => right.score - left.score);
    const match = matches[0];
    if (!match || match.score < 0.45) {
      throw new Error(`No close match was found for "${query}"`);
    }

    const jobId = match.object.name.split("/")[1];
    const subtitle = objects.find(object => (
      object.name.startsWith(`outputs/${jobId}/`)
      && object.name.endsWith("/vocals.vtt")
    ));
    const filename = getObjectFilename(match.object.name);
    const isVideo = filename.toLocaleLowerCase().endsWith(".mp4");
    console.log(`${LOG_PREFIX} Library match`, {
      query,
      score: match.score,
      media: match.object.name,
      subtitle: subtitle?.name,
    });

    openEditor({
      title: filenameWithoutExtension(filename),
      jobId,
      mediaUrl: buildGcsObjectUrl(match.object.name),
      subtitleUrl: subtitle ? buildGcsObjectUrl(subtitle.name) : undefined,
      mediaType: isVideo ? "video" : "audio",
    });
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
  app.innerHTML = `
    <div class="editor-page">
      <header class="editor-header">
        <button class="editor-back" id="backButton" type="button"><span>&larr;</span> Projects</button>
        <div class="editor-project-title">${escapeHtml(project.title)}</div>
        <div class="editor-actions">
          <button class="button button-quiet" id="exportVttButton">Export VTT</button>
        </div>
      </header>

      <main class="editor-main">
        <aside class="subtitle-panel" id="subtitlePanel">
          <div class="subtitle-panel-header">
            <h2>Subtitles</h2>
            <p>Edit multiline cues and timing. Changes stay in this browser session.</p>
          </div>
          <div class="subtitle-toolbar">
            <button class="button button-quiet" id="addSubtitleButton">+ Add subtitle</button>
          </div>
          <div class="subtitle-list" id="subtitleList">
            <div class="empty-subtitles">Loading subtitle cues from GCS...</div>
          </div>
        </aside>

        <div class="panel-resizer" id="panelResizer" role="separator" aria-label="Resize subtitle panel" aria-orientation="vertical">
          <button class="panel-collapse-button" id="panelCollapseButton" type="button" title="Collapse subtitle panel" aria-label="Collapse subtitle panel">
            <span aria-hidden="true">&lsaquo;</span>
          </button>
        </div>

        <section class="editor-workspace">
          <div class="preview-area">
            <div class="preview-stage">
              <video id="editorMedia" crossorigin="anonymous" preload="metadata"></video>
              <div class="audio-preview" id="audioPreview">
                <div class="audio-disc">B</div>
                <strong>${escapeHtml(project.title)}</strong>
              </div>
              <div class="subtitle-overlay" id="subtitleOverlay"></div>
            </div>
          </div>

          <div class="transport-bar">
            <div class="transport-left">
              <button class="transport-button" id="skipBackButton" title="Back 5 seconds" aria-label="Back 5 seconds">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 7 6 12l5 5v-3.5c3.2 0 5.4 1 7 3.5-.4-5-3-7.5-7-7.5V7Z"/><text x="10.5" y="14.3">5</text></svg>
              </button>
              <button class="transport-button play" id="playButton" title="Play" aria-label="Play">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path class="play-icon-path" d="m9 7 8 5-8 5V7Z"/></svg>
              </button>
              <button class="transport-button" id="skipForwardButton" title="Forward 5 seconds" aria-label="Forward 5 seconds">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 7 5 5-5 5v-3.5c-3.2 0-5.4 1-7 3.5.4-5 3-7.5 7-7.5V7Z"/><text x="7.5" y="14.3">5</text></svg>
              </button>
            </div>
            <div class="transport-center">
              <span class="time-display" id="timeDisplay">00:00 / 00:00</span>
            </div>
            <div class="transport-right">
              <span title="Use the slider, Ctrl/Cmd + mouse wheel, or a touchpad pinch">Zoom</span>
              <input class="zoom-input" id="zoomInput" type="range" min="4" max="20" value="8" />
            </div>
          </div>

          <div class="timeline-shell" id="timelineShell">
            <div class="timeline-scroll" id="timelineScroll">
              <div class="timeline-content" id="timelineContent"></div>
            </div>
            <div class="timeline-drop-hint">Drop media here. Pinch or Ctrl/Cmd + wheel to zoom.</div>
          </div>
        </section>
      </main>
    </div>
  `;

  setupEditor(project);
}

function setupEditor(project: EditorProject): void {
  const editorMain = queryElement<HTMLElement>(".editor-main");
  const subtitlePanel = queryElement<HTMLElement>("#subtitlePanel");
  const panelResizer = queryElement<HTMLDivElement>("#panelResizer");
  const panelCollapseButton = queryElement<HTMLButtonElement>("#panelCollapseButton");
  const media = queryElement<HTMLVideoElement>("#editorMedia");
  const audioPreview = queryElement<HTMLDivElement>("#audioPreview");
  const subtitleList = queryElement<HTMLDivElement>("#subtitleList");
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

  media.src = project.mediaUrl;
  media.style.display = project.mediaType === "video" ? "block" : "none";
  audioPreview.classList.toggle("is-visible", project.mediaType === "audio");

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
    const width = Math.min(6000, getTimelineWidth());
    const height = 46;
    canvas.width = width;
    canvas.height = height;
    context.clearRect(0, 0, width, height);
    context.fillStyle = "rgba(19, 104, 153, 0.6)";
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
      const barHeight = Math.max(2, amplitude * (height - 5));
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
        <div class="track-row">
          <div class="track-label">${source.type === "video" ? "Video" : "Audio"}</div>
          <div class="track-lane" style="width:${width}px">
            ${source.type === "audio" ? `<canvas class="waveform" data-waveform="${source.id}"></canvas>` : ""}
            <div
              class="clip ${sourceClass} ${source.id === selectedSourceId ? "is-selected" : ""}"
              data-source-id="${source.id}"
              style="left:${source.start * pixelsPerSecond()}px;width:${Math.max(20, source.duration * pixelsPerSecond())}px"
            >
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
    if (project.mediaType === "audio") {
      void buildWaveform(project.mediaUrl).then(samples => {
        waveformSamples = samples;
        renderTimeline();
      });
    }
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
    } catch (error) {
      console.error(`${LOG_PREFIX} Could not load subtitles`, error);
      cues = [];
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
