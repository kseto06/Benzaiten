import { initializeApp } from "firebase/app";
import {
  getAuth,
  onAuthStateChanged,
  type Auth,
  type User,
} from "firebase/auth";

import { FIREBASE_CONFIG, LOG_PREFIX } from "../common/config";
import { getApiError } from "../common/errors";

export let firebaseAuth: Auth | null = null;
export let currentUser: User | null = null;
export let authReady = false;
let authReadyResolve: (() => void) | null = null;

const authReadyPromise = new Promise<void>(resolve => {
  authReadyResolve = resolve;
});

export function hasFirebaseConfig(): boolean {
  return Boolean(
    FIREBASE_CONFIG.apiKey
    && FIREBASE_CONFIG.authDomain
    && FIREBASE_CONFIG.projectId
    && FIREBASE_CONFIG.appId,
  );
}

export function initializeFirebaseAuth(): void {
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

export async function waitForAuthReady(): Promise<void> {
  if (authReady) {
    return;
  }
  await authReadyPromise;
}

export async function getAuthToken(): Promise<string> {
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

export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const token = await getAuthToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}

export async function authJsonFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  return authFetch(input, { ...init, headers });
}
export async function downloadAuthenticatedFile(url: string, filename: string): Promise<void> {
  const response = await authFetch(url);
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
export function getFirebaseAuthErrorMessage(error: unknown): string {
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
