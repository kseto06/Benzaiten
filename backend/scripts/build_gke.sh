#!/bin/bash
set -e

# note: run this from the backend/scripts/ directory

# init main components
bash benzaiten-inference/create-gke-cluster.sh
bash benzaiten-inference/updaters/iam.sh
bash benzaiten-inference/create-gke-cpu-inference-node-pool.sh

# run updaters
bash benzaiten-inference/updaters/autoscale_cpu_inference_cluster.sh

# apply k8s manifests
kubectl apply -f benzaiten-inference/k8s/backend-rbac.yaml
kubectl apply -f benzaiten-inference/k8s/backend-deployment.yaml
kubectl apply -f benzaiten-inference/k8s/service.yaml

# restart k8 deployments
bash restart_deployment.sh

kubectl get nodes -L cloud.google.com/gke-nodepool
kubectl get pods -A -o wide
kubectl get svc