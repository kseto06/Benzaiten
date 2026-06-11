#!/bin/bash
set -e

ZONE="${ZONE:-northamerica-northeast2-b}" #a,b,c
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}" #a,b,c
NODE_POOL="${NODE_POOL:-gpu-pool}"
MAX_NODES="${MAX_NODES:-1}"

# cluster credentials init so kubectl points to the right cluster
gcloud container clusters get-credentials "${CLUSTER}" --zone "${ZONE}"

# node autoscaling for the GPU node pool
# This dynamically adds/removes GPU VMs based on pending GPU workload demand
gcloud container clusters update "${CLUSTER}" \
    --zone "${ZONE}" \
    --enable-autoscaling \
    --node-pool "${NODE_POOL}" \
    --min-nodes 0 \
    --max-nodes "${MAX_NODES}"

# check results
kubectl get nodes -L cloud.google.com/gke-nodepool
kubectl get pods -o wide
