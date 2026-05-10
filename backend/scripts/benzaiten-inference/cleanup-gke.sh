#!/bin/bash
set -e

ZONE=northamerica-northeast2-a
CLUSTER=benzaiten-inference-cluster

# delete GKE cluster on finish
gcloud container clusters delete "${CLUSTER}" --zone "${ZONE}"