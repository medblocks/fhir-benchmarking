#!/bin/bash

# Automated HAPI + Locust deployment script
# This script:
# 1. Deploys HAPI FHIR stack with 3 VMs (HAPI, PostgreSQL, Locust)
# 2. Waits for HAPI to be ready
# 3. Fetches SSH key for Locust access
# 4. Displays connection information
#
# Usage: ./scripts/hapi-locust.sh

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   HAPI FHIR Load Testing Stack Deployment${NC}"
echo -e "${BLUE}   (HAPI + PostgreSQL = 2 VMs)${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Confirm execution
echo -e "${YELLOW}Deploy the stack? (y/N)${NC}"
read -r CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  echo "Deployment cancelled"
  exit 0
fi

# ============================================================================
# STEP 1: Deploy HAPI Stack (includes all 3 VMs)
# ============================================================================
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}STEP 1: Deploying HAPI Stack (3 VMs)${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

cd "$(dirname "$0")/.."

# Create results directory for storing outputs
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_FILE="/tmp/hapi-stack-${TIMESTAMP}.json"

# Build TypeScript
echo -e "${BLUE}Building CDK stack...${NC}"
npm run build

# Check if HapiStack already exists
echo -e "${BLUE}Checking for existing HapiStack...${NC}"
STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name HapiStack \
  --query 'Stacks[0].StackStatus' \
  --output text \
  --region ap-south-1 2>/dev/null || echo "NOT_FOUND")

if [ "$STACK_STATUS" = "CREATE_COMPLETE" ] || [ "$STACK_STATUS" = "UPDATE_COMPLETE" ]; then
  echo -e "${GREEN}✓ HapiStack already exists and is ready${NC}"
  
  # Extract outputs from existing stack
  aws cloudformation describe-stacks \
    --stack-name HapiStack \
    --region ap-south-1 \
    --output json > "${OUTPUT_FILE}"
else
  # Deploy HAPI stack (includes HAPI, PostgreSQL, and Locust)
  echo -e "${BLUE}Deploying HapiStack...${NC}"
  npx cdk deploy HapiStack --app "npx ts-node --prefer-ts-exts bin/infra.ts" --require-approval never --outputs-file "${OUTPUT_FILE}" --verbose
fi

# Parse outputs
echo -e "${BLUE}Extracting stack outputs...${NC}"
HAPI_PUBLIC_IP=$(jq -r '.HapiStack.HapiPublicIP' "${OUTPUT_FILE}")
POSTGRES_PRIVATE_IP=$(jq -r '.HapiStack.PostgresPrivateIP' "${OUTPUT_FILE}")
HAPI_INSTANCE_ID=$(jq -r '.HapiStack.HapiInstanceId' "${OUTPUT_FILE}")
LOCUST_PUBLIC_IP=$(jq -r '.HapiStack.LocustPublicIP' "${OUTPUT_FILE}")
LOCUST_INSTANCE_ID=$(jq -r '.HapiStack.LocustInstanceId' "${OUTPUT_FILE}")
TARGET_HOST=$(jq -r '.HapiStack.TargetHost' "${OUTPUT_FILE}")

# Get instance type from EC2
INSTANCE_TYPE=$(aws ec2 describe-instances \
  --filters "Name=tag:InstanceId,Values=${HAPI_INSTANCE_ID}" "Name=instance-state-name,Values=running" \
  --query 'Reservations[0].Instances[0].InstanceType' \
  --output text \
  --region ap-south-1)

echo ""
echo -e "${GREEN}✓ Stack deployed successfully${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"
echo -e "  ${BLUE}HAPI FHIR Server${NC}"
echo -e "    Public IP: ${GREEN}${HAPI_PUBLIC_IP}${NC}"
echo -e "    Instance ID: ${HAPI_INSTANCE_ID}"
echo -e "    Instance Type: ${INSTANCE_TYPE}"
echo -e ""
echo -e "  ${BLUE}PostgreSQL Server${NC}"
echo -e "    Private IP: ${GREEN}${POSTGRES_PRIVATE_IP}${NC}"
echo -e "    Instance Type: ${INSTANCE_TYPE}"
echo -e ""
echo -e "  ${BLUE}Locust Load Tester${NC}"
echo -e "    Public IP: ${GREEN}${LOCUST_PUBLIC_IP}${NC}"
echo -e "    Instance ID: ${LOCUST_INSTANCE_ID}"
echo -e "    Instance Type: t3a.xlarge"
echo -e "${GREEN}═══════════════════════════════════════════════════════════${NC}"

