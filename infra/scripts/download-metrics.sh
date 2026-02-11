#!/bin/bash

# Download CloudWatch metrics for HAPI and PostgreSQL instances
# This script downloads system metrics from CloudWatch and saves them to results folder
#
# Usage: ./scripts/download-metrics.sh [start_time] [end_time] [output_dir]
#   start_time: ISO 8601 timestamp, epoch seconds, or relative time (e.g., "2 hours ago")
#   end_time: ISO 8601 timestamp, epoch seconds, or "now" (default: now)
#   output_dir: Directory to save results (default: results/metrics-YYYYMMDD-HHMMSS)

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}   CloudWatch Metrics Download Script${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""

# Change to repo root
cd "$(dirname "$0")/.."

# Ensure stack exists
echo -e "${BLUE}Checking for HapiStack...${NC}"
STACK_STATUS=$(aws cloudformation describe-stacks \
  --stack-name HapiStack \
  --query 'Stacks[0].StackStatus' \
  --output text \
  --region ap-south-1 2>/dev/null || echo "NOT_FOUND")

if [ "$STACK_STATUS" = "NOT_FOUND" ]; then
  echo -e "${RED}✗ HapiStack not found${NC}"
  echo -e "${YELLOW}Please deploy HapiStack first: cdk deploy HapiStack${NC}"
  exit 1
fi

echo -e "${GREEN}✓ HapiStack found${NC}"
echo ""

echo -e "${BLUE}Fetching stack information...${NC}"
aws cloudformation describe-stacks \
  --stack-name HapiStack \
  --region ap-south-1 \
  --output json > /tmp/hapi-stack.json

HAPI_INSTANCE_ID=$(jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="HapiInstanceId") | .OutputValue' /tmp/hapi-stack.json)
POSTGRES_INSTANCE_ID=$(jq -r '.Stacks[0].Outputs[] | select(.OutputKey=="PostgresInstanceId") | .OutputValue' /tmp/hapi-stack.json)
STACK_CREATION_TIME=$(jq -r '.Stacks[0].CreationTime' /tmp/hapi-stack.json)

if [ -z "$HAPI_INSTANCE_ID" ] || [ -z "$POSTGRES_INSTANCE_ID" ]; then
  echo -e "${RED}✗ Unable to read instance IDs from stack outputs${NC}"
  exit 1
fi

HAPI_INSTANCE_TYPE=$(aws ec2 describe-instances \
  --filters "Name=instance-id,Values=${HAPI_INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].InstanceType' \
  --output text \
  --region ap-south-1)

POSTGRES_INSTANCE_TYPE=$(aws ec2 describe-instances \
  --filters "Name=instance-id,Values=${POSTGRES_INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].InstanceType' \
  --output text \
  --region ap-south-1)

echo -e "${GREEN}✓ Found instances${NC}"
echo -e "  HAPI: ${BLUE}${HAPI_INSTANCE_ID}${NC} (${HAPI_INSTANCE_TYPE})"
echo -e "  PostgreSQL: ${BLUE}${POSTGRES_INSTANCE_ID}${NC} (${POSTGRES_INSTANCE_TYPE})"
echo ""

# Parse time arguments
END_TIME=$(date -u +%s)
START_TIME=$((END_TIME - 3600)) # default: last hour

if [ -n "${1:-}" ]; then
  INPUT="$1"
  if [[ "$INPUT" =~ ^[0-9]+$ ]]; then
    START_TIME=$INPUT
  else
    START_TIME=$(date -u -d "$INPUT" +%s 2>/dev/null || true)
  fi
  if [ -z "$START_TIME" ]; then
    echo -e "${RED}✗ Invalid start time format: $1${NC}"
    exit 1
  fi
fi

if [ -n "${2:-}" ]; then
  INPUT="$2"
  if [ "$INPUT" = "now" ]; then
    END_TIME=$(date -u +%s)
  elif [[ "$INPUT" =~ ^[0-9]+$ ]]; then
    END_TIME=$INPUT
  else
    END_TIME=$(date -u -d "$INPUT" +%s 2>/dev/null || true)
  fi
  if [ -z "$END_TIME" ]; then
    echo -e "${RED}✗ Invalid end time format: $2${NC}"
    exit 1
  fi
fi

if [ "$END_TIME" -le "$START_TIME" ]; then
  echo -e "${RED}✗ End time must be after start time${NC}"
  exit 1
fi

START_ISO=$(date -u -d @${START_TIME} +%Y-%m-%dT%H:%M:%S)
END_ISO=$(date -u -d @${END_TIME} +%Y-%m-%dT%H:%M:%S)

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTPUT_DIR=${3:-results/metrics-${TIMESTAMP}}
mkdir -p "${OUTPUT_DIR}/hapi" "${OUTPUT_DIR}/postgres"

echo -e "${BLUE}Time Range:${NC}"
echo -e "  Start: ${YELLOW}${START_ISO}Z${NC}"
echo -e "  End:   ${YELLOW}${END_ISO}Z${NC}"
echo -e "  Duration: ${YELLOW}$(( (END_TIME - START_TIME) / 60 )) minutes${NC}"
echo ""

echo -e "${BLUE}Output Directory:${NC}"
echo -e "  ${GREEN}${OUTPUT_DIR}${NC}"
echo ""

# Metrics organized by their dimension requirements
CPU_METRICS=(
  "CPU_IDLE:cpu=cpu-total"
  "CPU_ACTIVE:cpu=cpu-total"
  "CPU_IOWAIT:cpu=cpu-total"
  "CPU_SYSTEM:cpu=cpu-total"
  "CPU_USER:cpu=cpu-total"
)

MEM_METRICS=(
  "MEM_USED_PERCENT:"
  "MEM_AVAILABLE:"
  "MEM_USED:"
  "MEM_TOTAL:"
)

DISK_METRICS=(
  "DISK_USED:path=/,device=nvme0n1p1,fstype=xfs"
  "DISK_INODES_FREE:path=/,device=nvme0n1p1,fstype=xfs"
)

DISKIO_METRICS=(
  "DISKIO_TIME:name=nvme0n1"
  "DISKIO_READ_BYTES:name=nvme0n1"
  "DISKIO_WRITE_BYTES:name=nvme0n1"
  "DISKIO_READS:name=nvme0n1"
  "DISKIO_WRITES:name=nvme0n1"
)

NET_METRICS=(
  "NET_BYTES_SENT:interface=ens5"
  "NET_BYTES_RECEIVED:interface=ens5"
  "NET_PACKETS_SENT:interface=ens5"
  "NET_PACKETS_RECEIVED:interface=ens5"
)

NETSTAT_METRICS=(
  "netstat_tcp_established:"
  "netstat_tcp_time_wait:"
)

download_metric() {
  local output_subdir=$1
  local metric_spec=$2
  local service=$3
  
  # Parse metric name and dimensions
  local metric_name="${metric_spec%%:*}"
  local dimensions="${metric_spec#*:}"
  local output_path="${OUTPUT_DIR}/${output_subdir}/${metric_name}"
  
  # Build dimensions argument
  local dim_args=""
  if [ -n "$dimensions" ]; then
    # Parse comma-separated dimensions
    IFS=',' read -ra DIM_ARRAY <<< "$dimensions"
    for dim in "${DIM_ARRAY[@]}"; do
      local dim_name="${dim%%=*}"
      local dim_value="${dim#*=}"
      dim_args+=" Name=${dim_name},Value=${dim_value}"
    done
  fi
  
  # Download metric
  if [ -n "$dim_args" ]; then
    aws cloudwatch get-metric-statistics \
      --namespace HapiLoadTest \
      --metric-name "${metric_name}" \
      --dimensions $dim_args \
      --start-time "${START_ISO}" \
      --end-time "${END_ISO}" \
      --period 60 \
      --statistics Sum,Average,Maximum,Minimum \
      --region ap-south-1 \
      --output json > "${output_path}.json" 2>/dev/null || true
  else
    aws cloudwatch get-metric-statistics \
      --namespace HapiLoadTest \
      --metric-name "${metric_name}" \
      --start-time "${START_ISO}" \
      --end-time "${END_ISO}" \
      --period 60 \
      --statistics Sum,Average,Maximum,Minimum \
      --region ap-south-1 \
      --output json > "${output_path}.json" 2>/dev/null || true
  fi

  if [ -f "${output_path}.json" ] && [ -s "${output_path}.json" ]; then
    local datapoint_count=$(jq '.Datapoints | length' "${output_path}.json" 2>/dev/null || echo "0")
    if [ "$datapoint_count" -gt 0 ]; then
      echo "Timestamp,Sum,Average,Maximum,Minimum" > "${output_path}.csv"
      jq -r '.Datapoints | sort_by(.Timestamp) | .[] | [.Timestamp, (.Sum // ""), (.Average // ""), (.Maximum // ""), (.Minimum // "")] | @csv' \
        "${output_path}.json" >> "${output_path}.csv" 2>/dev/null || true
    fi
  fi
}

echo -e "${BLUE}Downloading CloudWatch metrics for HAPI instance...${NC}"
echo -e "${YELLOW}  CPU metrics...${NC}"
for metric in "${CPU_METRICS[@]}"; do
  download_metric "hapi" "$metric" "HAPI-FHIR"
done
echo -e "${YELLOW}  Memory metrics...${NC}"
for metric in "${MEM_METRICS[@]}"; do
  download_metric "hapi" "$metric" "HAPI-FHIR"
done
echo -e "${YELLOW}  Disk metrics...${NC}"
for metric in "${DISK_METRICS[@]}"; do
  download_metric "hapi" "$metric" "HAPI-FHIR"
done
echo -e "${YELLOW}  Disk I/O metrics...${NC}"
for metric in "${DISKIO_METRICS[@]}"; do
  download_metric "hapi" "$metric" "HAPI-FHIR"
done
echo -e "${YELLOW}  Network metrics...${NC}"
for metric in "${NET_METRICS[@]}"; do
  download_metric "hapi" "$metric" "HAPI-FHIR"
done
echo -e "${YELLOW}  Network stats metrics...${NC}"
for metric in "${NETSTAT_METRICS[@]}"; do
  download_metric "hapi" "$metric" "HAPI-FHIR"
done
echo -e "${GREEN}✓ HAPI metrics downloaded${NC}"

echo -e "${BLUE}Downloading CloudWatch metrics for PostgreSQL instance...${NC}"
echo -e "${YELLOW}  CPU metrics...${NC}"
for metric in "${CPU_METRICS[@]}"; do
  download_metric "postgres" "$metric" "PostgreSQL"
done
echo -e "${YELLOW}  Memory metrics...${NC}"
for metric in "${MEM_METRICS[@]}"; do
  download_metric "postgres" "$metric" "PostgreSQL"
done
echo -e "${YELLOW}  Disk metrics...${NC}"
for metric in "${DISK_METRICS[@]}"; do
  download_metric "postgres" "$metric" "PostgreSQL"
done
echo -e "${YELLOW}  Disk I/O metrics...${NC}"
for metric in "${DISKIO_METRICS[@]}"; do
  download_metric "postgres" "$metric" "PostgreSQL"
done
echo -e "${YELLOW}  Network metrics...${NC}"
for metric in "${NET_METRICS[@]}"; do
  download_metric "postgres" "$metric" "PostgreSQL"
done
echo -e "${YELLOW}  Network stats metrics...${NC}"
for metric in "${NETSTAT_METRICS[@]}"; do
  download_metric "postgres" "$metric" "PostgreSQL"
done
echo -e "${GREEN}✓ PostgreSQL metrics downloaded${NC}"

cat > "${OUTPUT_DIR}/metadata.json" <<EOF
{
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "start_time": "${START_ISO}Z",
  "end_time": "${END_ISO}Z",
  "duration_seconds": $((END_TIME - START_TIME)),
  "hapi_instance_id": "${HAPI_INSTANCE_ID}",
  "hapi_instance_type": "${HAPI_INSTANCE_TYPE}",
  "postgres_instance_id": "${POSTGRES_INSTANCE_ID}",
  "postgres_instance_type": "${POSTGRES_INSTANCE_TYPE}",
  "stack_creation_time": "${STACK_CREATION_TIME}"
}
EOF

echo ""
echo -e "${GREEN}✓ Metrics downloaded successfully${NC}"
echo ""

echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}   Metrics Download Complete${NC}"
echo -e "${BLUE}═══════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "${BLUE}Results Location:${NC}"
echo -e "  ${GREEN}${OUTPUT_DIR}${NC}"
echo ""
echo -e "${BLUE}Files Downloaded:${NC}"
echo -e "  HAPI metrics:     ${YELLOW}$(find "${OUTPUT_DIR}/hapi" -name '*.csv' | wc -l)${NC} files"
echo -e "  PostgreSQL metrics:${YELLOW}$(find "${OUTPUT_DIR}/postgres" -name '*.csv' | wc -l)${NC} files"
echo ""
echo -e "${BLUE}View Metadata:${NC}"
echo -e "  ${YELLOW}cat ${OUTPUT_DIR}/metadata.json${NC}"
echo ""
echo -e "${BLUE}Analyze Metrics (Python example):${NC}"
echo -e "  ${YELLOW}import pandas as pd${NC}"
echo -e "  ${YELLOW}hapi_cpu = pd.read_csv('${OUTPUT_DIR}/hapi/CPU_IDLE.csv')${NC}"
echo -e "  ${YELLOW}pg_disk = pd.read_csv('${OUTPUT_DIR}/postgres/DISKIO_WRITE_BYTES.csv')${NC}"
echo ""
