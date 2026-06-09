#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOOTSTRAP_DIR="${SCRIPT_DIR}/bootstrap"

ZONE="${ZONE:-northamerica-northeast2-b}"
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}"
CPU_POOL="${CPU_POOL:-cpu-inference-pool}"
GPU_POOL="${GPU_POOL:-gpu-pool}"
DEFAULT_POOL_MIN_NODES="${DEFAULT_POOL_MIN_NODES:-1}"
DEFAULT_POOL_MAX_NODES="${DEFAULT_POOL_MAX_NODES:-3}"

# Main inference pool selector
# Valid values:
#   cpu-inference-pool
#   gpu-pool
INFERENCE_POOL="${INFERENCE_POOL:-${CPU_POOL}}"

case "${INFERENCE_POOL}" in
  "${CPU_POOL}")
    echo "Selected main inference pool: CPU (${CPU_POOL})"
    ;;
  "${GPU_POOL}")
    echo "Selected main inference pool: GPU (${GPU_POOL})"
    ;;
  *)
    echo "Exception: INFERENCE_POOL must be either '${CPU_POOL}' or '${GPU_POOL}'." >&2
    echo "Got: '${INFERENCE_POOL}'" >&2
    exit 1
    ;;
esac

echo "Bootstrapping Benzaiten GKE infrastructure..."
echo "Cluster: ${CLUSTER}"
echo "Zone: ${ZONE}"
echo "Inference pool: ${INFERENCE_POOL}"

echo "Checking GKE cluster..."
if gcloud container clusters describe "${CLUSTER}" --zone "${ZONE}" >/dev/null 2>&1; then
  echo "Cluster already exists, skipping create."
  gcloud container clusters get-credentials "${CLUSTER}" --zone "${ZONE}"

  DEFAULT_POOL_SCOPES="$(gcloud container node-pools describe default-pool \
    --cluster "${CLUSTER}" \
    --zone "${ZONE}" \
    --format='value(config.oauthScopes)')"

  if [[ "${DEFAULT_POOL_SCOPES}" != *"https://www.googleapis.com/auth/cloud-platform"* ]]; then
    echo "Existing default-pool is missing the cloud-platform OAuth scope." >&2
    echo "The backend cannot upload inputs or job status files to GCS." >&2
    echo "Recreate the cluster so create-gke-cluster.sh can apply the required scope." >&2
    exit 1
  fi
else
  echo "Creating GKE cluster..."
  bash "${BOOTSTRAP_DIR}/create-gke-cluster.sh"
fi

echo "Configuring default node pool autoscaling..."
gcloud container clusters update "${CLUSTER}" \
  --zone "${ZONE}" \
  --enable-autoscaling \
  --node-pool default-pool \
  --min-nodes "${DEFAULT_POOL_MIN_NODES}" \
  --max-nodes "${DEFAULT_POOL_MAX_NODES}"

echo "Configuring IAM..."
bash "${BOOTSTRAP_DIR}/iam.sh"

if [ "${INFERENCE_POOL}" = "${CPU_POOL}" ]; then
  echo "Checking CPU inference node pool..."
  if gcloud container node-pools describe "${CPU_POOL}" \
    --cluster "${CLUSTER}" \
    --zone "${ZONE}" >/dev/null 2>&1; then
    echo "CPU inference node pool already exists, skipping create."
  else
    echo "Creating CPU inference node pool..."
    NODE_POOL="${CPU_POOL}" bash "${BOOTSTRAP_DIR}/create-gke-cpu-inference-node-pool.sh"
  fi

  echo "Configuring CPU inference node pool autoscaling..."
  NODE_POOL="${CPU_POOL}" bash "${BOOTSTRAP_DIR}/autoscale_cpu_inference_cluster.sh"
else
  echo "Skipping CPU inference node pool setup because INFERENCE_POOL=${INFERENCE_POOL}."
fi

if [ "${INFERENCE_POOL}" = "${GPU_POOL}" ]; then
  echo "Checking GPU inference node pool..."
  if gcloud container node-pools describe "${GPU_POOL}" \
    --cluster "${CLUSTER}" \
    --zone "${ZONE}" >/dev/null 2>&1; then
    echo "GPU inference node pool already exists, skipping create."
  else
    echo "Creating GPU inference node pool..."
    NODE_POOL="${GPU_POOL}" bash "${BOOTSTRAP_DIR}/create-gke-node-pool.sh"
  fi

  echo "Configuring GPU inference node pool autoscaling..."
  NODE_POOL="${GPU_POOL}" bash "${BOOTSTRAP_DIR}/autoscale_gpu_pool.sh"
else
  echo "Skipping GPU node pool setup because INFERENCE_POOL=${INFERENCE_POOL}"
fi

echo "Bootstrap finished"

kubectl get nodes -L cloud.google.com/gke-nodepool
kubectl get pods -A -o wide
