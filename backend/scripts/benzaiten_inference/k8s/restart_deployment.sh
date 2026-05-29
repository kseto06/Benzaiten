#!/bin/bash
set -e

kubectl rollout restart deployment benzaiten-inference-deployment
kubectl rollout status deployment benzaiten-inference-deployment
kubectl logs -f deployment/benzaiten-inference-deployment
kubectl get pods