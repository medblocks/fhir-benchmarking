#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Change to infra directory
cd "$(dirname "$0")/.."

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}HAPI FHIR Load Test Infrastructure Cleanup${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""

# Get stack outputs to identify resources
echo -e "${YELLOW}Fetching stack information...${NC}"
POSTGRES_ID=$(aws cloudformation describe-stacks --stack-name HapiStack --query "Stacks[0].Outputs[?OutputKey=='PostgresInstanceId'].OutputValue" --output text 2>/dev/null || echo "")
HAPI_ID=$(aws cloudformation describe-stacks --stack-name HapiStack --query "Stacks[0].Outputs[?OutputKey=='HapiInstanceId'].OutputValue" --output text 2>/dev/null || echo "")
KEY_PAIR_NAME=$(aws cloudformation describe-stacks --stack-name HapiStack --query "Stacks[0].Outputs[?OutputKey=='KeyPairName'].OutputValue" --output text 2>/dev/null || echo "")

if [ -z "$POSTGRES_ID" ] || [ -z "$HAPI_ID" ]; then
  echo -e "${YELLOW}Warning: Could not fetch stack outputs. Stack may not exist or may already be deleted.${NC}"
  POSTGRES_LOG_GROUP=""
  HAPI_LOG_GROUP=""
else
  POSTGRES_LOG_GROUP="/aws/ec2/${POSTGRES_ID}"
  HAPI_LOG_GROUP="/aws/ec2/${HAPI_ID}"
  
  echo -e "${YELLOW}Resources to be deleted:${NC}"
  echo -e "  - HapiStack CloudFormation stack"
  echo -e "  - PostgreSQL instance: ${POSTGRES_ID}"
  echo -e "  - HAPI FHIR instance: ${HAPI_ID}"
  echo -e "  - CloudWatch Log Group: ${POSTGRES_LOG_GROUP}"
  echo -e "  - CloudWatch Log Group: ${HAPI_LOG_GROUP}"
  if [ -n "$KEY_PAIR_NAME" ]; then
    echo -e "  - SSH Key Pair: ${KEY_PAIR_NAME}"
    if [ -f "keys/${KEY_PAIR_NAME}.pem" ]; then
      echo -e "  - Local key file: keys/${KEY_PAIR_NAME}.pem"
    fi
  fi
fi

echo ""
echo -e "${RED}⚠️  This will permanently delete all resources created by the HapiStack.${NC}"
echo -e "${YELLOW}This action cannot be undone!${NC}"
echo ""
read -p "Are you sure you want to continue? (yes/no): " -r
echo

if [[ ! $REPLY =~ ^[Yy][Ee][Ss]$ ]]; then
  echo -e "${GREEN}Cleanup cancelled.${NC}"
  exit 0
fi

echo ""
echo -e "${BLUE}Starting cleanup process...${NC}"
echo ""

# Destroy CDK stack
echo -e "${YELLOW}[1/3] Destroying CDK stack...${NC}"
if cdk destroy HapiStack --force; then
  echo -e "${GREEN}✓ CDK stack destroyed successfully${NC}"
else
  echo -e "${RED}✗ Failed to destroy CDK stack${NC}"
  echo -e "${YELLOW}Continuing with cleanup of other resources...${NC}"
fi

echo ""

# Delete CloudWatch log groups
echo -e "${YELLOW}[2/3] Deleting CloudWatch log groups...${NC}"

if [ -n "$POSTGRES_LOG_GROUP" ]; then
  if aws logs delete-log-group --log-group-name "$POSTGRES_LOG_GROUP" 2>/dev/null; then
    echo -e "${GREEN}✓ Deleted log group: ${POSTGRES_LOG_GROUP}${NC}"
  else
    echo -e "${YELLOW}⚠ Log group ${POSTGRES_LOG_GROUP} not found or already deleted${NC}"
  fi
fi

if [ -n "$HAPI_LOG_GROUP" ]; then
  if aws logs delete-log-group --log-group-name "$HAPI_LOG_GROUP" 2>/dev/null; then
    echo -e "${GREEN}✓ Deleted log group: ${HAPI_LOG_GROUP}${NC}"
  else
    echo -e "${YELLOW}⚠ Log group ${HAPI_LOG_GROUP} not found or already deleted${NC}"
  fi
fi

echo ""

# Delete SSH key files
echo -e "${YELLOW}[3/3] Cleaning up SSH key files...${NC}"

if [ -n "$KEY_PAIR_NAME" ]; then
  KEY_FILE="keys/${KEY_PAIR_NAME}.pem"
  if [ -f "$KEY_FILE" ]; then
    rm -f "$KEY_FILE"
    echo -e "${GREEN}✓ Deleted local key file: ${KEY_FILE}${NC}"
  else
    echo -e "${YELLOW}⚠ Key file ${KEY_FILE} not found or already deleted${NC}"
  fi
else
  # Try to find and delete any hapi-loadtest key files
  if ls keys/hapi-loadtest-*.pem 1> /dev/null 2>&1; then
    for keyfile in keys/hapi-loadtest-*.pem; do
      rm -f "$keyfile"
      echo -e "${GREEN}✓ Deleted local key file: ${keyfile}${NC}"
    done
  else
    echo -e "${YELLOW}⚠ No HAPI load test key files found${NC}"
  fi
fi

# Clean up empty keys directory if it exists
if [ -d "keys" ] && [ -z "$(ls -A keys)" ]; then
  rmdir keys
  echo -e "${GREEN}✓ Removed empty keys directory${NC}"
fi

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}Cleanup completed successfully!${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${BLUE}All ephemeral load testing resources have been removed.${NC}"
echo -e "${BLUE}You are no longer being charged for these resources.${NC}"
echo ""
