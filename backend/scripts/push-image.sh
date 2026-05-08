PROJECT_ID=$(gcloud config get-value project)
REGION=northamerica-northeast2
REPO=benzaiten
IMAGE=benzaiten-inference
TAG=latest

gcloud auth configure-docker ${REGION}-docker.pkg.dev

docker build -t ${IMAGE} .

docker tag ${IMAGE} \
${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}

docker push \
${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${IMAGE}:${TAG}