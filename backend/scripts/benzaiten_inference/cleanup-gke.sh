#!/bin/bash
set -e

ZONE=northamerica-northeast2-b
CLUSTER=benzaiten-inference-cluster-b

# delete GKE cluster on finish
echo "About to delete cluster ${CLUSTER} in zone: ${ZONE}"
gcloud container clusters delete "${CLUSTER}" --zone "${ZONE}"