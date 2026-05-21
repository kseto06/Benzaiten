#!/bin/bash
set -e

PROJECT_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"

PROJECT_ID=$(gcloud config get-value project)
REGION=northamerica-northeast2
REPO=benzaiten
IMAGE=benzaiten-inference
TAG=latest

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}"

echo "Project root: ${PROJECT_ROOT}"
echo "Image URI: ${IMAGE_URI}"

gcloud auth configure-docker ${REGION}-docker.pkg.dev

#--no-cache for a clean build
docker buildx build \
  --no-cache \
  --platform linux/amd64 \
  -f "${PROJECT_ROOT}/Dockerfile" \
  -t "${IMAGE_URI}" \
  --push \
  "${PROJECT_ROOT}"