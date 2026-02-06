#!/usr/bin/env bash
set -euo pipefail

if ! command -v gcloud >/dev/null 2>&1; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
  if [[ -x "${ROOT_DIR}/google-cloud-sdk/bin/gcloud" ]]; then
    export PATH="${ROOT_DIR}/google-cloud-sdk/bin:${PATH}"
  elif [[ -x "${HOME}/google-cloud-sdk/bin/gcloud" ]]; then
    export PATH="${HOME}/google-cloud-sdk/bin:${PATH}"
  fi
fi

if ! command -v gcloud >/dev/null 2>&1; then
  echo "gcloud not found. Install the Google Cloud SDK first:"
  echo "https://cloud.google.com/sdk/docs/install"
  exit 1
fi

PROJECT="${GOOGLE_CLOUD_PROJECT:-}"
LOCATION="${VERTEX_LOCATION:-us-central1}"
OUTPUT_URI="${VERTEX_OUTPUT_GCS_URI:-}"

if [[ -z "$PROJECT" ]]; then
  echo "GOOGLE_CLOUD_PROJECT is not set. Set it in .env and retry."
  exit 1
fi

if [[ -z "$OUTPUT_URI" ]]; then
  OUTPUT_URI="gs://${PROJECT}-veo-outputs/veo-outputs"
  echo "VERTEX_OUTPUT_GCS_URI not set. Using default: $OUTPUT_URI"
fi

if [[ "$OUTPUT_URI" != gs://* ]]; then
  echo "VERTEX_OUTPUT_GCS_URI must be a gs:// path. Got: $OUTPUT_URI"
  exit 1
fi

BUCKET="${OUTPUT_URI#gs://}"
BUCKET="${BUCKET%%/*}"
if [[ -z "$BUCKET" ]]; then
  echo "Failed to parse bucket from VERTEX_OUTPUT_GCS_URI: $OUTPUT_URI"
  exit 1
fi

echo "Using project: $PROJECT"
echo "Using location: $LOCATION"
echo "Using bucket: $BUCKET"

gcloud config set project "$PROJECT" >/dev/null

echo "Enabling APIs..."
gcloud services enable aiplatform.googleapis.com storage.googleapis.com >/dev/null

if gcloud storage buckets describe "gs://${BUCKET}" >/dev/null 2>&1; then
  echo "Bucket exists: gs://${BUCKET}"
else
  echo "Creating bucket gs://${BUCKET}..."
  gcloud storage buckets create "gs://${BUCKET}" \
    --location="${LOCATION}" \
    --uniform-bucket-level-access
fi

SA_NAME="veo-runner"
SA_EMAIL="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"

if gcloud iam service-accounts describe "${SA_EMAIL}" >/dev/null 2>&1; then
  echo "Service account exists: ${SA_EMAIL}"
else
  echo "Creating service account ${SA_EMAIL}..."
  gcloud iam service-accounts create "${SA_NAME}" \
    --display-name="Veo Runner"
fi

echo "Granting roles..."
gcloud projects add-iam-policy-binding "${PROJECT}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/aiplatform.user" >/dev/null

gcloud storage buckets add-iam-policy-binding "gs://${BUCKET}" \
  --member="serviceAccount:${SA_EMAIL}" \
  --role="roles/storage.objectAdmin" >/dev/null

KEY_PATH="$(pwd)/backend/vertex-sa.json"
if [[ -f "$KEY_PATH" ]]; then
  echo "Service account key already exists at: ${KEY_PATH}"
else
  echo "Creating service account key at: ${KEY_PATH}"
  gcloud iam service-accounts keys create "$KEY_PATH" \
    --iam-account="${SA_EMAIL}"
fi

echo ""
echo "Done. Add this to your shell before starting the backend:"
echo "export GOOGLE_APPLICATION_CREDENTIALS=\"${KEY_PATH}\""
echo ""
echo "Make sure .env has:"
echo "GOOGLE_CLOUD_PROJECT=${PROJECT}"
echo "VERTEX_LOCATION=${LOCATION}"
echo "VERTEX_OUTPUT_GCS_URI=${OUTPUT_URI}"
