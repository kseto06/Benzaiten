#!/usr/bin/env bash
set -euo pipefail

# Cleans up resources deployed by the Benzaiten deployment script.
#
# This script intentionally DOES NOT delete:
#   - the GCP project
#   - the Artifact Registry repository
#   - the GKE cluster or node pools
#   - the GCS bucket
#   - IAM project-level role bindings

PROJECT_ID="${PROJECT_ID:-project-0c6e9a84-c914-4d2f-ace}"
REGION="${REGION:-northamerica-northeast2}"
ZONE="${ZONE:-northamerica-northeast2-b}"
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}"

REPOSITORY="${REPOSITORY:-benzaiten}"
IMAGE_NAME="${IMAGE_NAME:-benzaiten-inference}"
TAG="${TAG:-latest}"

DEPLOYMENT_NAME="${DEPLOYMENT_NAME:-benzaiten-inference-deployment}"
SERVICE_NAME="${SERVICE_NAME:-benzaiten-inference-service}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-benzaiten-backend-sa}"
ROLE_NAME="${ROLE_NAME:-benzaiten-job-manager-role}"
ROLE_BINDING_NAME="${ROLE_BINDING_NAME:-benzaiten-job-manager-rolebinding}"
NAMESPACE="${NAMESPACE:-default}"

DELETE_IMAGE="${DELETE_IMAGE:-true}"
DELETE_DYNAMIC_JOBS="${DELETE_DYNAMIC_JOBS:-true}"
DRY_RUN="${DRY_RUN:-false}"
AUTO_CONFIRM="${AUTO_CONFIRM:-false}"

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}:${TAG}"
IMAGE_PATH="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${IMAGE_NAME}"

log() {
    printf '\n\033[1;34m==> %s\033[0m\n' "$1"
}

warn() {
    printf '\033[1;33mWARNING: %s\033[0m\n' "$1" >&2
}

require_command() {
    if ! command -v "$1" >/dev/null 2>&1; then
        echo "Required command not found: $1" >&2
        exit 1
    fi
}

run() {
    if [[ "$DRY_RUN" == "true" ]]; then
        printf '[dry-run]'
        printf ' %q' "$@"
        printf '\n'
    else
        "$@"
    fi
}

resource_exists() {
    local kind="$1"
    local name="$2"

    kubectl get "$kind" "$name" \
        --namespace "$NAMESPACE" \
        --request-timeout=15s \
        >/dev/null 2>&1
}

delete_namespaced_resource() {
    local kind="$1"
    local name="$2"

    if resource_exists "$kind" "$name"; then
        log "Deleting ${kind}/${name}"
        run kubectl delete "$kind" "$name" \
            --namespace "$NAMESPACE" \
            --ignore-not-found=true \
            --wait=true \
            --request-timeout=30s
    else
        echo "${kind}/${name} does not exist; skipping."
    fi
}

require_command gcloud
require_command kubectl

if [[ "$DELETE_IMAGE" != "true" && "$DELETE_IMAGE" != "false" ]]; then
    echo "DELETE_IMAGE must be true or false." >&2
    exit 1
fi

if [[ "$DELETE_DYNAMIC_JOBS" != "true" && "$DELETE_DYNAMIC_JOBS" != "false" ]]; then
    echo "DELETE_DYNAMIC_JOBS must be true or false." >&2
    exit 1
fi

if [[ "$DRY_RUN" != "true" && "$DRY_RUN" != "false" ]]; then
    echo "DRY_RUN must be true or false." >&2
    exit 1
fi

if [[ "$AUTO_CONFIRM" != "true" && "$AUTO_CONFIRM" != "false" ]]; then
    echo "AUTO_CONFIRM must be true or false." >&2
    exit 1
fi

log "Cleanup configuration"
cat <<EOF
Project:                 ${PROJECT_ID}
Region:                  ${REGION}
Zone:                    ${ZONE}
Cluster:                 ${CLUSTER}
Namespace:               ${NAMESPACE}
Deployment:              ${DEPLOYMENT_NAME}
Service:                 ${SERVICE_NAME}
Service account:         ${SERVICE_ACCOUNT_NAME}
Role:                    ${ROLE_NAME}
Role binding:            ${ROLE_BINDING_NAME}
Image:                   ${IMAGE_URI}
Delete image:            ${DELETE_IMAGE}
Delete dynamic jobs:     ${DELETE_DYNAMIC_JOBS}
Dry run:                 ${DRY_RUN}
EOF

if [[ "$AUTO_CONFIRM" != "true" ]]; then
    echo
    read -r -p "Continue with cleanup? [y/N] " reply

    case "$reply" in
        y|Y|yes|YES)
            ;;
        *)
            echo "Cleanup cancelled."
            exit 0
            ;;
    esac
fi

log "Checking active Google Cloud account"
ACTIVE_ACCOUNT="$(
    gcloud auth list \
        --filter=status:ACTIVE \
        --format='value(account)' \
    | head -n 1
)"

if [[ -z "$ACTIVE_ACCOUNT" ]]; then
    echo "No active gcloud account was found." >&2
    echo "Run: gcloud auth login" >&2
    exit 1
fi

echo "Active account: ${ACTIVE_ACCOUNT}"

log "Setting active Google Cloud project"
run gcloud config set project "$PROJECT_ID"

CLUSTER_EXISTS="$(
    gcloud container clusters list \
        --project "$PROJECT_ID" \
        --zone "$ZONE" \
        --filter="name=${CLUSTER}" \
        --format='value(name)' \
    | head -n 1
)"

