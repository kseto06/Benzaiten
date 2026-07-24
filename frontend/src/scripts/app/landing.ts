import { createUserWithEmailAndPassword, GoogleAuthProvider, sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, signOut } from "firebase/auth";
import landingPageHtml from "../../pages/landing.html?raw";
import { app } from "./appRoot";
import {
  API_BASE_URL,
  BACKEND_READINESS_POLL_INTERVAL_MS,
  BACKEND_READINESS_TIMEOUT_MS,
  BACKEND_UNAVAILABLE_WARNING,
  LANDING_STARTUP_LOADING_TIMEOUT_MS,
  LOG_PREFIX,
} from "../common/config";
import {
  authFetch,
  authJsonFetch,
  currentUser,
  downloadAuthenticatedFile,
  firebaseAuth,
  getFirebaseAuthErrorMessage,
  waitForAuthReady,
} from "./auth";
import { checkBackendReadiness, listJobObjects, listLibraryProjects } from "./api";
import { getApiError } from "../common/errors";
import { escapeHtml, queryElement } from "../common/dom";
import { editorProjectFromLibraryProject } from "../editor/state";
import type {
  DeleteProjectResponse,
  EditorProject,
  GcsObject,
  JobStartResponse,
  JobStatusResponse,
  LibraryProject,
  PipelineStage,
  RenameProjectResponse,
  VolatileProjectReason,
} from "../common/types";
import { clamp, filenameWithoutExtension, formatTime, getFuzzyMatchScore, getGcsObjectName } from "../common/utils";

type LandingCallbacks = {
  openEditor: (project: EditorProject) => void;
  openBlankEditor: (volatileReason?: VolatileProjectReason) => void;
};

let landingDocumentListeners: AbortController | null = null;
let firebaseConfigWarningLogged = false;
let activeLandingCallbacks: LandingCallbacks | null = null;

function setupBackendReadinessWarning(
  warning: HTMLElement,
  landingSignal: AbortSignal,
  onReadinessChange?: (
    isReady: boolean,
    previousReadyState: boolean | null,
  ) => void,
): Promise<void> {
  let lastReadyState: boolean | null = null;
  let requestInFlight = false;
  let initialCheckComplete = false;
  let resolveInitialCheck!: () => void;
  const initialCheck = new Promise<void>(resolve => {
    resolveInitialCheck = resolve;
  });

  const completeInitialCheck = (): void => {
    if (!initialCheckComplete) {
      initialCheckComplete = true;
      resolveInitialCheck();
    }
  };

  const updateWarning = (isReady: boolean): void => {
    const previousReadyState = lastReadyState;
    warning.textContent = isReady ? "" : BACKEND_UNAVAILABLE_WARNING;
    warning.hidden = isReady;
    if (previousReadyState !== isReady) {
      const message = isReady
        ? "GCP backend services are ready."
        : "GCP backend services are unavailable.";
      (isReady ? console.info : console.warn)(`${LOG_PREFIX} ${message}`);
      lastReadyState = isReady;
      onReadinessChange?.(isReady, previousReadyState);
    }
  };

  const checkReadiness = async (): Promise<void> => {
    if (requestInFlight || landingSignal.aborted) {
      return;
    }

    requestInFlight = true;
    const requestController = new AbortController();
    const abortRequest = (): void => requestController.abort();
    landingSignal.addEventListener("abort", abortRequest, { once: true });
    const timeout = window.setTimeout(
      () => requestController.abort(),
      BACKEND_READINESS_TIMEOUT_MS,
    );

    try {
      updateWarning(await checkBackendReadiness(requestController.signal));
    } catch {
      if (!landingSignal.aborted) {
        updateWarning(false);
      }
    } finally {
      window.clearTimeout(timeout);
      landingSignal.removeEventListener("abort", abortRequest);
      requestInFlight = false;
      completeInitialCheck();
    }
  };

  const interval = window.setInterval(
    () => void checkReadiness(),
    BACKEND_READINESS_POLL_INTERVAL_MS,
  );
  landingSignal.addEventListener("abort", () => {
    window.clearInterval(interval);
    completeInitialCheck();
  }, { once: true });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      void checkReadiness();
    }
  }, { signal: landingSignal });
  window.addEventListener("online", () => void checkReadiness(), {
    signal: landingSignal,
  });
  window.addEventListener("offline", () => updateWarning(false), {
    signal: landingSignal,
  });

  void checkReadiness();
  return initialCheck;
}

