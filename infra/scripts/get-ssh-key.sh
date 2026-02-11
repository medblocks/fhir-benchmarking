#!/bin/bash
# Script to fetch the SSH key for EC2 instances
# Usage: ./scripts/get-ssh-key.sh [stack-name]
# Available stacks: HapiStack, CouchbaseFhirVMStack

script_path=$(readlink -f ${BASH_SOURCE})
echo "Executing script from ${script_path}"
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Available stacks
AVAILABLE_STACKS=("HapiStack" "CouchbaseFhirVMStack")

# Check if running with sudo (which loses AWS credentials)
if [ -n "$SUDO_USER" ]; then
  echo -e "${RED}Error: Do not run this script with sudo${NC}"
  echo -e "${YELLOW}AWS credentials are not available in sudo environment${NC}"
  echo -e "${YELLOW}Run without sudo: ./infra/scripts/get-ssh-key.sh${NC}"
  exit 1
fi

# Check if AWS credentials are configured
if ! aws sts get-caller-identity &>/dev/null; then
  echo -e "${RED}Error: AWS credentials not configured${NC}"
  echo -e "${YELLOW}Run 'aws configure' to set up your credentials${NC}"
  exit 1
fi

# Function to display available stacks and prompt for selection
select_stack() {
  echo -e "${BLUE}Available stacks:${NC}"
  for i in "${!AVAILABLE_STACKS[@]}"; do
    echo -e "  ${GREEN}$((i+1)).${NC} ${AVAILABLE_STACKS[$i]}"
  done
  echo ""
  
  while true; do
    read -p "Select stack number (1-${#AVAILABLE_STACKS[@]}): " selection
    
    if [[ "$selection" =~ ^[0-9]+$ ]] && [ "$selection" -ge 1 ] && [ "$selection" -le "${#AVAILABLE_STACKS[@]}" ]; then
      STACK_NAME="${AVAILABLE_STACKS[$((selection-1))]}"
      break
    else
      echo -e "${RED}Invalid selection. Please enter a number between 1 and ${#AVAILABLE_STACKS[@]}${NC}"
    fi
  done
}

# Determine stack name
if [ -z "$1" ]; then
  # No argument provided, prompt user to select
  select_stack
else
  # Argument provided, validate it
  STACK_NAME="$1"
  
  # Check if provided stack name is valid
  valid_stack=false
  for stack in "${AVAILABLE_STACKS[@]}"; do
    if [ "$stack" == "$STACK_NAME" ]; then
      valid_stack=true
      break
    fi
  done
  
  if [ "$valid_stack" = false ]; then
    echo -e "${RED}Error: Invalid stack name '${STACK_NAME}'${NC}"
    echo -e "${YELLOW}Available stacks: ${AVAILABLE_STACKS[*]}${NC}"
    exit 1
  fi
fi

echo ""
echo -e "${BLUE}Fetching SSH key for ${STACK_NAME}...${NC}"

# Get the KeyPairName and KeyPairId from CloudFormation stack outputs
# Temporarily disable exit on error to handle AWS CLI failures gracefully
set +e
KEY_NAME=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`KeyPairName` || OutputKey==`SSHKeyPairName`].OutputValue' \
  --output text \
  --region ap-south-1 2>/dev/null)

KEY_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?OutputKey==`SSHKeyPairId` || OutputKey==`KeyPairId`].OutputValue' \
  --output text \
  --region ap-south-1 2>/dev/null)
set -e

if [ -z "$KEY_NAME" ]; then
  echo -e "${RED}Error: Could not find ${STACK_NAME} or key pair name output${NC}"
  echo -e "${YELLOW}Make sure the stack is deployed: cd infra && cdk deploy ${STACK_NAME}${NC}"
  exit 1
fi

