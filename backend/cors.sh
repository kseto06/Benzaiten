#!/usr/bin/env bash
set -euo pipefail

GCS_BUCKET="${GCS_BUCKET:-benzaiten-outputs}"
CORS_FILE="${CORS_FILE:-backend/cors.json}"

gcloud storage buckets update "gs://${GCS_BUCKET}" --cors-file="${CORS_FILE}"
