#!/bin/bash
set -euo pipefail

PROJECT_ID=$(gcloud config get-value project)
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format="value(projectNumber)")

COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
K8S_NAMESPACE="${K8S_NAMESPACE:-default}"
K8S_BACKEND_SA="${K8S_BACKEND_SA:-benzaiten-backend-sa}"
GCP_BACKEND_SA_NAME="${GCP_BACKEND_SA_NAME:-benzaiten-backend}"
GCP_BACKEND_SA="${GCP_BACKEND_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud services enable iamcredentials.googleapis.com

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="roles/artifactregistry.reader"

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="roles/storage.objectAdmin"

if gcloud iam service-accounts describe "${GCP_BACKEND_SA}" >/dev/null 2>&1; then
    echo "Google service account exists: ${GCP_BACKEND_SA}"
else
    gcloud iam service-accounts create "${GCP_BACKEND_SA_NAME}" \
        --display-name="Benzaiten backend"
fi

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${GCP_BACKEND_SA}" \
    --role="roles/storage.objectAdmin"

gcloud iam service-accounts add-iam-policy-binding "${GCP_BACKEND_SA}" \
    --member="serviceAccount:${PROJECT_ID}.svc.id.goog[${K8S_NAMESPACE}/${K8S_BACKEND_SA}]" \
    --role="roles/iam.workloadIdentityUser"

gcloud iam service-accounts add-iam-policy-binding "${GCP_BACKEND_SA}" \
    --member="serviceAccount:${GCP_BACKEND_SA}" \
    --role="roles/iam.serviceAccountTokenCreator"

kubectl create serviceaccount "${K8S_BACKEND_SA}" \
    --namespace "${K8S_NAMESPACE}" \
    --dry-run=client \
    -o yaml | kubectl apply -f -

kubectl annotate serviceaccount "${K8S_BACKEND_SA}" \
    --namespace "${K8S_NAMESPACE}" \
    "iam.gke.io/gcp-service-account=${GCP_BACKEND_SA}" \
    --overwrite
