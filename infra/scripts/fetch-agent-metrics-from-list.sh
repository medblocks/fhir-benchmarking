#!/usr/bin/env bash

# Fetch all CloudWatch metrics listed in a list-metrics.json file for a given time window
# - Supports HapiLoadTest (CloudWatch Agent) namespace metrics with various dimensions
# - Converts IST inputs to UTC and queries at 60s resolution (max for agent config)
#
# Usage:
#   ./infra/scripts/fetch-agent-metrics-from-list.sh \
#       --start-ist '2025-11-15 19:50' \
#       --end-ist   '2025-11-15 20:30' \
#       [--namespace HapiLoadTest] \
#       [--region ap-south-1] \
#       [--list-file list-metrics.json] \
#       [--out-dir results/hapi-agent-metrics-<auto>]
#
# Notes:
# - Start/End are interpreted as IST wall-clock then converted to UTC for CloudWatch.
# - If list-metrics.json is missing, generate it via:
    aws cloudwatch list-metrics --region ap-south-1 --namespace HapiLoadTest \
      --query 'Metrics[].{Name:MetricName,Dims:Dimensions}' --output json > list-metrics.json

set -euo pipefail

REGION=${REGION:-ap-south-1}
NAMESPACE=${NAMESPACE:-HapiLoadTest}
LIST_FILE=${LIST_FILE:-list-metrics.json}
OUT_DIR=""
START_IST=""
END_IST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --list-file) LIST_FILE="$2"; shift 2 ;;
    --out-dir) OUT_DIR="$2"; shift 2 ;;
    --start-ist) START_IST="$2"; shift 2 ;;
    --end-ist) END_IST="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$START_IST" || -z "$END_IST" ]]; then
  echo "Missing required --start-ist and/or --end-ist" >&2
  exit 1
fi

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI not found in PATH" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required; please install jq" >&2
  exit 1
fi

if [[ ! -f "$LIST_FILE" ]]; then
  echo "List file not found: $LIST_FILE" >&2
  exit 1
fi

# Convert IST to UTC by parsing with +0530 offset
to_utc() {
  local ist="$1"
  date -u -d "$ist +0530" +%Y-%m-%dT%H:%M:%S
}

START_UTC=$(to_utc "$START_IST")
END_UTC=$(to_utc   "$END_IST")

if [[ -z "$OUT_DIR" ]]; then
  STAMP=$(date +%Y%m%d-%H%M%S)
  OUT_DIR="results/agent-metrics-${STAMP}"
fi

mkdir -p "$OUT_DIR/json" "$OUT_DIR/csv"

echo "Namespace : $NAMESPACE"
echo "Region    : $REGION"
echo "List file : $LIST_FILE"
echo "UTC window: ${START_UTC}Z -> ${END_UTC}Z"
echo "Output dir: $OUT_DIR"

sanitize() {
  # Replace unsafe filename chars with underscores
  echo -n "$1" | sed 's#[/ ]#_#g; s#[^A-Za-z0-9._=:-]#_#g'
}

fetch_one() {
  local name="$1"
  local dims_json="$2"

  # Build dimensions CLI arguments exactly as listed
  local dim_args=()
  if [[ -n "$dims_json" && "$dims_json" != "null" && "$dims_json" != "[]" ]]; then
    # shellcheck disable=SC2207
    local entries=( $(echo "$dims_json" | jq -r '.[] | @base64') )
    for e in "${entries[@]}"; do
      local dn dv
      dn=$(echo "$e" | base64 -d | jq -r '.Name')
      dv=$(echo "$e" | base64 -d | jq -r '.Value')
      dim_args+=("Name=${dn},Value=${dv}")
    done
  fi

  local safe_dims
  safe_dims=$(echo -n "$dims_json" | tr -d '\n' | sed 's/\s//g' | sed 's/\[/(/; s/\]/)/; s/},{/_/g; s/[{}\"]//g; s/:/=/g; s/,/_/g')
  [[ -z "$safe_dims" ]] && safe_dims="nodims"

  local base
  base=$(sanitize "${name}__${safe_dims}")
  local json_out="$OUT_DIR/json/${base}.json"
  local csv_out="$OUT_DIR/csv/${base}.csv"

  if [[ ${#dim_args[@]} -gt 0 ]]; then
    aws cloudwatch get-metric-statistics \
      --namespace "$NAMESPACE" \
      --metric-name "$name" \
      --dimensions ${dim_args[@]} \
      --start-time "${START_UTC}Z" \
      --end-time "${END_UTC}Z" \
      --period 60 \
      --statistics Average Minimum Maximum Sum SampleCount \
      --region "$REGION" \
      --output json > "$json_out" || true
  else
    aws cloudwatch get-metric-statistics \
      --namespace "$NAMESPACE" \
      --metric-name "$name" \
      --start-time "${START_UTC}Z" \
      --end-time "${END_UTC}Z" \
      --period 60 \
      --statistics Average Minimum Maximum Sum SampleCount \
      --region "$REGION" \
      --output json > "$json_out" || true
  fi

  echo "Timestamp,Average,Minimum,Maximum,Sum,SampleCount" > "$csv_out"
  jq -r '.Datapoints | sort_by(.Timestamp) | .[] | [ .Timestamp, (.Average // null), (.Minimum // null), (.Maximum // null), (.Sum // null), (.SampleCount // null) ] | @csv' \
    "$json_out" >> "$csv_out" || true
}

TOTAL=$(jq 'length' "$LIST_FILE")
echo "Metrics to fetch: $TOTAL"

idx=0
while IFS= read -r line; do
  name=$(echo "$line" | jq -r '.Name')
  dims=$(echo "$line" | jq -c '.Dims')
  idx=$((idx+1))
  printf '[%04d/%04d] %s\n' "$idx" "$TOTAL" "$name"
  fetch_one "$name" "$dims"
done < <(jq -c '.[]' "$LIST_FILE")

CSV_CNT=$(find "$OUT_DIR/csv" -name '*.csv' | wc -l | tr -d ' ')
echo "Done. CSV files: $CSV_CNT"
echo "Output dir: $OUT_DIR"
