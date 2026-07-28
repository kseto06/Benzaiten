import editorPageHtml from "../../pages/editor.html?raw";
import { API_BASE_URL, DEFAULT_KARAOKE_HIGHLIGHT_COLOR, LOG_PREFIX, getPreferredBrowserExportFormat } from "../common/config";
import { authFetch, authJsonFetch, currentUser, downloadAuthenticatedFile, firebaseAuth } from "../app/auth";
import { getEditorRenderCapabilities } from "../app/api";
import { getApiError } from "../common/errors";
import { app } from "../app/appRoot";
import { escapeHtml, queryElement } from "../common/dom";
import { setPlayButtonState as renderPlayButtonState } from "./mediaControls";
import { EditorAudioGraph } from "./audio";
import { drawCanvasText, drawKaraokeLineOnCanvas, waitForMediaEvent } from "./export";
import { clearVolatileEditorProject, getVolatileWarning, isVolatileProject, saveEditorProject } from "./state";
import {
  getSubtitleNeighborBounds as getSubtitleNeighborBoundsForCues,
  normalizeSubtitleCueTimings,
} from "./subtitles";
import type { BrowserExportFormat, EditorProject, SaveProjectResponse, SubtitleCue, SubtitleTransform, TimelineSource } from "../common/types";
import {
  clamp,
  filenameWithoutExtension,
  formatTime,
  parseSubtitleFile,
  renderKaraokeSubtitle,
} from "../common/utils";

