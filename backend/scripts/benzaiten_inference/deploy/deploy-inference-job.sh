#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
K8S_DIR="${K8S_DIR:-${SCRIPT_DIR}/../k8s}"
NAMESPACE="${NAMESPACE:-default}"

kubectl apply -f "${K8S_DIR}/backend-rbac.yaml" --namespace "${NAMESPACE}"
kubectl apply -f "${K8S_DIR}/backend-deployment.yaml" --namespace "${NAMESPACE}"
kubectl apply -f "${K8S_DIR}/service.yaml" --namespace "${NAMESPACE}"