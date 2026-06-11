#!/bin/bash
set -e

ZONE="${ZONE:-northamerica-northeast2-b}" #a,b,c
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}" #a,b,c
NODE_POOL="${NODE_POOL:-gpu-pool}"
MAX_NODES="${MAX_NODES:-1}"

# create the GPU node pool. NOTE: need quotas for this
gcloud container node-pools create "${NODE_POOL}" \
    --cluster "${CLUSTER}" \
    --zone "${ZONE}" \
    --machine-type g2-standard-8 \
    --accelerator type=nvidia-l4,count=1,gpu-driver-version=latest \
    --num-nodes 1 \
    --disk-type pd-balanced \
    --disk-size 100 \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --node-taints=inference=true:NoSchedule \
    --enable-autoscaling \
    --min-nodes 0 \
    --max-nodes "${MAX_NODES}"

kubectl get nodes -L cloud.google.com/gke-nodepool
