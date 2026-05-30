#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BOOTSTRAP_DIR="${SCRIPT_DIR}/bootstrap"

ZONE="${ZONE:-northamerica-northeast2-b}"
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}"
CPU_POOL="${CPU_POOL:-cpu-inference-pool}"
GPU_POOL="${GPU_POOL:-gpu-pool}"

echo "Bootstrapping Benzaiten GKE infrastructure..."
echo "Cluster: ${CLUSTER}"
echo "Zone: ${ZONE}"

echo "Checking GKE cluster..."
if gcloud container clusters describe "${CLUSTER}" --zone "${ZONE}" >/dev/null 2>&1; then
  echo "Cluster already exists, skipping create."
  gcloud container clusters get-credentials "${CLUSTER}" --zone "${ZONE}"
else
  echo "Creating GKE cluster..."
  bash "${BOOTSTRAP_DIR}/create-gke-cluster.sh"
fi

echo "Configuring IAM..."
bash "${BOOTSTRAP_DIR}/iam.sh"

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

# optional gpu setup
if [ "${ENABLE_GPU:-false}" = "true" ]; then
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
  echo "Skipping GPU node pool setup."
fi

echo "Bootstrap finished."

kubectl get nodes -L cloud.google.com/gke-nodepool
kubectl get pods -A -o wide