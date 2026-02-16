#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENCLAW_PORT:-3321}"
BASE_URL="${OPENCLAW_BASE_URL:-http://127.0.0.1:${PORT}}"

echo "== OpenClaw Health Check =="
echo "BASE_URL=${BASE_URL}"

echo
echo "-- Listener --"
ss -ltnp | grep ":${PORT}" || {
  echo "No listener found on :${PORT}" >&2
  exit 1
}

echo
echo "-- Endpoints --"
curl -fsS --max-time 8 "${BASE_URL}/health" | jq .
curl -fsS --max-time 8 "${BASE_URL}/discovery" | jq '{identityKey,endpoints,capabilities,paidCapabilitiesCount:(.paidCapabilities|length)}'

echo
echo "OpenClaw check passed."
