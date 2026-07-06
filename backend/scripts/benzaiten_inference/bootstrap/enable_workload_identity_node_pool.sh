#!/bin/bash
set -euo pipefail

ZONE="${ZONE:-northamerica-northeast2-b}"
CLUSTER="${CLUSTER:-benzaiten-inference-cluster-b}"
NODE_POOL="${NODE_POOL:?NODE_POOL is required}"

echo "Ensuring ${NODE_POOL} uses the GKE metadata server..."
gcloud container node-pools update "${NODE_POOL}" \
  --cluster "${CLUSTER}" \
  --zone "${ZONE}" \
  --workload-metadata=GKE_METADATA