if [[ -n "$CLUSTER_EXISTS" ]]; then
    log "Fetching GKE credentials"
    run gcloud container clusters get-credentials "$CLUSTER" \
        --zone "$ZONE" \
        --project "$PROJECT_ID"

    if [[ "$DRY_RUN" != "true" ]]; then
        log "Verifying Kubernetes cluster access"

        if ! kubectl cluster-info \
            --request-timeout=15s \
            >/dev/null 2>&1; then
            echo "Unable to connect to the Kubernetes cluster." >&2
            echo "Kubernetes cleanup was not performed." >&2
            exit 1
        fi
    fi

    if [[ "$DELETE_DYNAMIC_JOBS" == "true" ]]; then
        log "Deleting Kubernetes Jobs that use ${IMAGE_PATH}"

        if [[ "$DRY_RUN" == "true" ]]; then
            echo "[dry-run] Find all jobs in namespace ${NAMESPACE} whose container image begins with ${IMAGE_PATH}, then delete them."
        else
            # macOS ships with Bash 3.2, which does not support mapfile.
            # Use a while-read loop to construct the array instead.
            MATCHING_JOBS=()

            while IFS= read -r job_name; do
                if [[ -n "$job_name" ]]; then
                    MATCHING_JOBS+=("$job_name")
                fi
            done < <(
                kubectl get jobs \
                    --namespace "$NAMESPACE" \
                    --request-timeout=15s \
                    -o jsonpath='{range .items[*]}{.metadata.name}{"|"}{range .spec.template.spec.containers[*]}{.image}{" "}{end}{"\n"}{end}' \
                | awk -F'|' -v image_path="$IMAGE_PATH" \
                    'index($2, image_path) > 0 {print $1}'
            )

            if (( ${#MATCHING_JOBS[@]} > 0 )); then
                echo "Matching jobs:"
                printf '  - %s\n' "${MATCHING_JOBS[@]}"

                kubectl delete jobs \
                    --namespace "$NAMESPACE" \
                    --ignore-not-found=true \
                    --wait=true \
                    --request-timeout=30s \
                    "${MATCHING_JOBS[@]}"
            else
                echo "No matching Kubernetes Jobs found."
            fi
        fi
    fi

    # Delete workload-facing resources before RBAC and service-account resources.
    delete_namespaced_resource deployment "$DEPLOYMENT_NAME"
    delete_namespaced_resource service "$SERVICE_NAME"
    delete_namespaced_resource rolebinding "$ROLE_BINDING_NAME"
    delete_namespaced_resource role "$ROLE_NAME"
    delete_namespaced_resource serviceaccount "$SERVICE_ACCOUNT_NAME"

    log "Remaining Kubernetes resources in namespace ${NAMESPACE}"

    if [[ "$DRY_RUN" == "true" ]]; then
        echo "[dry-run] kubectl get deployment,job,pod,service,serviceaccount,role,rolebinding --namespace ${NAMESPACE}"
    else
        kubectl get \
            deployment,job,pod,service,serviceaccount,role,rolebinding \
            --namespace "$NAMESPACE" \
            --request-timeout=15s \
            2>/dev/null || true
    fi
else
    warn "Cluster ${CLUSTER} was not found in ${ZONE}; skipping Kubernetes cleanup."
fi

if [[ "$DELETE_IMAGE" == "true" ]]; then
    log "Resolving Artifact Registry image digest for ${IMAGE_URI}"

    if ! gcloud artifacts repositories describe "$REPOSITORY" \
        --project "$PROJECT_ID" \
        --location "$REGION" \
        >/dev/null 2>&1; then
        warn "Artifact Registry repository ${REPOSITORY} was not found; skipping image deletion."
    else
        DIGEST=""
        if ! DIGEST="$(
            gcloud artifacts docker images list "$IMAGE_PATH" \
                --project "$PROJECT_ID" \
                --include-tags \
                --format='csv[no-heading](version,tags)' \
            | awk -F',' -v wanted_tag="$TAG" '
                {
                    tags = $2
                    gsub(/^[[:space:]]+|[[:space:]]+$/, "", tags)

                    n = split(tags, tag_list, /[; ]+/)

                    for (i = 1; i <= n; i++) {
                        if (tag_list[i] == wanted_tag) {
                            print $1
                            exit
                        }
                    }
                }
            '
        )"; then
            warn "Unable to list Artifact Registry images; skipping image deletion."
            warn "Grant roles/artifactregistry.repoAdmin to the cleanup service account if image deletion is required."
            DIGEST=""
        fi

        if [[ -z "$DIGEST" ]]; then
            warn "No Artifact Registry image with tag ${TAG} was found; skipping image deletion."
        else
            echo "Resolved ${IMAGE_URI} to ${DIGEST}"
            warn "Deleting the parent digest also deletes all tags attached to that digest."

            if [[ "$AUTO_CONFIRM" != "true" ]]; then
                read -r -p "Delete ${IMAGE_PATH}@${DIGEST}? [y/N] " image_reply

                case "$image_reply" in
                    y|Y|yes|YES)
                        ;;
                    *)
                        echo "Image deletion skipped."
                        DIGEST=""
                        ;;
                esac
            fi

            if [[ -n "$DIGEST" ]]; then
                if ! run gcloud artifacts docker images delete \
                    "${IMAGE_PATH}@${DIGEST}" \
                    --project "$PROJECT_ID" \
                    --delete-tags \
                    --quiet; then
                    warn "Artifact Registry image deletion failed; continuing cleanup."
                    warn "Grant roles/artifactregistry.repoAdmin to the cleanup service account if image deletion is required."
                fi
            fi
        fi
    fi
fi

log "Cleanup completed"
echo "The GKE cluster, Artifact Registry repository, GCP project, and GCS data were left intact."
