#!/bin/bash
set -e

ZONE="${ZONE:-northamerica-northeast2-b}" #a,b,c
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}" #a,b,c
NODE_POOL="${NODE_POOL:-cpu-inference-pool}"
DEPLOYMENT="${DEPLOYMENT:-benzaiten-inference-deployment}"

# cluster credentials init so kubectl points to the right cluster
gcloud container clusters get-credentials "${CLUSTER}" --zone "${ZONE}"

# node autoscaling to dynamically add/remove VMs in the node pool based on workload demand
gcloud container clusters update "${CLUSTER}" \
    --zone "${ZONE}" \
    --enable-autoscaling \
    --node-pool "${NODE_POOL}" \
    --min-nodes 0 \
    --max-nodes 3

# check results
kubectl get nodes
kubectl get pods