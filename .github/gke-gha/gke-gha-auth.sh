#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="project-0c6e9a84-c914-4d2f-ace"

GITHUB_OWNER="kseto06"
GITHUB_REPO="Benzaiten"

POOL_ID="github-actions-pool"
PROVIDER_ID="github-actions-provider"

SERVICE_ACCOUNT_EMAIL="$(
  gcloud iam service-accounts list \
    --project="$PROJECT_ID" \
    --filter="email:github-actions-sa@${PROJECT_ID}.iam.gserviceaccount.com" \
    --format="value(email)"
)"

echo "Using project: $PROJECT_ID"
echo "GitHub repository: $GITHUB_OWNER/$GITHUB_REPO"
echo "Service account: $SERVICE_ACCOUNT_EMAIL"

if [[ "$SERVICE_ACCOUNT_EMAIL" == YOUR_SERVICE_ACCOUNT* ]]; then
  echo "Error: Replace YOUR_SERVICE_ACCOUNT with the real service-account name."
  exit 1
fi

echo "Getting project number..."

PROJECT_NUMBER="$(
  gcloud projects describe "$PROJECT_ID" \
    --format="value(projectNumber)"
)"

echo "Project number: $PROJECT_NUMBER"

echo "Enabling required APIs..."

gcloud services enable \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  cloudresourcemanager.googleapis.com \
  --project="$PROJECT_ID"

echo "Creating Workload Identity Pool..."

if gcloud iam workload-identity-pools describe "$POOL_ID" \
  --project="$PROJECT_ID" \
  --location="global" >/dev/null 2>&1; then
  echo "Pool already exists: $POOL_ID"
else
  gcloud iam workload-identity-pools create "$POOL_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --display-name="GitHub Actions Pool"
fi

echo "Creating GitHub OIDC provider..."

if gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
  --project="$PROJECT_ID" \
  --location="global" \
  --workload-identity-pool="$POOL_ID" >/dev/null 2>&1; then
  echo "Provider already exists: $PROVIDER_ID"
else
  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_ID" \
    --display-name="GitHub Actions Provider" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
    --attribute-condition="assertion.repository == '${GITHUB_OWNER}/${GITHUB_REPO}'"
fi

echo "Allowing the GitHub repository to impersonate the service account..."

gcloud iam service-accounts add-iam-policy-binding \
  "$SERVICE_ACCOUNT_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${GITHUB_OWNER}/${GITHUB_REPO}"

echo "Retrieving provider resource name..."

WORKLOAD_IDENTITY_PROVIDER="$(
  gcloud iam workload-identity-pools providers describe "$PROVIDER_ID" \
    --project="$PROJECT_ID" \
    --location="global" \
    --workload-identity-pool="$POOL_ID" \
    --format="value(name)"
)"

echo
echo "Setup complete."
echo
echo "Add these GitHub repository secrets:"
echo
echo "WORKLOAD_IDENTITY_PROVIDER"
echo "$WORKLOAD_IDENTITY_PROVIDER"
echo
echo "GCP_SERVICE_ACCOUNT"
echo "$SERVICE_ACCOUNT_EMAIL"