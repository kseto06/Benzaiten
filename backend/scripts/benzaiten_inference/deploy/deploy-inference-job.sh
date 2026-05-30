#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
K8S_DIR="${K8S_DIR:-${SCRIPT_DIR}/../k8s}"
NAMESPACE="${NAMESPACE:-default}"

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

for manifest in "${MANIFESTS[@]}"; do
  kubectl apply -f "${K8S_DIR}/${manifest}" --namespace "${NAMESPACE}"
done