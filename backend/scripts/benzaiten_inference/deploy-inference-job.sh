#!/bin/bash
set -e

PROJECT_ID=$(gcloud config get-value project)
ZONE=northamerica-northeast2-b #a,b,c
CLUSTER=benzaiten-inference-cluster-b #a,b,c
YAML_PATH="./backend/scripts/benzaiten_inference/k8s/inference-deployment.yaml"

gcloud container clusters get-credentials "${CLUSTER}" --zone "${ZONE}"
sed "s/PROJECT_ID/${PROJECT_ID}/g" "${YAML_PATH}" | kubectl apply -f -
kubectl get pods