export function renderEditor(project: EditorProject): void {
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
  const editorVolatileWarning = queryElement<HTMLDivElement>("#editorVolatileWarning");
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
  const pitchButton = queryElement<HTMLButtonElement>("#pitchButton");
  const volumePopover = queryElement<HTMLDivElement>("#volumePopover");
  const speedPopover = queryElement<HTMLDivElement>("#speedPopover");
  const pitchPopover = queryElement<HTMLDivElement>("#pitchPopover");
  const volumeSlider = queryElement<HTMLInputElement>("#volumeSlider");
  const volumeInput = queryElement<HTMLInputElement>("#volumeInput");
  const speedSlider = queryElement<HTMLInputElement>("#speedSlider");
  const speedInput = queryElement<HTMLInputElement>("#speedInput");
  const pitchSlider = queryElement<HTMLInputElement>("#pitchSlider");
  const pitchInput = queryElement<HTMLInputElement>("#pitchInput");
  const exportPreviewModal = queryElement<HTMLDivElement>("#exportPreviewModal");
  const exportPreviewVideo = queryElement<HTMLVideoElement>("#exportPreviewVideo");
  const exportPreviewTitle = queryElement<HTMLElement>("#exportPreviewTitle");
  const exportRenderProgress = queryElement<HTMLDivElement>("#exportRenderProgress");
  const exportRenderPercent = queryElement<HTMLElement>("#exportRenderPercent");
  const exportRenderStatus = queryElement<HTMLElement>("#exportRenderStatus");
  const exportProgressFill = queryElement<HTMLDivElement>("#exportProgressFill");
  const downloadMp4Button = queryElement<HTMLButtonElement>("#downloadMp4Button");
  const downloadMp3Button = queryElement<HTMLButtonElement>("#downloadMp3Button");
  const downloadVideoLabel = queryElement<HTMLElement>("strong", downloadMp4Button);
  const downloadVideoNote = queryElement<HTMLElement>("small", downloadMp4Button);
  const downloadAudioNote = queryElement<HTMLElement>("small", downloadMp3Button);
  let exportProgressTimer: number | null = null;
  let exportAbortController: AbortController | null = null;
  let activeExportRenderId: string | null = null;
  let latestRenderedPreviewUrl: string | null = null;
  let volatileRenderedVideoUrl: string | null = null;
  let volatileRenderedVideoBlob: Blob | null = null;
  let volatileRenderedVideoExtension: "mp4" | "webm" = "webm";
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
  const normalizePitchSemitones = (value: number): number => {
    const rounded = Math.round(clamp(Number.isFinite(value) ? value : 0, -12, 12) * 100) / 100;
    return Object.is(rounded, -0) ? 0 : rounded;
  };
  const formatPitchSemitones = (value: number): string => (
    normalizePitchSemitones(value).toFixed(2).replace(/0$/, "")
  );
  let pitchSemitones = normalizePitchSemitones(project.pitchSemitones ?? 0);
  let karaokeEnabled = project.karaokeEnabled ?? true;
  const karaokeHighlightColor = project.karaokeHighlightColor || DEFAULT_KARAOKE_HIGHLIGHT_COLOR;
  if (!isVolatileProject(project) && project.isBlank && project.isLocalMedia) {
    if (!firebaseAuth || !currentUser) {
      project.persistenceMode = "volatile";
      project.volatileReason = "signed_out";
    }
  }
  const isVolatile = isVolatileProject(project);
  const usesBrowserLocalExport = isVolatile || Boolean(project.isLocalMedia);
  const volatileWarning = isVolatile ? getVolatileWarning(project) : "";
  let playbackRequested = false;
  let previewAnimationId: number | null = null;
  const audioGraph = new EditorAudioGraph();
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
    pitchSemitones: normalizeSnapshotNumber(pitchSemitones),
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
  pitchSlider.value = String(pitchSemitones);
  pitchInput.value = formatPitchSemitones(pitchSemitones);
  karaokeToggleInput.checked = karaokeEnabled;
  overlay.style.setProperty("--karaoke-highlight-color", karaokeHighlightColor);
  editorVolatileWarning.hidden = !isVolatile;
  editorVolatileWarning.textContent = volatileWarning;
  saveChangesButton.title = isVolatile ? volatileWarning : "";
  if (usesBrowserLocalExport) {
    const browserExportFormat = getPreferredBrowserExportFormat();
    downloadVideoLabel.textContent = browserExportFormat?.label || "WEBM";
    downloadVideoNote.textContent = browserExportFormat?.isFallback
      ? "Browser-rendered fallback"
      : "Browser-rendered video";
    downloadAudioNote.textContent = "Unavailable for guest export";
    downloadMp3Button.disabled = true;
  }

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

  const connectAudibleMedia = async (): Promise<boolean> => {
    const elements = [
      media,
      ...sources.flatMap(source => source.element ? [source.element] : []),
    ];
    const connected = await Promise.all(
      elements.map(element => audioGraph.connectMediaElement(element)),
    );
    audioGraph.setVolume(volumePercent);
    audioGraph.setPlaybackRate(playbackRate);
    audioGraph.setPitchSemitones(pitchSemitones);
    return connected.every(Boolean) && audioGraph.pitchSupported;
  };

  const applyVolume = (value: number, syncNumberInput = true): void => {
    volumePercent = clamp(Math.round(value), 0, 200);
    audioGraph.setVolume(volumePercent);
    void connectAudibleMedia().then(() => audioGraph.resume());
    media.volume = Math.min(1, volumePercent / 100);
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
    audioGraph.setPlaybackRate(playbackRate);
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

  const setPitchControlsAvailable = (available: boolean, message = ""): void => {
    pitchButton.disabled = !available;
    pitchSlider.disabled = !available;
    pitchInput.disabled = !available;
    pitchButton.title = message;
  };

  const applyPitch = (value: number, syncNumberInput = true): void => {
    pitchSemitones = normalizePitchSemitones(value);
    audioGraph.setPitchSemitones(pitchSemitones);
    pitchSlider.value = String(pitchSemitones);
    if (syncNumberInput) {
      pitchInput.value = formatPitchSemitones(pitchSemitones);
    }
    project.pitchSemitones = pitchSemitones;
    saveEditorProject(project);
    updateSaveAvailability();

    void connectAudibleMedia().then(pitchAvailable => {
      if (pitchAvailable || Math.abs(pitchSemitones) < 0.001) {
        return;
      }
      const message = "Live pitch preview is unavailable in this browser.";
      editorSaveStatus.textContent = usesBrowserLocalExport
        ? `${message} Browser-local export requires pitch to remain at 0 st.`
        : `${message} Checking backend pitch support...`;
      editorSaveStatus.classList.add("is-error");
      if (usesBrowserLocalExport) {
        pitchSemitones = 0;
        project.pitchSemitones = 0;
        pitchSlider.value = "0";
        pitchInput.value = "0.0";
        audioGraph.setPitchSemitones(0);
        setPitchControlsAvailable(false, message);
      } else {
        void getEditorRenderCapabilities().then(capabilities => {
          if (Math.abs(pitchSemitones) < 0.001) {
            return;
          }
          if (!capabilities) {
            editorSaveStatus.textContent = (
              `${message} The backend render may still apply this pitch.`
            );
            return;
          }
          if (!capabilities.pitch_export_supported) {
            editorSaveStatus.textContent = (
              `${message} Backend pitch export is unavailable: `
              + (capabilities.detail || "FFmpeg rubberband support is missing.")
            );
            return;
          }
          const renderTarget = capabilities.render_mode === "local"
            ? "local FastAPI render"
            : "GKE video-pool render";
          editorSaveStatus.textContent = (
            `${message} The ${renderTarget} will still apply this pitch.`
          );
        });
      }
    });
  };

  if (usesBrowserLocalExport && !EditorAudioGraph.isPitchSupported()) {
    const capability = EditorAudioGraph.getPitchCapability();
    setPitchControlsAvailable(
      false,
      `${capability.reason} Pitched browser-local export is unavailable.`,
    );
  }

  const updateExportAvailability = (): void => {
    exportVideoButton.disabled = (
      saveInFlight
      || project.isBlank
      || project.mediaType !== "video"
    );
  };

  const updateSaveAvailability = (): void => {
    saveChangesButton.disabled = (
      isVolatile
      || saveInFlight
      || project.mediaType !== "video"
      || project.isLocalMedia
      || !mediaReady
      || !subtitlesReady
      || !hasPersistableChanges()
    );
    updateExportAvailability();
  };

  const showVolatileSaveWarning = (): void => {
    editorSaveStatus.textContent = volatileWarning;
    editorSaveStatus.classList.add("is-error");
    editorVolatileWarning.hidden = false;
    editorVolatileWarning.textContent = volatileWarning;
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

  const warnBeforeVolatileUnload = (event: BeforeUnloadEvent): void => {
    if (!isVolatile || (!hasPersistableChanges() && !project.mediaUrl && project.isBlank)) {
      return;
    }
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", warnBeforeVolatileUnload);

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
    normalizeSubtitleCueTimings(cues, subtitleMinimumDuration);
  };

  const getSubtitleNeighborBounds = (cue: SubtitleCue): {
    previousEnd: number;
    nextStart: number;
  } => getSubtitleNeighborBoundsForCues(cues, cue, duration);

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
      source.element.volume = audioGraph.hasMediaElement(source.element)
        ? 1
        : Math.min(1, volumePercent / 100);
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

  const getProjectDownloadUrl = (sourceBlobName: string): string => (
    `${API_BASE_URL}/projects/download?source_blob_name=${encodeURIComponent(sourceBlobName)}`
  );

  const getProjectAudioDownloadUrl = (sourceBlobName: string): string => (
    `${API_BASE_URL}/projects/download-audio?source_blob_name=${encodeURIComponent(sourceBlobName)}`
  );

  const downloadBlobUrl = (url: string, filename: string): void => {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
  };

  const drawSubtitleOverlayOnCanvas = (
    context: CanvasRenderingContext2D,
    canvasWidth: number,
    canvasHeight: number,
    time: number,
  ): void => {
    const activeCue = activeCueAt(time);
    if (!activeCue) {
      return;
    }
    const scale = canvasWidth / previewReferenceWidth;
    const fontSize = (project.subtitleFontSize || 30) * scale;
    const lines = activeCue.text.replace(/\r/g, "").split("\n");
    const lineHeight = fontSize * 1.25;
    const centerX = canvasWidth * subtitleTransform.x / 100;
    const centerY = canvasHeight * subtitleTransform.y / 100;
    const maxWidth = Math.max(80, canvasWidth * subtitleTransform.width / 100);

    context.save();
    context.translate(centerX, centerY);
    context.rotate(subtitleTransform.rotation * Math.PI / 180);
    context.font = `700 ${fontSize}px "DM Sans", Arial, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "alphabetic";

    const startY = -((lines.length - 1) * lineHeight) / 2;
    for (const [lineIndex, line] of lines.entries()) {
      const baselineY = startY + lineIndex * lineHeight + fontSize * 0.35;
      const measuredWidth = context.measureText(line).width;
      const lineScale = measuredWidth > maxWidth ? maxWidth / measuredWidth : 1;
      context.save();
      context.scale(lineScale, 1);
      const scaledCenterX = 0;
      if (karaokeEnabled) {
        drawKaraokeLineOnCanvas(
          context,
          activeCue,
          line,
          scaledCenterX,
          baselineY,
          fontSize,
          time,
          karaokeHighlightColor,
        );
      } else {
        drawCanvasText(context, line, scaledCenterX, baselineY, "#fff", fontSize);
      }
      context.restore();
    }
    context.restore();
  };

  const renderVolatileProjectInBrowser = async (
    signal: AbortSignal,
  ): Promise<{ url: string; format: BrowserExportFormat }> => {
    if (!project.mediaUrl || project.mediaType !== "video") {
      throw new Error("Add a local video before exporting.");
    }
    const exportFormat = getPreferredBrowserExportFormat();
    if (!exportFormat) {
      throw new Error("This browser does not support guest video export.");
    }
    if (volatileRenderedVideoUrl) {
      URL.revokeObjectURL(volatileRenderedVideoUrl);
      volatileRenderedVideoUrl = null;
      volatileRenderedVideoBlob = null;
    }
    setExportProgress(
      2,
      exportFormat.isFallback
        ? "MP4 is not supported in this browser. Rendering WebM instead..."
        : "Preparing browser MP4 render...",
    );

    const sourceVideo = document.createElement("video");
    sourceVideo.src = project.mediaUrl;
    sourceVideo.preload = "auto";
    sourceVideo.playsInline = true;
    sourceVideo.muted = true;
    sourceVideo.volume = 0;
    sourceVideo.playbackRate = playbackRate;

    await document.fonts?.ready;
    await waitForMediaEvent(sourceVideo, "loadedmetadata", signal);
    const renderDuration = Number.isFinite(sourceVideo.duration)
      ? sourceVideo.duration
      : duration;
    const primaryAudio = document.createElement("audio");
    primaryAudio.src = project.mediaUrl;
    primaryAudio.preload = "auto";
    primaryAudio.muted = true;
    primaryAudio.volume = 0;
    primaryAudio.playbackRate = playbackRate;
    const secondaryAudioSources = sources
      .filter(source => !source.isPrimary)
      .map(source => {
        const element = document.createElement(source.type === "video" ? "video" : "audio");
        element.src = source.url;
        element.preload = "auto";
        if (element instanceof HTMLVideoElement) {
          element.playsInline = true;
        }
        element.muted = true;
        element.volume = 0;
        element.playbackRate = playbackRate;
        return { source, element };
      });
    await Promise.all(
      [
        waitForMediaEvent(primaryAudio, "loadedmetadata", signal),
        ...secondaryAudioSources.map(({ element }) => (
          waitForMediaEvent(element, "loadedmetadata", signal)
        )),
      ],
    );
    const exportAudioSources = [
      {
        start: 0,
        duration: renderDuration,
        name: project.title,
        element: primaryAudio,
      },
      ...secondaryAudioSources.map(({ source, element }) => ({
        start: source.start,
        duration: source.duration,
        name: source.name,
        element,
      })),
    ];
    const canvas = document.createElement("canvas");
    canvas.width = 1280;
    canvas.height = 720;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas export is not available in this browser.");
    }

    const canvasStream = canvas.captureStream(30);
    const renderAudioGraph = new EditorAudioGraph({ captureOnly: true });
    try {
      const connected = await Promise.all(
        exportAudioSources.map(({ element }) => (
          renderAudioGraph.connectMediaElement(element)
        )),
      );
      renderAudioGraph.setVolume(volumePercent);
      renderAudioGraph.setPlaybackRate(playbackRate);
      renderAudioGraph.setPitchSemitones(pitchSemitones);
      if (connected.some(value => !value) || !renderAudioGraph.captureStream) {
        throw new Error("Guest export audio capture is unavailable.");
      }
      if (Math.abs(pitchSemitones) >= 0.001 && !renderAudioGraph.pitchSupported) {
        throw new Error(
          "This browser cannot apply pitch during guest export. Reset Pitch to 0 st.",
        );
      }
      for (const { element } of exportAudioSources) {
        element.muted = false;
        element.volume = 1;
      }
    } catch (error) {
      await renderAudioGraph.close();
      if (Math.abs(pitchSemitones) >= 0.001) {
        throw error;
      }
      console.info(`${LOG_PREFIX} Guest export audio capture is unavailable`, error);
    }
    const stream = new MediaStream([
      ...canvasStream.getVideoTracks(),
      ...(renderAudioGraph.captureStream?.getAudioTracks() || []),
    ]);
    const recorder = new MediaRecorder(stream, { mimeType: exportFormat.mimeType });
    const chunks: BlobPart[] = [];
    let frameId: number | null = null;
    let settled = false;
    let lastFrameDrawTime = -Infinity;
    const frameIntervalMs = 1000 / 30;

    const synchronizeExportAudio = (): void => {
      for (const source of exportAudioSources) {
        const sourceTime = sourceVideo.currentTime - source.start;
        const sourceDuration = Math.min(source.duration, source.element.duration);
        const shouldPlay = sourceTime >= 0 && sourceTime < sourceDuration;
        if (shouldPlay) {
          if (Math.abs(source.element.currentTime - sourceTime) > 0.15) {
            source.element.currentTime = sourceTime;
          }
          if (source.element.paused) {
            void source.element.play().catch(error => {
              console.info(
                `${LOG_PREFIX} Guest export source "${source.name}" could not play`,
                error,
              );
            });
          }
        } else if (!source.element.paused) {
          source.element.pause();
        }
      }
    };

    const scheduleFrame = (): void => {
      frameId = window.requestAnimationFrame(drawFrame);
    };

    const drawFrame = (timestamp = performance.now()): void => {
      if (signal.aborted || settled) {
        return;
      }
      if (timestamp - lastFrameDrawTime < frameIntervalMs) {
        scheduleFrame();
        return;
      }
      lastFrameDrawTime = timestamp;
      const videoWidth = sourceVideo.videoWidth || canvas.width;
      const videoHeight = sourceVideo.videoHeight || canvas.height;
      const scale = Math.min(canvas.width / videoWidth, canvas.height / videoHeight);
      const drawWidth = videoWidth * scale;
      const drawHeight = videoHeight * scale;
      const drawX = (canvas.width - drawWidth) / 2;
      const drawY = (canvas.height - drawHeight) / 2;

      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(sourceVideo, drawX, drawY, drawWidth, drawHeight);
      drawSubtitleOverlayOnCanvas(context, canvas.width, canvas.height, sourceVideo.currentTime);
      synchronizeExportAudio();

      const progress = renderDuration > 0
        ? clamp((sourceVideo.currentTime / renderDuration) * 100, 2, 99)
        : 50;
      setExportProgress(
        progress,
        exportFormat.isFallback
          ? "Rendering WebM in your browser..."
          : "Rendering MP4 in your browser...",
      );

      if (sourceVideo.ended || sourceVideo.currentTime >= renderDuration - 0.03) {
        if (recorder.state !== "inactive") {
          recorder.stop();
        }
        return;
      }
      scheduleFrame();
    };

    try {
      const blob = await new Promise<Blob>((resolve, reject) => {
        const pauseExportAudio = (): void => {
          for (const { element } of exportAudioSources) {
            element.pause();
          }
        };
        const pauseRecorderForVideoBuffering = (): void => {
          pauseExportAudio();
          if (recorder.state === "recording") {
            try {
              recorder.pause();
            } catch (error) {
              console.info(`${LOG_PREFIX} Guest export recorder could not pause`, error);
            }
          }
          console.warn(`${LOG_PREFIX} Guest export source video stalled`, {
            currentTime: sourceVideo.currentTime,
            readyState: sourceVideo.readyState,
            networkState: sourceVideo.networkState,
            pitchMetrics: renderAudioGraph.processorMetrics,
          });
        };
        const onVideoWaiting = (): void => {
          if (sourceVideo.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            pauseRecorderForVideoBuffering();
          }
        };
        const onVideoStalled = (): void => {
          if (sourceVideo.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            pauseRecorderForVideoBuffering();
          }
        };
        const resumeAfterVideoBuffering = (): void => {
          if (recorder.state === "paused") {
            try {
              recorder.resume();
            } catch (error) {
              console.info(`${LOG_PREFIX} Guest export recorder could not resume`, error);
            }
          }
          synchronizeExportAudio();
        };
        const cleanup = (): void => {
          signal.removeEventListener("abort", onAbort);
          sourceVideo.removeEventListener("ended", onEnded);
          sourceVideo.removeEventListener("waiting", onVideoWaiting);
          sourceVideo.removeEventListener("stalled", onVideoStalled);
          sourceVideo.removeEventListener("playing", resumeAfterVideoBuffering);
          sourceVideo.removeEventListener("canplay", resumeAfterVideoBuffering);
          if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
            frameId = null;
          }
          void renderAudioGraph.close().catch(error => {
            console.info(`${LOG_PREFIX} Guest export audio cleanup failed`, error);
          });
          for (const track of stream.getTracks()) {
            track.stop();
          }
        };
        const onAbort = (): void => {
          settled = true;
          sourceVideo.pause();
          if (recorder.state !== "inactive") {
            recorder.stop();
          }
          cleanup();
          reject(new DOMException("Export was cancelled.", "AbortError"));
        };
        const onEnded = (): void => {
          if (recorder.state !== "inactive") {
            recorder.stop();
          }
        };
        recorder.addEventListener("dataavailable", event => {
          if (event.data.size > 0) {
            chunks.push(event.data);
          }
        });
        recorder.addEventListener("stop", () => {
          if (settled || signal.aborted) {
            return;
          }
          settled = true;
          cleanup();
          resolve(new Blob(chunks, { type: exportFormat.mimeType }));
        }, { once: true });
        recorder.addEventListener("error", () => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(new Error("Browser video export failed."));
        }, { once: true });
        signal.addEventListener("abort", onAbort, { once: true });
        sourceVideo.addEventListener("ended", onEnded, { once: true });
        sourceVideo.addEventListener("waiting", onVideoWaiting);
        sourceVideo.addEventListener("stalled", onVideoStalled);
        sourceVideo.addEventListener("playing", resumeAfterVideoBuffering);
        sourceVideo.addEventListener("canplay", resumeAfterVideoBuffering);
        recorder.start(500);
        void (async () => {
          await renderAudioGraph.resume();
          await sourceVideo.play();
          synchronizeExportAudio();
          drawFrame(performance.now());
        })().catch(error => {
          if (!settled) {
            settled = true;
            if (recorder.state !== "inactive") {
              recorder.stop();
            }
            cleanup();
            reject(error);
          }
        });
      });
      volatileRenderedVideoBlob = blob;
      volatileRenderedVideoExtension = exportFormat.extension;
      volatileRenderedVideoUrl = URL.createObjectURL(blob);
      setExportProgress(100, "Preview ready.");
      return { url: volatileRenderedVideoUrl, format: exportFormat };
    } finally {
      sourceVideo.pause();
      for (const { element } of exportAudioSources) {
        element.pause();
        element.removeAttribute("src");
        element.load();
      }
      await renderAudioGraph.close();
      sourceVideo.removeAttribute("src");
      sourceVideo.load();
    }
  };

  const renderLocalProjectInBrowser = async (
    signal: AbortSignal,
  ): Promise<{ url: string; format: BrowserExportFormat }> => {
    if (!project.mediaUrl || project.mediaType !== "video") {
      throw new Error("Add a local video before exporting.");
    }
    try {
      const { renderBrowserProjectDeterministically } = await import("./browserExport");
      const result = await renderBrowserProjectDeterministically({
        mediaUrl: project.mediaUrl,
        duration,
        volumePercent,
        playbackRate,
        pitchSemitones,
        additionalAudioSources: sources
          .filter(source => !source.isPrimary)
          .map(source => ({
            name: source.name,
            url: source.url,
            start: source.start,
            duration: source.duration,
          })),
        signal,
        drawOverlay: drawSubtitleOverlayOnCanvas,
        onProgress: setExportProgress,
      });
      if (volatileRenderedVideoUrl) {
        URL.revokeObjectURL(volatileRenderedVideoUrl);
      }
      volatileRenderedVideoBlob = result.blob;
      volatileRenderedVideoExtension = result.format.extension;
      volatileRenderedVideoUrl = URL.createObjectURL(result.blob);
      setExportProgress(100, "Preview ready.");
      return {
        url: volatileRenderedVideoUrl,
        format: result.format,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      if (
        Math.abs(pitchSemitones) >= 0.001
        || Math.abs(playbackRate - 1) >= 0.001
      ) {
        throw error;
      }
      console.warn(
        `${LOG_PREFIX} Deterministic browser export unavailable; using MediaRecorder fallback`,
        error,
      );
      return renderVolatileProjectInBrowser(signal);
    }
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
    if (isVolatile) {
      return;
    }
    const cancelUrl = `${API_BASE_URL}/projects/render-cancel/${encodeURIComponent(renderId)}`;
    void authFetch(cancelUrl, { method: "POST", keepalive: true }).catch(error => {
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
        void audioGraph.close();
        window.removeEventListener("beforeunload", warnBeforeVolatileUnload);
        if (isVolatile) {
          clearVolatileEditorProject();
        }
        editorNavigationAbortController.abort();
      }
    },
    { signal: editorNavigationAbortController.signal },
  );
  window.addEventListener(
    "pagehide",
    () => {
      cancelExportRenderForNavigation();
      void audioGraph.close();
    },
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
      if (usesBrowserLocalExport) {
        if (project.mediaType !== "video" || project.isBlank || !project.mediaUrl) {
          editorSaveStatus.textContent = "Add a local video before exporting.";
          editorSaveStatus.classList.add("is-error");
          closeExportPreview();
          return;
        }
        exportAbortController = new AbortController();
        const { url: previewUrl, format } = await renderLocalProjectInBrowser(
          exportAbortController.signal,
        );
        exportAbortController = null;
        openExportPreview(previewUrl);
        downloadVideoLabel.textContent = format.label;
        downloadVideoNote.textContent = format.isFallback
          ? "Browser-rendered fallback"
          : "Browser-rendered video";
        editorSaveStatus.textContent = format.isFallback
          ? "MP4 is not supported in this browser, exported WebM instead."
          : "Browser MP4 export ready.";
        editorSaveStatus.classList.remove("is-error");
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
    } catch (error) {
      const wasAbort = error instanceof DOMException && error.name === "AbortError";
      if (wasAbort || exportWasCancelled) {
        editorSaveStatus.textContent = "Export cancelled.";
        editorSaveStatus.classList.remove("is-error");
      } else {
        const message = error instanceof Error ? error.message : "Unable to export video.";
        editorSaveStatus.textContent = `Export failed: ${message}`;
        editorSaveStatus.classList.add("is-error");
        console.error(`${LOG_PREFIX} Export failed`, error);
      }
      closeExportPreview();
    } finally {
      exportAbortController = null;
      activeExportRenderId = null;
      saveChangesButton.textContent = "Save changes";
      updateSaveAvailability();
    }
  });

  downloadMp4Button.addEventListener("click", () => {
    if (usesBrowserLocalExport) {
      if (!volatileRenderedVideoUrl || !volatileRenderedVideoBlob) {
        editorSaveStatus.textContent = "Use Export Video to render a download first.";
        editorSaveStatus.classList.add("is-error");
        return;
      }
      downloadBlobUrl(
        volatileRenderedVideoUrl,
        `${project.title || "benzaiten-video"}.${volatileRenderedVideoExtension}`,
      );
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
    ).catch(error => {
      const message = error instanceof Error ? error.message : String(error);
      editorSaveStatus.textContent = `Download failed: ${message}`;
      editorSaveStatus.classList.add("is-error");
    });
  });

  downloadMp3Button.addEventListener("click", () => {
    if (isVolatile) {
      editorSaveStatus.textContent = "Audio-only export is not available for temporary projects yet.";
      editorSaveStatus.classList.add("is-error");
      return;
    }
    if (!project.mediaObjectName || project.isLocalMedia) {
      editorSaveStatus.textContent = "Audio export is only available for rendered GCS projects.";
      editorSaveStatus.classList.add("is-error");
      return;
    }
    void downloadAuthenticatedFile(
      getProjectAudioDownloadUrl(project.mediaObjectName),
      `${project.title || "benzaiten-video"}.mp3`,
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
    if (isVolatile) {
      if (!background) {
        showVolatileSaveWarning();
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
      const response = await authJsonFetch(`${API_BASE_URL}/projects/save`, {
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
          pitch_semitones: pitchSemitones,
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
      project.pitchSemitones = saved.pitch_semitones;
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
    if (isVolatile) {
      clearVolatileEditorProject();
      window.location.hash = "";
      return;
    }
    if (!hasSavePrerequisites() && !saveInFlight && hasPersistableChanges()) {
      void saveProjectChanges(true);
    }
    window.location.hash = "";
  });

  const setPlayButtonState = (isPlaying: boolean): void => {
    renderPlayButtonState(playButton, isPlaying);
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
    pitchPopover.hidden = true;
    volumeButton.setAttribute("aria-expanded", "false");
    speedButton.setAttribute("aria-expanded", "false");
    pitchButton.setAttribute("aria-expanded", "false");
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
  pitchButton.addEventListener("click", event => {
    event.stopPropagation();
    const shouldOpen = pitchPopover.hidden;
    closeMediaPopovers();
    pitchPopover.hidden = !shouldOpen;
    pitchButton.setAttribute("aria-expanded", String(shouldOpen));
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
  pitchSlider.addEventListener("input", () => {
    applyPitch(Number(pitchSlider.value));
  });
  pitchInput.addEventListener("input", () => {
    if (pitchInput.value !== "") {
      applyPitch(Number(pitchInput.value), false);
    }
  });
  pitchInput.addEventListener("change", () => {
    applyPitch(Number(pitchInput.value) || 0);
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
      void audioGraph.connectMediaElement(element).then(() => {
        audioGraph.setVolume(volumePercent);
        audioGraph.setPlaybackRate(playbackRate);
        audioGraph.setPitchSemitones(pitchSemitones);
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
