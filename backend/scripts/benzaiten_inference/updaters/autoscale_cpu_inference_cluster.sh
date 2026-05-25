#!/bin/bash
set -e

ZONE=northamerica-northeast2-b #a,b,c
CLUSTER=benzaiten-inference-cluster-b #a,b,c
NODE_POOL=cpu-inference-pool
DEPLOYMENT=benzaiten-inference-deployment

# cluster credentials init so kubectl points to the right cluster
gcloud container clusters get-credentials "${CLUSTER}" --zone "${ZONE}"

# node autoscaling to dynamically add/remove VMs in the node pool based on workload demand
gcloud container clusters update "${CLUSTER}" \
    --zone "${ZONE}" \
    --enable-autoscaling \
    --node-pool "${NODE_POOL}" \
    --min-nodes 0 \
    --max-nodes 3

# HPA for pod autoscaling (dynamically add/remove replicas of the fastapi pod)
kubectl autoscale deployment "${DEPLOYMENT}" \
    --cpu-percent=70 \
    --min=1 \
    --max=6 \
    --dry-run=client -o yaml | kubectl apply -f -

# check results
kubectl get hpa
kubectl get nodes
kubectl get pods