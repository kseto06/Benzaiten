#!/bin/bash

PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
FRONTEND_DIR="$PROJECT_ROOT/frontend"

cd "$PROJECT_ROOT" || exit 1

source "$PROJECT_ROOT/venv/bin/activate"

# check if port 8080 already in use
if lsof -i :8000 >/dev/null 2>&1; then
    lsof -ti :8000 | xargs kill -9
fi

# docker run backend init
docker run --platform linux/amd64 \
    --name benzaiten-backend-dev \
    -p 8080:8080 \
    -e GCS_BUCKET=benzaiten-outputs \
    benzaiten-inference:local &

BACKEND_PID=$!

# vite frontend init
cd "$FRONTEND_DIR" || exit 1
npm run dev &

FRONTEND_PID=$!

cleanup() {
    #kill "$BACKEND_PID" 2>/dev/null || true
    docker rm -f benzaiten-backend-dev 2>/dev/null || true
    kill "$FRONTEND_PID" 2>/dev/null || true
}

trap cleanup EXIT

wait