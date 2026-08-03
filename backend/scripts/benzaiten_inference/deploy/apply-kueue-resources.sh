#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
KUEUE_DIR="${KUEUE_DIR:-${SCRIPT_DIR}/../k8s/kueue}"
NAMESPACE="${NAMESPACE:-default}"
KUEUE_CONTROLLER_TIMEOUT="${KUEUE_CONTROLLER_TIMEOUT:-300s}"

KUEUE_MANIFESTS=(resource-flavors.yaml cluster-queues.yaml local-queues.yaml)

if ! kubectl get customresourcedefinition/clusterqueues.kueue.x-k8s.io \
  >/dev/null 2>&1; then
  echo "Kueue is not installed in this cluster." >&2
  echo "Run the updated GKE bootstrap before deploying the Benzaiten backend." >&2
  exit 1
fi

kubectl rollout status deployment/kueue-controller-manager \
  --namespace kueue-system \
  --timeout="${KUEUE_CONTROLLER_TIMEOUT}"

for manifest in "${KUEUE_MANIFESTS[@]}"; do
  if [ ! -f "${KUEUE_DIR}/${manifest}" ]; then
    echo "Missing Kueue manifest: ${KUEUE_DIR}/${manifest}" >&2
    exit 1
  fi
done

for manifest in "${KUEUE_MANIFESTS[@]}"; do
  if [[ "${manifest}" == "local-queues.yaml" ]]; then
    kubectl apply -f "${KUEUE_DIR}/${manifest}" --namespace "${NAMESPACE}"
  else
    kubectl apply -f "${KUEUE_DIR}/${manifest}"
   fi
done

kubectl wait clusterqueue/benzaiten-cluster-queue \
  --for=condition=Active \
  --timeout=120s
kubectl wait localqueue/benzaiten-local-queue \
  --namespace "${NAMESPACE}" \
  --for=condition=Active \
  --timeout=120s
