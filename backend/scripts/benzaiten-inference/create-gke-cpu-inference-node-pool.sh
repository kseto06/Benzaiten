#!/bin/bash
set -e

ZONE=northamerica-northeast2-a
CLUSTER=benzaiten-inference-cluster

# create the CPU node pool for inference
gcloud container node-pools create cpu-inference-pool \
    --cluster "${CLUSTER}" \
    --zone "${ZONE}" \
    --machine-type e2-standard-4 \
    --num-nodes 1 \
    --disk-type pd-standard \
    --disk-size 30

kubectl get nodes