function getLandingCallbacks(): LandingCallbacks {
  if (!activeLandingCallbacks) {
    throw new Error("Landing callbacks have not been initialized.");
  }
  return activeLandingCallbacks;
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

function setLandingLoading(
  isVisible: boolean,
  copy?: { kicker: string; title: string; detail: string },
): void {
  const loadingPage = queryElement<HTMLDivElement>("#landingLoading");
  if (copy) {
    queryElement<HTMLElement>("#landingLoadingKicker").textContent = copy.kicker;
    queryElement<HTMLElement>("#landingLoadingTitle").textContent = copy.title;
    const detail = document.querySelector<HTMLElement>("#landingLoadingDetail");
    if (detail) {
      detail.textContent = copy.detail;
    }
  }
  loadingPage.hidden = !isVisible;
  loadingPage.setAttribute("aria-hidden", isVisible ? "false" : "true");
  document.body.classList.toggle("is-landing-loading", isVisible);
}

export function renderLanding(callbacks: LandingCallbacks): void {
  activeLandingCallbacks = callbacks;
  document.title = "Benzaiten | AI-Powered Karaoke Orchestration Video Studio";
  app.innerHTML = landingPageHtml;
  setLandingLoading(true, {
    kicker: "Checking cloud services & preparing the workspace...",
    title: "Loading Benzaiten...",
    detail: "",
  });
  setupLandingInteractions(callbacks);
}

function setupLandingInteractions(callbacks: LandingCallbacks): void {
  landingDocumentListeners?.abort();
  landingDocumentListeners = new AbortController();
  const landingSignal = landingDocumentListeners.signal;
  const documentListenerOptions = { signal: landingSignal };
  const backendWarning = queryElement<HTMLDivElement>("#landingBackendWarning");
  const fileInput = queryElement<HTMLInputElement>("#fileInput");
  const uploadZone = queryElement<HTMLDivElement>("#uploadZone");
  const selectedFile = queryElement<HTMLDivElement>("#selectedFile");
  const targetLanguageInput = queryElement<HTMLInputElement>("#targetLanguageInput");
  const shouldTranscribe = queryElement<HTMLInputElement>("#shouldTranscribeInput");
  const shouldRomanize = queryElement<HTMLInputElement>("#shouldRomanizeInput");
  const shouldTranslate = queryElement<HTMLInputElement>("#shouldTranslateInput");
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
  let libraryUnavailableReason: VolatileProjectReason | null = null;
  let refreshBackendDependentState: (() => void) | null = null;
  const initialReadinessCheck = setupBackendReadinessWarning(
    backendWarning,
    landingSignal,
    (isReady, previousReadyState) => {
      if (isReady && previousReadyState === false) {
        refreshBackendDependentState?.();
      }
    },
  );
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
    libraryToggle.disabled = false;
  };

  const setLibraryAuthenticated = (authenticated: boolean, message: string): void => {
    libraryAuthenticatedContent.hidden = false;
    librarySignedOutPrompt.hidden = authenticated;
    if (!authenticated) {
      libraryProjects = null;
      loadedLibraryUid = null;
      libraryStatus.hidden = true;
      libraryStatus.classList.remove("is-error");
      libraryStatus.textContent = "";
      librarySignedOutPrompt.textContent = message;
      renderLibrary([]);
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
      libraryUnavailableReason = "signed_out";
      setProjectControlsEnabled(false);
      setLibraryAuthenticated(
        false,
        "Project accounts are unavailable in this environment. You can still create a temporary project.",
      );
      return;
    }
    if (!currentUser) {
      authStatus.textContent = "Sign in to create and view your projects.";
      authUser.textContent = "";
      accountMenu.hidden = true;
      accountMenuButton.setAttribute("aria-expanded", "false");
      libraryUnavailableReason = "signed_out";
      setProjectControlsEnabled(false);
      setLibraryAuthenticated(
        false,
        "Sign in to search saved projects. You can still create a temporary project.",
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
    libraryUnavailableReason = null;
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
        libraryUnavailableReason = null;
        renderLibrary(libraryProjects);
        libraryStatus.textContent = libraryProjects.length
          ? ""
          : "No completed videos were found for this account.";
      } catch (error) {
        if (requestVersion !== authStateVersion || currentUser?.uid !== uid) {
          return;
        }
        libraryProjects = [];
        loadedLibraryUid = null;
        libraryUnavailableReason = "google_error";
        renderLibrary([]);
        libraryStatus.classList.add("is-error");
        libraryStatus.hidden = false;
        libraryStatus.textContent = (
          "Google error - project library unavailable. You can still create a temporary project."
        );
        console.warn(`${LOG_PREFIX} Project library lookup failed`, error);
      } finally {
        if (libraryLoadPromise === loadPromise) {
          libraryLoadPromise = null;
        }
      }
    })();
    libraryLoadPromise = loadPromise;
    await loadPromise;
  };
  refreshBackendDependentState = () => {
    if (!currentUser || landingSignal.aborted) {
      return;
    }
    const requestVersion = invalidateLibraryRequests();
    void refreshLibrary(requestVersion);
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

  fileInput.addEventListener("change", showSelectedFile);
  for (const eventName of ["dragenter", "dragover"]) {
    uploadZone.addEventListener(eventName, () => uploadZone.classList.add("is-dragging"));
  }
  for (const eventName of ["dragleave", "drop"]) {
    uploadZone.addEventListener(eventName, () => uploadZone.classList.remove("is-dragging"));
  }

  let lastTranslateChoice = shouldTranslate.checked;
  let lastRomanizeChoice = shouldRomanize.checked;
  const syncTranscriptionDependentControls = (): void => {
    if (!shouldTranscribe.checked) {
      lastRomanizeChoice = shouldRomanize.checked;
      lastTranslateChoice = shouldTranslate.checked;
      shouldRomanize.checked = false;
      shouldRomanize.disabled = true;
      shouldTranslate.checked = false;
      shouldTranslate.disabled = true;
      targetLanguageInput.disabled = true;
      return;
    }

    shouldRomanize.disabled = false;
    shouldRomanize.checked = lastRomanizeChoice;
    shouldTranslate.disabled = false;
    shouldTranslate.checked = lastTranslateChoice;
    targetLanguageInput.disabled = !shouldTranslate.checked;
  };

  shouldTranscribe.addEventListener("change", syncTranscriptionDependentControls);
  shouldRomanize.addEventListener("change", () => {
    lastRomanizeChoice = shouldRomanize.checked;
  });
  shouldTranslate.addEventListener("change", () => {
    lastTranslateChoice = shouldTranslate.checked;
    targetLanguageInput.disabled = !shouldTranslate.checked;
  });
  syncTranscriptionDependentControls();

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
    libraryUnavailableReason = "signed_out";
    renderLibrary([]);
    setLandingStatus("Signed out.");
  });
  window.addEventListener("benzaiten-auth-changed", () => {
    const requestVersion = invalidateLibraryRequests();
    renderAuthState();
    void refreshLibrary(requestVersion);
  }, documentListenerOptions);

  const renderLibrary = (projects: LibraryProject[]): void => {
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
          <span>${currentUser && !libraryUnavailableReason
            ? "Start with a blank editor"
            : "Temporary browser project"}</span>
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
    if (!currentUser) {
      renderLibrary([]);
      return;
    }

    await refreshLibrary();
  });

  libraryGrid.addEventListener("click", async event => {
    const target = event.target as HTMLElement;
    const actionElement = target.closest<HTMLElement>("[data-library-action]");
    const action = actionElement?.dataset.libraryAction;
    if (action === "create") {
      const volatileReason = !firebaseAuth || !currentUser
        ? "signed_out"
        : libraryUnavailableReason === "google_error"
          ? "google_error"
          : undefined;
      callbacks.openBlankEditor(volatileReason);
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
      callbacks.openEditor(editorProjectFromLibraryProject(project));
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

  const initialAuthAndLibraryLoad = (async () => {
    await waitForAuthReady();
    renderAuthState();
    await refreshLibrary();
  })();
  const startupLoadingTimeout = window.setTimeout(() => {
    if (!landingSignal.aborted) {
      setLandingLoading(false);
    }
  }, LANDING_STARTUP_LOADING_TIMEOUT_MS);
  landingSignal.addEventListener("abort", () => {
    window.clearTimeout(startupLoadingTimeout);
    document.body.classList.remove("is-landing-loading");
  }, { once: true });
  void Promise.allSettled([initialReadinessCheck, initialAuthAndLibraryLoad]).then(() => {
    window.clearTimeout(startupLoadingTimeout);
    if (!landingSignal.aborted) {
      setLandingLoading(false);
    }
  });
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

function createProgressController(shouldDecrowd: boolean, shouldTranscribe: boolean): {
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
    {
      id: "transcribe",
      label: shouldTranscribe ? "Transcribe lyrics" : "Transcription skipped",
      complete: !shouldTranscribe,
      skipped: !shouldTranscribe,
    },
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
    const transcriptionComplete = !shouldTranscribe || names.some(name => (
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
      if (!shouldTranscribe) {
        detail.textContent = "Crowd reduction is running.";
      }
    } else {
      title.textContent = "Composing the final media";
      detail.textContent = shouldTranscribe
        ? "Combining the processed audio, video, and subtitles."
        : "Combining the processed audio and video.";
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
  const targetLanguageInput = queryElement<HTMLInputElement>("#targetLanguageInput");
  const projectNameInput = queryElement<HTMLInputElement>("#projectNameInput");
  const shouldTranscribeInput = queryElement<HTMLInputElement>("#shouldTranscribeInput");
  const shouldRomanizeInput = queryElement<HTMLInputElement>("#shouldRomanizeInput");
  const shouldTranslateInput = queryElement<HTMLInputElement>("#shouldTranslateInput");
  const shouldDecrowdInput = queryElement<HTMLInputElement>("#shouldDecrowdInput");
  const fastDecrowdInput = queryElement<HTMLInputElement>("#fastDecrowdInput");
  const runButton = queryElement<HTMLButtonElement>("#runInferenceButton");
  const file = fileInput.files?.[0];
  const language = languageInput.value.trim();
  const targetLanguage = targetLanguageInput.value.trim() || "en";
  const shouldRomanize = shouldTranscribeInput.checked && shouldRomanizeInput.checked;
  const shouldTranslate = shouldTranscribeInput.checked && shouldTranslateInput.checked;

  if (!file) {
    setLandingStatus("Choose a video or audio file first.", true);
    return;
  }
  if (!file.type.startsWith("video/") && !file.type.startsWith("audio/")) {
    setLandingStatus("The selected file must be video or audio.", true);
    return;
  }
  if (shouldTranscribeInput.checked && !language) {
    setLandingStatus("Enter an audio language code.", true);
    return;
  }

  runButton.disabled = true;
  const progressPanel = queryElement<HTMLDivElement>("#progressPanel");
  progressPanel.classList.remove("is-visible");
  let progress: ReturnType<typeof createProgressController> | null = null;

  try {
    setLandingLoading(true, {
      kicker: "Uploading your media and preparing the orchestration pipeline.",
      title: "Starting karaoke inference...",
      detail: "",
    });
    setLandingStatus("Uploading media and starting orchestration...");
    const formData = new FormData();
    formData.append("file", file);
    formData.append("language", language);
    formData.append("target_language", targetLanguage);
    formData.append("should_transcribe", shouldTranscribeInput.checked ? "true" : "false");
    formData.append("should_romanize", shouldRomanize ? "true" : "false");
    formData.append("should_translate", shouldTranslate ? "true" : "false");
    formData.append("should_decrowd", shouldDecrowdInput.checked ? "true" : "false");
    formData.append(
      "fast_decrowd",
      shouldDecrowdInput.checked && fastDecrowdInput.checked ? "true" : "false",
    );
    const projectTitle = projectNameInput.value.trim();
    if (projectTitle) {
      formData.append("project_title", projectTitle);
    }

    const response = await authFetch(`${API_BASE_URL}/jobs`, {
      method: "POST",
      body: formData,
    });
    if (!response.ok) {
      throw new Error(await getApiError(response));
    }

    const startData = await response.json() as JobStartResponse;
    localStorage.setItem("job_id", startData.job_id);
    setLandingLoading(false);
    progress = createProgressController(
      shouldDecrowdInput.checked,
      shouldTranscribeInput.checked,
    );
    window.requestAnimationFrame(() => {
      progressPanel.scrollIntoView({ behavior: "smooth", block: "center" });
    });
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
    getLandingCallbacks().openEditor({
      title: projectTitle || filenameWithoutExtension(file.name),
      originalTitle: projectTitle || filenameWithoutExtension(file.name),
      jobId: startData.job_id,
      mediaUrl,
      mediaObjectName: getGcsObjectName(mediaUrl),
      subtitleUrl: completed.subtitle_url || undefined,
      subtitleObjectName: getGcsObjectName(completed.subtitle_url),
      mediaType: completed.video_url ? "video" : "audio",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLandingStatus(`Inference failed: ${message}`, true);
    console.error(`${LOG_PREFIX} Inference failed`, error);
  } finally {
    setLandingLoading(false);
    progress?.stop();
    runButton.disabled = false;
  }
}

async function pollInferenceJob(
  jobId: string,
  progress: ReturnType<typeof createProgressController>,
): Promise<JobStatusResponse> {
  while (true) {
    const [statusResponse, jobObjects] = await Promise.all([
      authFetch(`${API_BASE_URL}/jobs/${encodeURIComponent(jobId)}`),
      listJobObjects(jobId).catch(() => []),
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
    getLandingCallbacks().openEditor(editorProjectFromLibraryProject(match.project));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLandingStatus(message, true);
    console.error(`${LOG_PREFIX} Library search failed`, error);
  } finally {
    button.disabled = false;
  }
}
