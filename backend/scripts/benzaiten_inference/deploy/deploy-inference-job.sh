#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
K8S_DIR="${K8S_DIR:-${SCRIPT_DIR}/../k8s}"
NAMESPACE="${NAMESPACE:-default}"
INFERENCE_CONFIG_MAP="${INFERENCE_CONFIG_MAP:-benzaiten-inference-config}"
BACKEND_K8S_SERVICE_ACCOUNT="${BACKEND_K8S_SERVICE_ACCOUNT:-benzaiten-backend-sa}"
BACKEND_GCP_SERVICE_ACCOUNT_EMAIL="${BACKEND_GCP_SERVICE_ACCOUNT_EMAIL:-github-actions-sa@project-0c6e9a84-c914-4d2f-ace.iam.gserviceaccount.com}"

if [ ! -d "${K8S_DIR}" ]; then
  echo "K8S_DIR does not exist: ${K8S_DIR}" >&2
  exit 1
fi

MANIFESTS=(backend-rbac.yaml backend-deployment.yaml service.yaml)

for manifest in "${MANIFESTS[@]}"; do
  if [ ! -f "${K8S_DIR}/${manifest}" ]; then
    echo "Missing manifest: ${K8S_DIR}/${manifest}" >&2
    exit 1
  fi
done

CONFIGURED_KUEUE_ENABLED="$(
  kubectl get configmap "${INFERENCE_CONFIG_MAP}" \
    --namespace "${NAMESPACE}" \
    -o jsonpath='{.data.KUEUE_ENABLED}' \
    2>/dev/null || true
)"
CONFIGURED_KUEUE_NAME="$(
  kubectl get configmap "${INFERENCE_CONFIG_MAP}" \
    --namespace "${NAMESPACE}" \
    -o jsonpath='{.data.KUEUE_NAME}' \
    2>/dev/null || true
)"

if [[ "${CONFIGURED_KUEUE_ENABLED}" != "true" ]]; then
  echo "ConfigMap ${INFERENCE_CONFIG_MAP} must set KUEUE_ENABLED=true." >&2
  echo "Run the updated GKE bootstrap before deploying the Benzaiten backend." >&2
  exit 1
fi

if [[ -z "${CONFIGURED_KUEUE_NAME}" ]]; then
  echo "ConfigMap ${INFERENCE_CONFIG_MAP} must set KUEUE_NAME to a LocalQueue name." >&2
  echo "Run the updated GKE bootstrap before deploying the Benzaiten backend." >&2
  exit 1
fi

KUEUE_DIR="${K8S_DIR}/kueue" \
  NAMESPACE="${NAMESPACE}" \
  bash "${SCRIPT_DIR}/apply-kueue-resources.sh"

for manifest in "${MANIFESTS[@]}"; do
  kubectl apply -f "${K8S_DIR}/${manifest}" --namespace "${NAMESPACE}"
done

if [[ -n "${BACKEND_GCP_SERVICE_ACCOUNT_EMAIL}" ]]; then
  kubectl annotate serviceaccount "${BACKEND_K8S_SERVICE_ACCOUNT}" \
    --namespace "${NAMESPACE}" \
    "iam.gke.io/gcp-service-account=${BACKEND_GCP_SERVICE_ACCOUNT_EMAIL}" \
    --overwrite
fi