# If KEY_ID is not in outputs, try to get it from EC2 API using the key name
if [ -z "$KEY_ID" ]; then
  echo -e "${YELLOW}SSHKeyPairId not in stack outputs, fetching from EC2 API...${NC}"
  KEY_ID=$(aws ec2 describe-key-pairs \
    --key-names "$KEY_NAME" \
    --region ap-south-1 \
    --query 'KeyPairs[0].KeyPairId' \
    --output text 2>/dev/null)
  
  if [ -z "$KEY_ID" ]; then
    echo -e "${RED}Error: Could not find key pair ID for ${KEY_NAME}${NC}"
    exit 1
  fi
fi

echo -e "${GREEN}Key pair name: ${KEY_NAME}${NC}"
echo -e "${GREEN}Key pair ID:   ${KEY_ID}${NC}"

# Get the SSM parameter name for the private key (uses key ID, not name)
PARAM_NAME="/ec2/keypair/${KEY_ID}"

# Create keys directory if it doesn't exist
KEY_PATH="${script_path%infra*}infra/keys"
echo "KEY_PATH: ${KEY_PATH}"
mkdir -p "$KEY_PATH"

# Fetch the private key from SSM Parameter Store
KEY_FILE="$KEY_PATH/${KEY_NAME}.pem"
echo -e "${BLUE}Downloading key to ${KEY_FILE}...${NC}"

# Remove existing file if it exists (it may have read-only permissions)
if [ -f "$KEY_FILE" ]; then
  rm -f "$KEY_FILE"
fi

aws ssm get-parameter \
  --name "$PARAM_NAME" \
  --with-decryption \
  --query 'Parameter.Value' \
  --output text \
  --region ap-south-1 > "$KEY_FILE"

# Set correct permissions
chmod 400 "$KEY_FILE"

echo -e "${GREEN}✓ SSH key downloaded successfully${NC}"
echo ""

# Get the public IP and instance ID (output keys may vary by stack)
set +e
PUBLIC_IP=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?contains(OutputKey, `PublicIP`) || contains(OutputKey, `PublicIp`)].OutputValue' \
  --output text \
  --region ap-south-1 2>/dev/null)

INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs[?contains(OutputKey, `InstanceId`)].OutputValue' \
  --output text \
  --region ap-south-1 2>/dev/null)
set -e

# All stacks use ec2-user (Amazon Linux 2023)
SSH_USER="ec2-user"

# Display stack-specific details and commands
if [ "$STACK_NAME" == "HapiStack" ]; then
  echo -e "${BLUE}Instance Details:${NC}"
  echo -e "  Stack Name:  ${GREEN}${STACK_NAME}${NC}"
  echo -e "  Instance ID: ${GREEN}${INSTANCE_ID}${NC}"
  echo -e "  Public IP:   ${GREEN}${PUBLIC_IP}${NC}"
  echo -e "  Key File:    ${GREEN}${KEY_FILE}${NC}"
  echo -e "  SSH User:    ${GREEN}${SSH_USER}${NC}"
  echo ""
  echo -e "${BLUE}SSH Command:${NC}"
  echo -e "  ${GREEN}ssh -i ${KEY_FILE} ${SSH_USER}@${PUBLIC_IP}${NC}"
  echo ""
  
  echo -e "${BLUE}Quick Log Monitoring Commands:${NC}"
  echo -e "  User data:     ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${PUBLIC_IP} 'sudo tail -f /var/log/user-data.log'${NC}"
  echo -e "  Maven build:   ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${PUBLIC_IP} 'sudo tail -f /var/log/hapi-build.log'${NC}"
  echo -e "  Health check:  ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${PUBLIC_IP} 'sudo tail -f /var/log/hapi-health-check.log'${NC}"
  echo -e "  HAPI service:  ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${PUBLIC_IP} 'sudo journalctl -u hapi-fhir -f'${NC}"

