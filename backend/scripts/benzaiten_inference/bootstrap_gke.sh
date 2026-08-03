#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOOTSTRAP_DIR="${SCRIPT_DIR}/bootstrap"

ZONE="${ZONE:-northamerica-northeast2-b}"
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}"
CPU_POOL="${CPU_POOL:-cpu-inference-pool}"
GPU_POOL="${GPU_POOL:-gpu-pool}"
VIDEO_POOL="${VIDEO_POOL:-video-pool}"
GPU_POOL_MAX_NODES="${GPU_POOL_MAX_NODES:-1}"
VIDEO_POOL_MAX_NODES="${VIDEO_POOL_MAX_NODES:-2}"
DEFAULT_POOL_MIN_NODES="${DEFAULT_POOL_MIN_NODES:-1}"
DEFAULT_POOL_MAX_NODES="${DEFAULT_POOL_MAX_NODES:-3}"
INFERENCE_CONFIG_MAP="${INFERENCE_CONFIG_MAP:-benzaiten-inference-config}"

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
echo "Video pool: ${VIDEO_POOL}"

if [ "${INFERENCE_POOL}" = "${GPU_POOL}" ]; then
  INFERENCE_GPU_COUNT=1
else
  INFERENCE_GPU_COUNT=0
fi

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

PROJECT_ID="$(gcloud config get-value project)"
echo "Ensuring Workload Identity is enabled..."
gcloud container clusters update "${CLUSTER}" \
  --zone "${ZONE}" \
  --workload-pool="${PROJECT_ID}.svc.id.goog"

echo "Ensuring default node pool uses the GKE metadata server..."
gcloud container node-pools update default-pool \
  --cluster "${CLUSTER}" \
  --zone "${ZONE}" \
  --workload-metadata=GKE_METADATA

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
  NODE_POOL="${CPU_POOL}" bash "${BOOTSTRAP_DIR}/enable_workload_identity_node_pool.sh"
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
    NODE_POOL="${GPU_POOL}" \
      MAX_NODES="${GPU_POOL_MAX_NODES}" \
      bash "${BOOTSTRAP_DIR}/create-gke-node-pool.sh"
  fi

  echo "Configuring GPU inference node pool autoscaling..."
  NODE_POOL="${GPU_POOL}" bash "${BOOTSTRAP_DIR}/enable_workload_identity_node_pool.sh"
  NODE_POOL="${GPU_POOL}" \
    MAX_NODES="${GPU_POOL_MAX_NODES}" \
    bash "${BOOTSTRAP_DIR}/autoscale_gpu_pool.sh"
else
  echo "Skipping GPU node pool setup because INFERENCE_POOL=${INFERENCE_POOL}"
fi

echo "Checking video node pool..."
if gcloud container node-pools describe "${VIDEO_POOL}" \
  --cluster "${CLUSTER}" \
  --zone "${ZONE}" >/dev/null 2>&1; then
  echo "Video node pool already exists, skipping create."
else
  echo "Creating video node pool..."
  NODE_POOL="${VIDEO_POOL}" \
    MAX_NODES="${VIDEO_POOL_MAX_NODES}" \
    bash "${BOOTSTRAP_DIR}/create-gke-video-node-pool.sh"
fi

echo "Configuring video node pool autoscaling..."
NODE_POOL="${VIDEO_POOL}" bash "${BOOTSTRAP_DIR}/enable_workload_identity_node_pool.sh"
NODE_POOL="${VIDEO_POOL}" \
  MAX_NODES="${VIDEO_POOL_MAX_NODES}" \
  bash "${BOOTSTRAP_DIR}/autoscale_video_pool.sh"

echo "Persisting backend inference pool configuration..."
kubectl create configmap "${INFERENCE_CONFIG_MAP}" \
  --from-literal="CPU_INFERENCE_NODE_POOL=${CPU_POOL}" \
  --from-literal="GPU_INFERENCE_NODE_POOL=${GPU_POOL}" \
  --from-literal="VIDEO_NODE_POOL=${VIDEO_POOL}" \
  --from-literal="INFERENCE_NODE_POOL=${INFERENCE_POOL}" \
  --from-literal="INFERENCE_GPU_COUNT=${INFERENCE_GPU_COUNT}" \
  --from-literal="KUEUE_ENABLED=true" \
  --from-literal="KUEUE_NAME=benzaiten-local-queue" \
  --dry-run=client \
  -o yaml | kubectl apply -f -

# bootstrap kueue
KUEUE_VERSION="${KUEUE_VERSION:-v0.19.0}"
echo "Installing kueue ${KUEUE_VERSION}..."
kubectl apply --server-side -f \
  "https://github.com/kubernetes-sigs/kueue/releases/download/${KUEUE_VERSION}/manifests.yaml"

echo "Applying Kueue resources..."
KUEUE_DIR="${SCRIPT_DIR}/k8s/kueue" \
  NAMESPACE=default \
  bash "${SCRIPT_DIR}/deploy/apply-kueue-resources.sh"

# verify deployment
if kubectl get deployment benzaiten-inference-deployment >/dev/null 2>&1; then
  echo "Restarting backend to load the inference pool configuration..."
  kubectl rollout restart deployment/benzaiten-inference-deployment
fi

echo "Bootstrap finished"

kubectl get nodes -L cloud.google.com/gke-nodepool
kubectl get pods -A -o wide
