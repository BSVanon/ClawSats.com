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

expect_any_status() {
  local path="$1"
  shift
  local allowed=("$@")
  local code
  code="$(curl -sS -o /tmp/clawsats-smoke.json -w '%{http_code}' "http://127.0.0.1:${PORT}${path}")"
  for ok in "${allowed[@]}"; do
    if [[ "${code}" == "${ok}" ]]; then
      return 0
    fi
  done
  echo "Smoke test failed: ${path} expected one of [${allowed[*]}], got ${code}."
  cat /tmp/clawsats-smoke.json || true
  exit 1
}

expect_status "/api/faucet/status" "200"
expect_status "/api/healthz" "200"
expect_status "/api/directory" "200"
expect_status "/api/network/seed-peers" "200"
expect_status "/api/scholarships/status" "200"
expect_status "/onboard" "200"
# Unfunded/missing wallet key can return 503; funded wallet should return 200 with address.
expect_any_status "/api/scholarships/address" "200" "503"

echo "Smoke test passed on port ${PORT}."
