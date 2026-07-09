import importlib.util
import os
import shutil
import sys
from pathlib import Path

from google.cloud import storage


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_BUCKET = "benzaiten-outputs"
REQUIRED_MODULES = [
    "firebase_admin",
    "google.cloud.storage",
    "playwright.sync_api",
    "torch",
    "torchaudio",
    "torchvision",
    "transformers",
]


def _check(condition: bool, label: str, detail: str) -> bool:
    if condition:
        print(f"[ok] {label}")
        return True
    print(f"[error] {label}: {detail}", file=sys.stderr)
    return False


def _module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def _check_modules() -> bool:
    ok = True
    for module_name in REQUIRED_MODULES:
        ok = (
            _check(
                _module_available(module_name),
                f"Python module {module_name}",
                "install backend requirements in the environment running FastAPI",
            )
            and ok
        )
    return ok


def _check_gcs() -> bool:
    bucket_name = os.environ.get("GCS_BUCKET", DEFAULT_BUCKET)
    try:
        client = storage.Client()
        next(client.list_blobs(bucket_name, max_results=1), None)
    except Exception as error:
        return _check(
            False,
            f"GCS bucket access for {bucket_name}",
            str(error),
        )
    return _check(True, f"GCS bucket access for {bucket_name}", "")


def _check_firebase_config() -> bool:
    project_id = os.environ.get("FIREBASE_AUTH_PROJECT_ID") or os.environ.get(
        "FIREBASE_PROJECT_ID"
    )
    return _check(
        bool(project_id),
        "Firebase auth project id",
        "set FIREBASE_AUTH_PROJECT_ID to the Firebase project used by the frontend",
    )


def _check_playwright_browser() -> bool:
    try:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            browser.close()
    except Exception as error:
        return _check(
            False,
            "Playwright Chromium",
            f"{error}; run `python -m playwright install chromium`",
        )
    return _check(True, "Playwright Chromium", "")


def main() -> int:
    checks_ok = True
    checks_ok = (
        _check(
            (PROJECT_ROOT / "backend" / "app.py").exists(),
            "Benzaiten project root",
            f"expected backend/app.py under {PROJECT_ROOT}",
        )
        and checks_ok
    )
    checks_ok = (
        _check(
            shutil.which("ffmpeg") is not None,
            "ffmpeg",
            "install ffmpeg and make sure it is on PATH",
        )
        and checks_ok
    )
    checks_ok = _check_modules() and checks_ok
    checks_ok = _check_gcs() and checks_ok
    checks_ok = _check_firebase_config() and checks_ok
    checks_ok = _check_playwright_browser() and checks_ok
    if not checks_ok:
        return 1
    print("Self-hosted backend environment looks ready")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
