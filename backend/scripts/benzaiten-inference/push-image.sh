PROJECT_ID=$(gcloud config get-value project)
REGION=northamerica-northeast2
REPO=benzaiten
IMAGE=benzaiten-inference
TAG=latest

IMAGE_URI="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}"

gcloud auth configure-docker ${REGION}-docker.pkg.dev

docker buildx build \
  --platform linux/amd64 \
  -t "${IMAGE_URI}" \
  --push .