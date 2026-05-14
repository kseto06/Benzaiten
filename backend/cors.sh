#!/bin/bash
set -e

gcloud storage buckets update gs://benzaiten-outputs --cors-file=backend/cors.json