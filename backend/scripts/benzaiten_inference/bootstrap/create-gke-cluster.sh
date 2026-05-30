#!/bin/bash
set -e

PROJECT_ID=$(gcloud config get-value project)
ZONE=${ZONE:-northamerica-northeast2-b} #a,b,c
CLUSTER=${CLUSTER:-benzaiten-inference-cluster-b} #a,b,c

# enable apis
gcloud services enable container.googleapis.com
gcloud services enable artifactregistry.googleapis.com

# create base cluster
gcloud container clusters create "${CLUSTER}" \
    --zone "${ZONE}" \
    --release-channel regular \
    --machine-type e2-standard-2 \
    --num-nodes 1 \
    --disk-type pd-balanced \
    --disk-size 50 \
    --enable-ip-alias

# credentials
gcloud container clusters get-credentials "${CLUSTER}" --zone "${ZONE}"

kubectl get nodes
