#!/bin/bash
set -e

DEPLOYMENT="${DEPLOYMENT:-benzaiten-inference-deployment}"
NAMESPACE="${NAMESPACE:-default}"

kubectl rollout restart deployment "${DEPLOYMENT}" --namespace "${NAMESPACE}"
kubectl rollout status deployment "${DEPLOYMENT}" --namespace "${NAMESPACE}"
# kubectl logs -f deployment/benzaiten-inference-deployment
kubectl get pods -o wide --namespace "${NAMESPACE}"