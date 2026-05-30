#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

PROJECT_ID="${PROJECT_ID:-$(gcloud config get-value project)}"
REGION="${REGION:-northamerica-northeast2}"
REPO="${REPO:-benzaiten}"
IMAGE="${IMAGE:-benzaiten-inference}"

TAG="${TAG:-latest}"
NO_CACHE="${NO_CACHE:-false}"
PUSH_LATEST="${PUSH_LATEST:-true}"

IMAGE_BASE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}"
IMAGE_URI="${IMAGE_BASE}:${TAG}"
LATEST_URI="${IMAGE_BASE}:latest"

CACHE_FLAG=""

if [ "${NO_CACHE}" = "true" ]; then
  CACHE_FLAG="--no-cache"
fi

echo "Project root: ${PROJECT_ROOT}"
echo "Image URI: ${IMAGE_URI}"

gcloud auth configure-docker "${REGION}-docker.pkg.dev"

if [ "${PUSH_LATEST}" = "true" ] && [ "${TAG}" != "latest" ]; then
  docker buildx build \
    ${CACHE_FLAG} \
    --platform linux/amd64 \
    -f "${PROJECT_ROOT}/Dockerfile" \
    -t "${IMAGE_URI}" \
    -t "${LATEST_URI}" \
    --push \
    "${PROJECT_ROOT}"
else
  docker buildx build \
    ${CACHE_FLAG} \
    --platform linux/amd64 \
    -f "${PROJECT_ROOT}/Dockerfile" \
    -t "${IMAGE_URI}" \
    --push \
    "${PROJECT_ROOT}"
fi

echo "Pushed: ${IMAGE_URI}"

if [ "${PUSH_LATEST}" = "true" ] && [ "${TAG}" != "latest" ]; then
  echo "Also pushed: ${LATEST_URI}"
fi