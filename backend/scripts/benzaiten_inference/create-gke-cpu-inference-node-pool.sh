#!/bin/bash
set -e

ZONE=northamerica-northeast2-b
CLUSTER=benzaiten-inference-cluster-b
NEW_POOL=cpu-inference-pool

gcloud container node-pools create "${NEW_POOL}" \
    --cluster "${CLUSTER}" \
    --zone "${ZONE}" \
    --machine-type e2-highmem-8 \
    --num-nodes 1 \
    --disk-type pd-balanced \
    --disk-size 100 \
    --scopes=https://www.googleapis.com/auth/cloud-platform \
    --node-taints=inference=true:NoSchedule \
    --enable-autoscaling \
    --min-nodes 0 \
    --max-nodes 2

kubectl get nodes -L cloud.google.com/gke-nodepool