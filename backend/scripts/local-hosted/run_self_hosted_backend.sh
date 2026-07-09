#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
HOST="${SELF_HOSTED_HOST:-127.0.0.1}"
PORT="${SELF_HOSTED_PORT:-8000}"
PYTHON_BIN="${PYTHON_BIN:-python}"

cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/venv/bin/activate" && "${BENZAITEN_SKIP_VENV:-false}" != "true" ]]; then
  # shellcheck source=/dev/null
  source "$ROOT_DIR/venv/bin/activate"
  PYTHON_BIN="${PYTHON_BIN:-python}"
fi

export ENABLE_SELF_HOSTED_INFERENCE="${ENABLE_SELF_HOSTED_INFERENCE:-true}"
export GCS_BUCKET="${GCS_BUCKET:-benzaiten-outputs}"
export PROJECT_INDEX_BACKEND="${PROJECT_INDEX_BACKEND:-gcs}"
export ALLOW_PUBLIC_GCS_URL_FALLBACK="${ALLOW_PUBLIC_GCS_URL_FALLBACK:-true}"
export FIREBASE_AUTH_PROJECT_ID="${FIREBASE_AUTH_PROJECT_ID:-benzaiten-fbad8}"
export SELF_HOSTED_ALLOWED_ORIGINS="${SELF_HOSTED_ALLOWED_ORIGINS:-http://localhost:5173,http://127.0.0.1:5173,https://kseto06.github.io}"

if [[ "${SELF_HOSTED_SKIP_ENV_CHECK:-false}" != "true" ]]; then
  "$PYTHON_BIN" backend/scripts/local-hosted/check_self_hosted_env.py
fi

UVICORN_ARGS=(
  -m uvicorn
  backend.app:app
  --host "$HOST"
  --port "$PORT"
)

if [[ "${SELF_HOSTED_RELOAD:-false}" == "true" ]]; then
  UVICORN_ARGS+=(--reload)
fi

echo "Starting Benzaiten self-hosted backend at http://${HOST}:${PORT}"
echo "Set the frontend Self-hosted backend URL to this FastAPI base URL."
exec "$PYTHON_BIN" "${UVICORN_ARGS[@]}"
