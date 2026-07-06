#!/bin/bash
set -e

ZONE="${ZONE:-northamerica-northeast2-b}"
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}"
NODE_POOL="${NODE_POOL:-video-pool}"
MAX_NODES="${MAX_NODES:-2}"

gcloud container node-pools create "${NODE_POOL}" \
    --cluster "${CLUSTER}" \
    --zone "${ZONE}" \
    --machine-type e2-highcpu-8 \
    --num-nodes 1 \
    --disk-type pd-balanced \
    --disk-size 100 \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --node-taints=inference=true:NoSchedule \
    --enable-autoscaling \
    --min-nodes 0 \
    --max-nodes "${MAX_NODES}"

kubectl get nodes -L cloud.google.com/gke-nodepool
