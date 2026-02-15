#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-43323}"
LOG_FILE="$(mktemp)"
PID=""

cleanup() {
  if [[ -n "${PID}" ]] && kill -0 "${PID}" 2>/dev/null; then
    kill "${PID}" >/dev/null 2>&1 || true
    wait "${PID}" 2>/dev/null || true
  fi
  rm -f "${LOG_FILE}"
}
trap cleanup EXIT

cd "${ROOT_DIR}"

FAUCET_PORT="${PORT}" node faucet-server.js >"${LOG_FILE}" 2>&1 &
PID="$!"

for _ in {1..30}; do
  if curl -fsS "http://127.0.0.1:${PORT}/api/faucet/status" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

if ! curl -fsS "http://127.0.0.1:${PORT}/api/faucet/status" >/dev/null 2>&1; then
  echo "Smoke test failed: server did not start on port ${PORT}."
  cat "${LOG_FILE}"
  exit 1
fi

expect_status() {
  local path="$1"
  local expected="$2"
  local code
  code="$(curl -sS -o /tmp/clawsats-smoke.json -w '%{http_code}' "http://127.0.0.1:${PORT}${path}")"
  if [[ "${code}" != "${expected}" ]]; then
    echo "Smoke test failed: ${path} expected HTTP ${expected}, got ${code}."
    cat /tmp/clawsats-smoke.json || true
    exit 1
  fi
}

expect_status "/api/faucet/status" "200"
expect_status "/api/directory" "200"
expect_status "/api/network/seed-peers" "200"
expect_status "/api/scholarships/status" "200"
expect_status "/api/scholarships/address" "503"

echo "Smoke test passed on port ${PORT}."
