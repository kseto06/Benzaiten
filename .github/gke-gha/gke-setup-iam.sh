#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="project-0c6e9a84-c914-4d2f-ace"  
GITHUB_ACTIONS_SA="$(
  gcloud iam service-accounts list \
    --project="$PROJECT_ID" \
    --filter="email:github-actions-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
    --format="value(email)"
)"
  
gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${GITHUB_ACTIONS_SA}" --role="roles/container.admin"

PROJECT_NUMBER="$(
  gcloud projects describe "$PROJECT_ID" \
    --format="value(projectNumber)"
)"

NODE_SERVICE_ACCOUNT="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

gcloud iam service-accounts add-iam-policy-binding "$NODE_SERVICE_ACCOUNT" --project="$PROJECT_ID" --member="serviceAccount:${GITHUB_ACTIONS_SA}" --role="roles/iam.serviceAccountUser"

PROJECT_ID="project-0c6e9a84-c914-4d2f-ace"

echo "$GITHUB_ACTIONS_SA"

gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:${GITHUB_ACTIONS_SA}" --role="roles/resourcemanager.projectIamAdmin"

gcloud projects add-iam-policy-binding "${PROJECT_ID}" --member="serviceAccount:${GITHUB_ACTIONS_SA}" --role="roles/artifactregistry.writer"