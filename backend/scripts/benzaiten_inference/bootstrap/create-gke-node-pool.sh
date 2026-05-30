#!/bin/bash
set -e

ZONE="${ZONE:-northamerica-northeast2-b}" #a,b,c
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}" #a,b,c

# create the GPU node pool. NOTE: need quotas for this
gcloud container node-pools create gpu-pool \
    --cluster "${CLUSTER}" \
    --zone "${ZONE}" \
    --machine-type g2-standard-8 \
    --accelerator type=nvidia-l4,count=1,gpu-driver-version=latest \
    --num-nodes 1 \
    --disk-type pd-standard \
    --disk-size 50

kubectl get nodes