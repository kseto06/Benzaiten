#!/bin/bash
set -e

ZONE=northamerica-northeast2-b #a,b,c
CLUSTER=benzaiten-inference-cluster-b #a,b,c

# cluster credentials init so kubectl points to the right cluster
gcloud container clusters get-credentials "${CLUSTER}" --zone "${ZONE}"

# node autoscaling for the GPU node pool
# This dynamically adds/removes GPU VMs based on pending GPU workload demand
gcloud container clusters update "${CLUSTER}" \
    --zone "${ZONE}" \
    --enable-autoscaling \
    --node-pool gpu-pool \
    --min-nodes 0 \
    --max-nodes 2

# scales pods by CPU usage (though not GPU usage)
# max=2 because each pod requests 1 GPU and pool max is 2 GPU nodes.
kubectl autoscale deployment benzaiten-inference-deployment \
    --cpu-percent=70 \
    --min=1 \
    --max=2 \
    --dry-run=client -o yaml | kubectl apply -f -

# check results
kubectl get hpa
kubectl get nodes
kubectl get pods -o wide