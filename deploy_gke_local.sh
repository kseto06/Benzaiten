#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-project-0c6e9a84-c914-4d2f-ace}"
REGION="${REGION:-northamerica-northeast2}"
ZONE="${ZONE:-northamerica-northeast2-b}"
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}"

REPOSITORY="${REPOSITORY:-benzaiten}"
IMAGE_NAME="${IMAGE_NAME:-benzaiten-inference}"
TAG="${TAG:-latest}"

DEPLOYMENT_NAME="${DEPLOYMENT_NAME:-benzaiten-inference-deployment}"
CONTAINER_NAME="${CONTAINER_NAME:-benzaiten-inference-container}"
NAMESPACE="${NAMESPACE:-default}"

PUSH_LATEST="${PUSH_LATEST:-true}"
NO_CACHE="${NO_CACHE:-false}"

SCRIPT_ROOT="backend/scripts/benzaiten_inference"
PUSH_IMAGE_SCRIPT="${SCRIPT_ROOT}/push-image.sh"
DEPLOY_SCRIPT="${SCRIPT_ROOT}/deploy/deploy-inference-job.sh"
RESTART_SCRIPT="${SCRIPT_ROOT}/deploy/restart_deployment.sh"

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"

log() {
    printf '\n\033[1;34m==> %s\033[0m\n' "$1"
}

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Required command not found: $1" >&2
        exit 1
    fi
}

require_file() {
    if [[ ! -f "$1" ]]; then
        echo "Required file not found: $1" >&2
        exit 1
    fi
}

# Ensure the script is being run from the repository root.
if [[ ! -f "Dockerfile" ]] || [[ ! -d "backend" ]]; then
    echo "Run this script from the Benzaiten repository root." >&2
    exit 1
fi

require_command gcloud
require_command kubectl
require_command docker

require_file "$PUSH_IMAGE_SCRIPT"
require_file "$DEPLOY_SCRIPT"
require_file "$RESTART_SCRIPT"

log "Deployment configuration"
cat <<EOF
Project: ${PROJECT_ID}
Region: ${REGION}
Zone: ${ZONE}
Cluster: ${CLUSTER}
Repository: ${REPOSITORY}
Image: ${IMAGE_NAME}
Tag: ${TAG}
Image URI: ${IMAGE_URI}
Deployment: ${DEPLOYMENT_NAME}
Container: ${CONTAINER_NAME}
Namespace: ${NAMESPACE}
Push latest: ${PUSH_LATEST}
No cache: ${NO_CACHE}
EOF

log "Checking Docker Desktop"
if ! docker info >/dev/null 2>&1; then
    echo "Docker is installed, but the Docker daemon is unavailable." >&2
    echo "Start Docker Desktop and rerun this script." >&2
    exit 1
fi

log "Checking active Google Cloud account"
ACTIVE_ACCOUNT="$(gcloud auth list \
    --filter=status:ACTIVE \
    --format='value(account)' \
    | head -n 1)"

if [[ -z "$ACTIVE_ACCOUNT" ]]; then
    echo "No active gcloud account was found." >&2
    echo "Run: gcloud auth login" >&2
    exit 1
fi

echo "Active account: ${ACTIVE_ACCOUNT}"

log "Setting the active Google Cloud project"
gcloud config set project "$PROJECT_ID"

log "Verifying Artifact Registry repository"
gcloud artifacts repositories describe "$REPOSITORY" \
    --project "$PROJECT_ID" \
    --location "$REGION" \
    --format="yaml(name,format,location)"

log "Configuring Docker authentication for Artifact Registry"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

log "Building and pushing Docker image"
PROJECT_ID="$PROJECT_ID" \
REGION="$REGION" \
REPO="$REPOSITORY" \
IMAGE="$IMAGE_NAME" \
TAG="$TAG" \
PUSH_LATEST="$PUSH_LATEST" \
NO_CACHE="$NO_CACHE" \
bash "$PUSH_IMAGE_SCRIPT"

log "Fetching GKE credentials"
gcloud container clusters get-credentials "$CLUSTER" \
    --zone "$ZONE" \
    --project "$PROJECT_ID"

log "Verifying Kubernetes cluster access"
kubectl config current-context
kubectl cluster-info
kubectl get nodes -L cloud.google.com/gke-nodepool

log "Applying persistent Kubernetes resources"
NAMESPACE="$NAMESPACE" \
bash "$DEPLOY_SCRIPT"

log "Updating backend Deployment image"
kubectl set image \
    "deployment/${DEPLOYMENT_NAME}" \
    "${CONTAINER_NAME}=${IMAGE_URI}" \
    --namespace "$NAMESPACE"

log "Updating image used by dynamically created Kubernetes Jobs"
kubectl set env \
    "deployment/${DEPLOYMENT_NAME}" \
    "IMAGE=${IMAGE_URI}" \
    --namespace "$NAMESPACE"

log "Restarting backend Deployment and waiting for rollout"
DEPLOYMENT="$DEPLOYMENT_NAME" \
NAMESPACE="$NAMESPACE" \
bash "$RESTART_SCRIPT"

log "Showing deployed resources"
kubectl get deployment,pods,svc \
    --namespace "$NAMESPACE" \
    -o wide

log "Deployment completed successfully"
echo "Deployed image: ${IMAGE_URI}"