# ============================================================================
# STEP 2: Wait for HAPI to be ready
# ============================================================================
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}STEP 2: Waiting for HAPI FHIR to be ready${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

HAPI_ENDPOINT="http://${HAPI_PUBLIC_IP}:8080/fhir"
MAX_WAIT=900  # 15 minutes
WAIT_COUNT=0

echo -e "${YELLOW}Waiting for HAPI FHIR at ${HAPI_ENDPOINT}/metadata${NC}"
echo -e "${YELLOW}This may take up to 15 minutes for initial build and startup...${NC}"
echo ""

while [ $WAIT_COUNT -lt $MAX_WAIT ]; do
  if curl -f -s "${HAPI_ENDPOINT}/metadata" > /dev/null 2>&1; then
    echo -e "${GREEN}✓ HAPI FHIR is ready and responding!${NC}"
    break
  else
    ELAPSED=$((WAIT_COUNT * 10))
    echo -ne "\r${YELLOW}  Waiting... ${ELAPSED}s elapsed (checking every 10s)${NC}"
    sleep 10
    WAIT_COUNT=$((WAIT_COUNT + 1))
  fi
done

echo ""

if [ $WAIT_COUNT -eq $MAX_WAIT ]; then
  echo -e "${RED}✗ HAPI FHIR failed to start within ${MAX_WAIT} seconds${NC}"
  echo -e "${YELLOW}Check CloudWatch logs for details${NC}"
  exit 1
fi

# Quick health check
echo -e "${BLUE}Verifying HAPI FHIR health...${NC}"
curl -s "${HAPI_ENDPOINT}/metadata" | head -5
echo ""

# ============================================================================
# STEP 3: Fetch SSH Key
# ============================================================================
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}STEP 3: Fetching SSH Key${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Get SSH key
echo -e "${BLUE}Downloading SSH key...${NC}"
if ./scripts/get-ssh-key.sh HapiStack; then
  KEY_FILE="keys/hapi-loadtest-key.pem"
  echo -e "${GREEN}✓ SSH key downloaded: ${KEY_FILE}${NC}"
else
  echo -e "${YELLOW}Note: Run './scripts/get-ssh-key.sh' if key download failed${NC}"
  KEY_FILE="keys/hapi-loadtest-key.pem"
fi

# ============================================================================
# STEP 4: Copy Test Files and FHIR Resources to Locust Instance
# ============================================================================
echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BLUE}STEP 4: Copying Test Files to Locust Instance${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Wait for Locust instance to be ready for SSH
echo -e "${YELLOW}Waiting for Locust instance to accept SSH connections...${NC}"
MAX_SSH_WAIT=180  # 3 minutes
SSH_WAIT_COUNT=0

while [ $SSH_WAIT_COUNT -lt $MAX_SSH_WAIT ]; do
  if ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no -o ConnectTimeout=5 -o BatchMode=yes ec2-user@${LOCUST_PUBLIC_IP} 'exit' 2>/dev/null; then
    echo -e "${GREEN}✓ Locust instance is ready for SSH${NC}"
    break
  else
    ELAPSED=$((SSH_WAIT_COUNT * 5))
    echo -ne "\r${YELLOW}  Waiting... ${ELAPSED}s elapsed (checking every 5s)${NC}"
    sleep 5
    SSH_WAIT_COUNT=$((SSH_WAIT_COUNT + 1))
  fi
done

echo ""

if [ $SSH_WAIT_COUNT -eq $MAX_SSH_WAIT ]; then
  echo -e "${RED}✗ Locust instance failed to accept SSH connections${NC}"
  echo -e "${YELLOW}You will need to copy files manually (see instructions below)${NC}"
else
  # Copy tests directory
  echo -e "${BLUE}Copying tests directory...${NC}"
  if scp -i "${KEY_FILE}" -o StrictHostKeyChecking=no -r ../tests ec2-user@${LOCUST_PUBLIC_IP}:~/ 2>&1 | grep -v "Warning:"; then
    echo -e "${GREEN}✓ Tests directory copied${NC}"
  else
    echo -e "${YELLOW}⚠ Failed to copy tests directory${NC}"
  fi
  
  # Copy FHIR directory
  echo -e "${BLUE}Copying FHIR directory...${NC}"
  if scp -i "${KEY_FILE}" -o StrictHostKeyChecking=no -r ../fhir ec2-user@${LOCUST_PUBLIC_IP}:~/ 2>&1 | grep -v "Warning:"; then
    echo -e "${GREEN}✓ FHIR directory copied${NC}"
  else
    echo -e "${YELLOW}⚠ Failed to copy FHIR directory${NC}"
  fi
  
  # Install Python dependencies
  echo -e "${BLUE}Installing Python dependencies on Locust instance...${NC}"
  ssh -i "${KEY_FILE}" -o StrictHostKeyChecking=no ec2-user@${LOCUST_PUBLIC_IP} << 'EOSSH'
cd ~/tests
~/.local/bin/uv venv --python 3.13 .venv
source .venv/bin/activate
~/.local/bin/uv pip install --python .venv/bin/python -r requirements.txt
EOSSH
  
  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Python dependencies installed${NC}"
  else
    echo -e "${YELLOW}⚠ Failed to install dependencies - you may need to do this manually${NC}"
  fi
fi

# ============================================================================
# Summary
# ============================================================================
echo ""
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Deployment Complete!${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}HAPI FHIR Endpoint:${NC}"
echo -e "  ${YELLOW}${HAPI_ENDPOINT}${NC}"
echo -e "  ${YELLOW}${HAPI_ENDPOINT}/metadata${NC} (health check)"
echo ""
echo -e "${BLUE}SSH to Locust VM:${NC}"
echo -e "  ${YELLOW}ssh -i ${KEY_FILE} ec2-user@${LOCUST_PUBLIC_IP}${NC}"
echo ""
echo -e "${BLUE}View Test Instructions (on Locust VM):${NC}"
echo -e "  ${YELLOW}cat ~/INSTRUCTIONS.txt${NC}"
echo ""
echo -e "${BLUE}Run Load Test Example (on Locust VM):${NC}"
echo -e "  ${YELLOW}cd ~/tests${NC}"
echo -e "  ${YELLOW}source .venv/bin/activate${NC}"
echo -e "  ${YELLOW}export TARGET_HOST=${TARGET_HOST}${NC}"
echo -e "  ${YELLOW}locust --host=$TARGET_HOST --users=50 --spawn-rate=5 --run-time=300s --headless --html=~/results/report.html --csv=~/results/stats${NC}"
echo ""
echo -e "${BLUE}Download Results (from local machine):${NC}"
echo -e "  ${YELLOW}scp -i ${KEY_FILE} ec2-user@${LOCUST_PUBLIC_IP}:~/results/*.csv .${NC}"
echo -e "  ${YELLOW}scp -i ${KEY_FILE} ec2-user@${LOCUST_PUBLIC_IP}:~/results/*.html .${NC}"
echo ""
echo -e "${BLUE}Manual Setup (if auto-copy failed):${NC}"
echo -e "  Copy tests:  ${YELLOW}scp -i ${KEY_FILE} -r ../tests ec2-user@${LOCUST_PUBLIC_IP}:~/${NC}"
echo -e "  Copy FHIR:   ${YELLOW}scp -i ${KEY_FILE} -r ../fhir ec2-user@${LOCUST_PUBLIC_IP}:~/${NC}"
echo -e "  Install deps: ${YELLOW}ssh -i ${KEY_FILE} ec2-user@${LOCUST_PUBLIC_IP} 'cd ~/tests && ~/.local/bin/uv venv --python 3.13 .venv && source .venv/bin/activate && ~/.local/bin/uv pip install --python .venv/bin/python -r requirements.txt'${NC}"
echo ""
echo -e "${BLUE}Download CloudWatch Metrics (after testing):${NC}"
echo -e "  ${YELLOW}./scripts/download-metrics.sh${NC}"
echo ""
echo -e "${BLUE}Cleanup (destroy stack):${NC}"
echo -e "  ${YELLOW}cdk destroy HapiStack --force${NC}"
echo ""
