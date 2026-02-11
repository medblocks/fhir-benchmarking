#!/bin/bash

# Exit immediately on error and print commands
set -euo pipefail

# Resolve paths
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )"
INFRA_DIR="$SCRIPT_DIR/.."
STACK_NAME="CouchbaseFhirVMStack"
OUTPUTS_FILE="cdk-outputs.json"

echo "Navigating to infra directory: $INFRA_DIR"
cd "$INFRA_DIR"

# Ensure required tools are available
for cmd in aws jq npx; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: Required command '$cmd' not found in PATH" >&2
    exit 1
  fi
done

echo "Checking if stack '$STACK_NAME' already exists..."
if aws cloudformation describe-stacks --stack-name "$STACK_NAME" &>/dev/null; then
  echo "Stack '$STACK_NAME' already exists. Skipping deployment."
  echo "If you want to update the stack, delete it first or modify this script."
else
  echo "Deploying CDK stack '$STACK_NAME' with verbose logging..."
  # Explicitly set the CDK app to the Couchbase/FHIR VM entrypoint
  npx cdk deploy "$STACK_NAME" \
    --app "npx ts-node --prefer-ts-exts bin/couchbase-fhir-vm.ts" \
    --require-approval never \
    --verbose \
    --outputs-file "$OUTPUTS_FILE"
fi

echo "Deployment finished. Retrieving key pair and instance information from CDK outputs..."

if [[ ! -f "$OUTPUTS_FILE" ]]; then
  echo "Error: Outputs file '$OUTPUTS_FILE' not found. Did the deploy succeed?" >&2
  exit 1
fi

# Parse outputs
KEY_PAIR_NAME=$(jq -r ".${STACK_NAME}.KeyPairName" "$OUTPUTS_FILE")
LOCUST_IP=$(jq -r ".${STACK_NAME}.LocustPublicIP" "$OUTPUTS_FILE")
FHIR_PUBLIC_IP=$(jq -r ".${STACK_NAME}.FhirServerPublicIP" "$OUTPUTS_FILE")
FHIR_PRIVATE_IP=$(jq -r ".${STACK_NAME}.FhirServerPrivateIP" "$OUTPUTS_FILE")
COUCHBASE_PRIVATE_IP=$(jq -r ".${STACK_NAME}.CouchbasePrivateIP" "$OUTPUTS_FILE")
FHIR_FRONTEND_URL=$(jq -r ".${STACK_NAME}.FhirFrontendURL" "$OUTPUTS_FILE")
FHIR_BACKEND_URL=$(jq -r ".${STACK_NAME}.FhirBackendURL" "$OUTPUTS_FILE")
FHIR_METADATA_URL=$(jq -r ".${STACK_NAME}.FhirMetadataURL" "$OUTPUTS_FILE")
FHIR_PRIVATE_URL=$(jq -r ".${STACK_NAME}.FhirServerPrivateURL" "$OUTPUTS_FILE")
LOCUST_WEB_UI=$(jq -r ".${STACK_NAME}.LocustWebUI" "$OUTPUTS_FILE")

if [[ -z "$KEY_PAIR_NAME" || "$KEY_PAIR_NAME" == "null" ]]; then
  echo "Error: Could not read KeyPairName from $OUTPUTS_FILE" >&2
  exit 1
fi

echo "Retrieving SSH key from AWS SSM Parameter Store..."
mkdir -p "$INFRA_DIR/keys"
KEY_FILE="$INFRA_DIR/keys/${KEY_PAIR_NAME}.pem"
rm -f "$KEY_FILE"

KEYPAIR_ID=$(aws ec2 describe-key-pairs --key-names "$KEY_PAIR_NAME" --query 'KeyPairs[0].KeyPairId' --output text)
if [[ -z "$KEYPAIR_ID" || "$KEYPAIR_ID" == "None" ]]; then
  echo "Error: Could not resolve KeyPairId for key '$KEY_PAIR_NAME'" >&2
  exit 1
fi

aws ssm get-parameter \
  --name "/ec2/keypair/$KEYPAIR_ID" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text > "$KEY_FILE"
chmod 400 "$KEY_FILE"
echo "✅ SSH key saved to: $KEY_FILE"

echo "Creating connection info file..."
CONN_INFO_FILE="$INFRA_DIR/keys/couchbase-fhir-connection-info.txt"
cat > "$CONN_INFO_FILE" <<EOF
====================================
Couchbase + FHIR VM Stack Connection Info
====================================

STACK: ${STACK_NAME}
KEY PAIR: ${KEY_PAIR_NAME}
KEY LOCATION: $KEY_FILE

INSTANCE IPs:
- Couchbase: ${COUCHBASE_PRIVATE_IP} (private)
- FHIR Server: ${FHIR_PRIVATE_IP} (private), ${FHIR_PUBLIC_IP} (public)
- Locust: ${LOCUST_IP} (public)

FHIR URLS:
- Frontend: ${FHIR_FRONTEND_URL}
- Backend (public): ${FHIR_BACKEND_URL}
- Metadata (public): ${FHIR_METADATA_URL}
- Backend (private - use for load tests): ${FHIR_PRIVATE_URL}

COUCHBASE:
- Console (private): http://${COUCHBASE_PRIVATE_IP}:8091/

LOCUST WEB UI:
- URL: ${LOCUST_WEB_UI}

SSH COMMANDS:
- Locust: ssh -i infra/keys/${KEY_PAIR_NAME}.pem ec2-user@${LOCUST_IP}
- FHIR Server: ssh -i infra/keys/${KEY_PAIR_NAME}.pem ec2-user@${FHIR_PUBLIC_IP}

TARGET HOST FOR LOCUST (private backend):
export TARGET_HOST=${FHIR_PRIVATE_URL}

CLOUDWATCH LOGS (names):
$(jq -r ".${STACK_NAME} | to_entries[] | select(.key | test(\"LogGroup\")) | \"- \(.key): \(.value.description // .value)\"" "$OUTPUTS_FILE")

====================================
EOF

cat "$CONN_INFO_FILE"

echo ""
echo "📄 Connection info saved to: $CONN_INFO_FILE"
echo ""
echo "⏳ Note: Instances are still being configured. This may take 10-20 minutes."
echo "   - Couchbase: ~3-5 minutes (package + cluster init)"
echo "   - FHIR Server: ~5-10 minutes (docker + app startup)"
echo "   - Locust: ~2-3 minutes"
echo ""
echo "📊 Monitor progress in CloudWatch Logs (see links above in the connection info)"
echo "🔍 Or SSH into instances to check logs:"
echo "   ssh -i infra/keys/${KEY_PAIR_NAME}.pem ec2-user@${LOCUST_IP}"
