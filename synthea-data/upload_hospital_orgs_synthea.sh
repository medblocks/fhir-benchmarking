#!/bin/bash

# Script to upload hospital/organization and practitioner information to FHIR server
# This should be run before uploading patient data

echo "========================================"
echo "Hospital & Practitioner Upload Script"
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
echo "Starting uploads..."
echo "========================================"

# Upload hospital/organization information first
# This contains Organization resources that patient encounters reference
for f in hospitalInformation*.json; do
  [ -e "$f" ] || continue 
  echo "Uploading $f"
  
  # Build curl command with optional auth header
  if [ -n "$AUTH_HEADER" ]; then
    curl -sS -H 'Accept: application/fhir+json' \
         -H 'Content-Type: application/fhir+json;charset=utf-8' \
         -H "$AUTH_HEADER" \
         -X POST "$FHIR_URL" \
         --data-binary "@$f" -o /tmp/resp.json -w "HTTP %{http_code}\n" | cat
  else
    curl -sS -H 'Accept: application/fhir+json' \
         -H 'Content-Type: application/fhir+json;charset=utf-8' \
         -X POST "$FHIR_URL" \
         --data-binary "@$f" -o /tmp/resp.json -w "HTTP %{http_code}\n" | cat
  fi
  
  head -n 40 /tmp/resp.json  
done

# Upload practitioner information
# This contains Practitioner resources that patient encounters reference
for f in practitionerInformation*.json; do
  [ -e "$f" ] || continue  
  echo "Uploading $f"
  
  # Build curl command with optional auth header
  if [ -n "$AUTH_HEADER" ]; then
    curl -sS -H 'Accept: application/fhir+json' \
         -H 'Content-Type: application/fhir+json;charset=utf-8' \
         -H "$AUTH_HEADER" \
         -X POST "$FHIR_URL" \
         --data-binary "@$f" -o /tmp/resp.json -w "HTTP %{http_code}\n" | cat
  else
    curl -sS -H 'Accept: application/fhir+json' \
         -H 'Content-Type: application/fhir+json;charset=utf-8' \
         -X POST "$FHIR_URL" \
         --data-binary "@$f" -o /tmp/resp.json -w "HTTP %{http_code}\n" | cat
  fi
  
  head -n 40 /tmp/resp.json 
done
