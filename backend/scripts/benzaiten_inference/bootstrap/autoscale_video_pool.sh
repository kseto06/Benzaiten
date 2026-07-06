#!/bin/bash
set -e

ZONE="${ZONE:-northamerica-northeast2-b}"
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}"
NODE_POOL="${NODE_POOL:-video-pool}"
MAX_NODES="${MAX_NODES:-2}"

# CPU node autoscaling for ffmpeg/video composition workloads.
gcloud container clusters update "${CLUSTER}" \
    --zone "${ZONE}" \
    --enable-autoscaling \
    --node-pool "${NODE_POOL}" \
    --min-nodes 0 \
    --max-nodes "${MAX_NODES}"

kubectl get nodes -L cloud.google.com/gke-nodepool
kubectl get pods -o wide
