#!/bin/bash
set -e

kubectl apply -f backend-rbac.yaml
kubectl apply -f backend-deployment.yaml
kubectl apply -f service.yaml