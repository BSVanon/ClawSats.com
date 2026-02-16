#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3322}"
CLAW_ENDPOINT="${CLAW_ENDPOINT:-}"
REQUIRE_LIVE_API="${REQUIRE_LIVE_API:-0}"

echo "== ClawSats.com Production Preflight =="
echo "BASE_URL=${BASE_URL}"
echo "CLAW_ENDPOINT=${CLAW_ENDPOINT:-<none>}"
echo "REQUIRE_LIVE_API=${REQUIRE_LIVE_API}"

echo
echo "-- Runtime --"
node -v
npm -v

echo
echo "-- Static Checks --"
node --check faucet-server.js
node --check scripts/repair-scholarship-remittances.js

echo
echo "-- Local Smoke --"
npm run -s smoke

echo
echo "-- API Health --"
if curl -fsS "${BASE_URL}/api/healthz" >/tmp/clawsats-healthz.json 2>/dev/null; then
  cat /tmp/clawsats-healthz.json | jq .
  curl -fsS "${BASE_URL}/api/faucet/status" | jq '{walletReady,walletBackend,walletBalance,pendingClaims,claimed,remaining}'
  curl -fsS "${BASE_URL}/api/scholarships/status" | jq '{walletBalance,eligibleClaws,pendingInternalizations,totalDistributed,totalDistributions}'
  curl -fsS "${BASE_URL}/api/directory" | jq '{total,registered}'
else
  if [[ "${REQUIRE_LIVE_API}" == "1" ]]; then
    echo "Live API check failed at ${BASE_URL}. Start the service first." >&2
    exit 1
  fi
  echo "Live API not reachable at ${BASE_URL}; skipped live endpoint checks (set REQUIRE_LIVE_API=1 to enforce)."
fi

if [[ -n "${CLAW_ENDPOINT}" ]]; then
  echo
  echo "-- Remote Claw Reachability --"
  curl -fsS --max-time 10 "${CLAW_ENDPOINT%/}/health" | jq .
  curl -fsS --max-time 10 "${CLAW_ENDPOINT%/}/discovery" | jq '{identityKey,endpoints,capabilities}'
fi

echo
echo "Preflight passed."
