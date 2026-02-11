#!/bin/bash

# Script to upload patient data to FHIR server
# Run upload_hospital_orgs_synthea.sh first to upload hospital/practitioner data

echo "========================================"
echo "Patient Data Upload Script"
echo "========================================"
echo ""

# Prompt for FHIR server IP address
read -p "Enter FHIR server IP address (e.g., 192.168.1.100 or localhost): " FHIR_IP
if [ -z "$FHIR_IP" ]; then
  echo "Error: IP address cannot be empty"
  exit 1
fi

read -p "Enter FHIR server port [8080]: " FHIR_PORT
FHIR_PORT=${FHIR_PORT:-8080}

FHIR_URL="http://${FHIR_IP}:${FHIR_PORT}/fhir"
echo "FHIR Server URL: ${FHIR_URL}"
echo ""

# Check if bearer token authentication is required
# Set FHIR_AUTH_TOKEN environment variable if needed
# Example: export FHIR_AUTH_TOKEN="your-bearer-token-here"

if [ -n "$FHIR_AUTH_TOKEN" ]; then
  echo "✓ Using bearer token from FHIR_AUTH_TOKEN environment variable"
  AUTH_HEADER="Authorization: Bearer $FHIR_AUTH_TOKEN"
else
  echo "ℹ No FHIR_AUTH_TOKEN environment variable set"
  read -p "Do you need bearer token authentication? (y/n): " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    read -p "Enter your bearer token: " FHIR_AUTH_TOKEN
    echo ""  # New line after hidden input
    if [ -n "$FHIR_AUTH_TOKEN" ]; then
      echo "✓ Bearer token set"
      AUTH_HEADER="Authorization: Bearer $FHIR_AUTH_TOKEN"
    else
      echo "✗ No token provided, continuing without authentication"
      AUTH_HEADER=""
    fi
  else
    echo "ℹ Proceeding without authentication"
    AUTH_HEADER=""
  fi
fi

echo ""
echo "Starting patient uploads..."
echo "========================================"

# Function to upload a batch of files
upload_batch() {
  local batch_num=$1
  shift
  local files=("$@")
  
  echo "=== Starting batch $batch_num with ${#files[@]} files ==="
  
  for f in "${files[@]}"; do
    echo "Uploading $f (batch $batch_num)"
    
    # Build curl command with optional auth header
    if [ -n "$AUTH_HEADER" ]; then
      code=$(curl -sS -o /tmp/resp_${batch_num}_${f}.json -w "%{http_code}" \
        -H 'Accept: application/fhir+json' \
        -H 'Content-Type: application/fhir+json;charset=utf-8' \
        -H "$AUTH_HEADER" \
        -X POST "$FHIR_URL" \
        --data-binary "@$f")
    else
      code=$(curl -sS -o /tmp/resp_${batch_num}_${f}.json -w "%{http_code}" \
        -H 'Accept: application/fhir+json' \
        -H 'Content-Type: application/fhir+json;charset=utf-8' \
        -X POST "$FHIR_URL" \
        --data-binary "@$f")
    fi
    
    echo "HTTP $code - $f"
    
    if [ "$code" -ge 400 ]; then
      echo "Error response for $f:"; head -n 120 /tmp/resp_${batch_num}_${f}.json
      return 1
    fi
  done
  
  echo "=== Completed batch $batch_num ==="
  return 0
}

# Collect all eligible files
files=()
for f in *.json; do
  case "$f" in
    hospitalInformation*|practitionerInformation*) continue;;
  esac
  files+=("$f")
done

total_files=${#files[@]}
echo "Total files to upload: $total_files"

# Process in batches of 50 with max 2 parallel batches
batch_size=50
max_parallel=1
batch_num=0
active_jobs=0

for ((i=0; i<$total_files; i+=batch_size)); do
  # Extract batch
  batch=("${files[@]:$i:$batch_size}")
  ((batch_num++))
  
  # Wait if we've hit the parallel limit
  while [ $active_jobs -ge $max_parallel ]; do
    wait -n
    ((active_jobs--))
  done
  
  # Start batch in background
  upload_batch $batch_num "${batch[@]}" &
  ((active_jobs++))
  
  # Sleep 10 seconds between batches
  echo "Sleeping 10 seconds before next batch..."
  sleep 10
done

# Wait for all remaining jobs
wait

echo "All uploads completed!"