elif [ "$STACK_NAME" == "CouchbaseFhirVMStack" ]; then
  # Get both instance IPs
  COUCHBASE_IP=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`CouchbasePublicIP`].OutputValue' \
    --output text \
    --region ap-south-1 2>/dev/null)
  
  FHIR_SERVER_IP=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`FhirServerPublicIP`].OutputValue' \
    --output text \
    --region ap-south-1 2>/dev/null)
  
  COUCHBASE_INSTANCE_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`CouchbaseInstanceId`].OutputValue' \
    --output text \
    --region ap-south-1 2>/dev/null)
  
  FHIR_INSTANCE_ID=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`FhirServerInstanceId`].OutputValue' \
    --output text \
    --region ap-south-1 2>/dev/null)
  
  echo -e "${BLUE}=== Couchbase Instance ===${NC}"
  echo -e "  Instance ID: ${GREEN}${COUCHBASE_INSTANCE_ID}${NC}"
  echo -e "  Public IP:   ${GREEN}${COUCHBASE_IP}${NC}"
  echo -e "  SSH:         ${GREEN}ssh -i ${KEY_FILE} ${SSH_USER}@${COUCHBASE_IP}${NC}"
  echo ""
  
  echo -e "${BLUE}=== FHIR Server Instance ===${NC}"
  echo -e "  Instance ID: ${GREEN}${FHIR_INSTANCE_ID}${NC}"
  echo -e "  Public IP:   ${GREEN}${FHIR_SERVER_IP}${NC}"
  echo -e "  SSH:         ${GREEN}ssh -i ${KEY_FILE} ${SSH_USER}@${FHIR_SERVER_IP}${NC}"
  echo ""
  
  echo -e "${BLUE}Key File:${NC}"
  echo -e "  ${GREEN}${KEY_FILE}${NC}"
  echo ""
  
  echo -e "${BLUE}Quick Log Monitoring - Couchbase:${NC}"
  echo -e "  User data:      ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${COUCHBASE_IP} 'sudo tail -f /var/log/user-data.log'${NC}"
  echo -e "  Health check:   ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${COUCHBASE_IP} 'sudo tail -f /var/log/couchbase-health.log'${NC}"
  echo -e "  Couchbase logs: ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${COUCHBASE_IP} 'sudo tail -f /opt/couchbase/var/lib/couchbase/logs/couchbase.log'${NC}"
  echo ""
  
  echo -e "${BLUE}Quick Log Monitoring - FHIR Server:${NC}"
  echo -e "  User data:      ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${FHIR_SERVER_IP} 'sudo tail -f /var/log/user-data.log'${NC}"
  echo -e "  Build log:      ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${FHIR_SERVER_IP} 'sudo tail -f /var/log/fhir-build.log'${NC}"
  echo -e "  Server log:     ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${FHIR_SERVER_IP} 'sudo tail -f /var/log/fhir-server.log'${NC}"
  echo -e "  Health check:   ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${FHIR_SERVER_IP} 'sudo tail -f /var/log/fhir-health.log'${NC}"
  echo -e "  FHIR service:   ${YELLOW}ssh -i ${KEY_FILE} ${SSH_USER}@${FHIR_SERVER_IP} 'sudo journalctl -u fhir-server -f'${NC}"
else
  echo -e "${BLUE}Instance Details:${NC}"
  echo -e "  Stack Name:  ${GREEN}${STACK_NAME}${NC}"
  echo -e "  Instance ID: ${GREEN}${INSTANCE_ID}${NC}"
  echo -e "  Public IP:   ${GREEN}${PUBLIC_IP}${NC}"
  echo -e "  Key File:    ${GREEN}${KEY_FILE}${NC}"
  echo -e "  SSH User:    ${GREEN}${SSH_USER}${NC}"
  echo ""
  echo -e "${BLUE}SSH Command:${NC}"
  echo -e "  ${GREEN}ssh -i ${KEY_FILE} ${SSH_USER}@${PUBLIC_IP}${NC}"
  echo ""
fi