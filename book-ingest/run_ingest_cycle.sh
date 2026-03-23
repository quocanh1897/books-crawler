#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRON_DIR="${SCRIPT_DIR}/data/cron"
STATE_FILE="${CRON_DIR}/state.json"
CYCLE_LOG="${CRON_DIR}/cycle.log"
LOCK_DIR="${CRON_DIR}/ingest-cycle.lock"
LOCK_INFO_FILE="${LOCK_DIR}/owner.txt"

PYTHON_BIN="${PYTHON_BIN:-python3}"
INGEST_INTERVAL_SECONDS="${INGEST_INTERVAL_SECONDS:-36000}"
MTC_WORKERS="${MTC_WORKERS:-5}"
TTV_WORKERS="${TTV_WORKERS:-3}"
TF_WORKERS="${TF_WORKERS:-3}"
SOURCE_PAUSE_SECONDS="${SOURCE_PAUSE_SECONDS:-0}"
INGEST_EXTRA_ARGS="${INGEST_EXTRA_ARGS:-}"

mkdir -p "${CRON_DIR}"
touch "${CYCLE_LOG}"

log() {
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  local msg="[${ts}] $*"
  echo "${msg}"
  echo "${msg}" >> "${CYCLE_LOG}"
}

json_value() {
  local key="$1"
  STATE_FILE="${STATE_FILE}" STATE_KEY="${key}" "${PYTHON_BIN}" - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["STATE_FILE"])
key = os.environ["STATE_KEY"]
if not path.exists():
    raise SystemExit(0)
try:
    data = json.loads(path.read_text(encoding="utf-8"))
except Exception:
    raise SystemExit(0)
value = data.get(key)
if value is None:
    raise SystemExit(0)
print(value)
PY
}

format_duration() {
  local total="$1"
  if (( total <= 0 )); then
    echo "0s"
    return
  fi

  local hours=$(( total / 3600 ))
  local minutes=$(( (total % 3600) / 60 ))
  local seconds=$(( total % 60 ))
  local parts=()

  if (( hours > 0 )); then
    parts+=("${hours}h")
  fi
  if (( minutes > 0 )); then
    parts+=("${minutes}m")
  fi
  if (( seconds > 0 || ${#parts[@]} == 0 )); then
    parts+=("${seconds}s")
  fi

  echo "${parts[*]}"
}

now_epoch() {
  date +%s
}

now_iso() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

update_state() {
  local action="$1"
  local timestamp_epoch timestamp_iso
  timestamp_epoch="$(now_epoch)"
  timestamp_iso="$(now_iso)"

  STATE_FILE="${STATE_FILE}" \
  STATE_ACTION="${action}" \
  STATE_NOW_EPOCH="${timestamp_epoch}" \
  STATE_NOW_ISO="${timestamp_iso}" \
  STATE_PID="$$" \
  STATE_SOURCE="${2:-}" \
  STATE_EXIT_CODE="${3:-}" \
  STATE_CYCLE_START_EPOCH="${CYCLE_START_EPOCH:-}" \
  STATE_CYCLE_START_ISO="${CYCLE_START_ISO:-}" \
  "${PYTHON_BIN}" - <<'PY'
import json
import os
from pathlib import Path

path = Path(os.environ["STATE_FILE"])
path.parent.mkdir(parents=True, exist_ok=True)

try:
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
except Exception:
    data = {}

action = os.environ["STATE_ACTION"]
now_epoch = int(os.environ["STATE_NOW_EPOCH"])
now_iso = os.environ["STATE_NOW_ISO"]

data["last_pid"] = int(os.environ["STATE_PID"])

if action == "start":
    data["last_started_epoch"] = now_epoch
    data["last_started_at"] = now_iso
    data["last_result"] = "running"
    data["last_failed_source"] = None
    data["last_exit_code"] = None
    data["current_source"] = None
elif action == "source":
    data["current_source"] = os.environ["STATE_SOURCE"]
elif action == "success":
    data["last_completed_epoch"] = now_epoch
    data["last_completed_at"] = now_iso
    data["last_result"] = "success"
    data["last_failed_source"] = None
    data["last_exit_code"] = None
    data["current_source"] = None
    if os.environ.get("STATE_CYCLE_START_EPOCH"):
        data["last_success_started_epoch"] = int(os.environ["STATE_CYCLE_START_EPOCH"])
        data["last_success_started_at"] = os.environ["STATE_CYCLE_START_ISO"]
    data["last_success_completed_epoch"] = now_epoch
    data["last_success_completed_at"] = now_iso
elif action == "failure":
    data["last_completed_epoch"] = now_epoch
    data["last_completed_at"] = now_iso
    data["last_result"] = "failure"
    data["last_failed_source"] = os.environ["STATE_SOURCE"] or None
    data["last_exit_code"] = int(os.environ["STATE_EXIT_CODE"] or "1")
    data["current_source"] = None

path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

cleanup_lock() {
  rm -rf "${LOCK_DIR}"
}

write_lock_info() {
  cat > "${LOCK_INFO_FILE}" <<EOF
pid=$$
started_at=$(now_iso)
cwd=${SCRIPT_DIR}
host=$(hostname)
EOF
}

lock_pid_from_file() {
  if [[ -f "${LOCK_INFO_FILE}" ]]; then
    awk -F= '/^pid=/{print $2; exit}' "${LOCK_INFO_FILE}"
  fi
}

acquire_lock() {
  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    write_lock_info
    trap cleanup_lock EXIT
    return
  fi

  local existing_pid=""
  existing_pid="$(lock_pid_from_file || true)"

  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" 2>/dev/null; then
    log "Another ingest cycle is already running (pid=${existing_pid}). Skipping."
    exit 0
  fi

  log "Found a stale lock at ${LOCK_DIR}; removing it."
  rm -rf "${LOCK_DIR}"

  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    write_lock_info
    trap cleanup_lock EXIT
    return
  fi

  log "Could not acquire ingest lock at ${LOCK_DIR}. Skipping."
  exit 1
}

parse_env_extra_args() {
  if [[ -z "${INGEST_EXTRA_ARGS}" ]]; then
    return
  fi

  INGEST_EXTRA_ARGS="${INGEST_EXTRA_ARGS}" "${PYTHON_BIN}" - <<'PY'
import os
import shlex
import sys

for arg in shlex.split(os.environ.get("INGEST_EXTRA_ARGS", "")):
    sys.stdout.write(arg)
    sys.stdout.write("\0")
PY
}

ENV_EXTRA_ARGS=()
if [[ -n "${INGEST_EXTRA_ARGS}" ]]; then
  while IFS= read -r -d '' arg; do
    ENV_EXTRA_ARGS+=("${arg}")
  done < <(parse_env_extra_args)
fi

FORWARDED_ARGS=("${ENV_EXTRA_ARGS[@]}" "$@")

run_due_check() {
  local last_started=""
  last_started="$(json_value "last_started_epoch" || true)"
  if [[ -z "${last_started}" ]]; then
    return
  fi

  if (( INGEST_INTERVAL_SECONDS <= 0 )); then
    return
  fi

  local current elapsed remaining last_started_at
  current="$(now_epoch)"
  elapsed=$(( current - last_started ))
  if (( elapsed >= INGEST_INTERVAL_SECONDS )); then
    return
  fi

  remaining=$(( INGEST_INTERVAL_SECONDS - elapsed ))
  last_started_at="$(json_value "last_started_at" || true)"
  log "Skipping: last cycle started at ${last_started_at:-unknown}; next eligible in $(format_duration "${remaining}")."
  exit 0
}

run_source() {
  local source="$1"
  local workers="$2"

  update_state source "${source}"
  log "Starting source ${source} with workers=${workers}."

  local cmd=(
    "${PYTHON_BIN}"
    "${SCRIPT_DIR}/ingest.py"
    "--source" "${source}"
    "-w" "${workers}"
  )
  if (( ${#FORWARDED_ARGS[@]} > 0 )); then
    cmd+=("${FORWARDED_ARGS[@]}")
  fi

  if "${cmd[@]}" 2>&1 | tee -a "${CYCLE_LOG}"; then
    log "Source ${source} completed successfully."
  else
    local rc=${PIPESTATUS[0]}
    log "Source ${source} failed with exit code ${rc}."
    update_state failure "${source}" "${rc}"
    exit "${rc}"
  fi

  if (( SOURCE_PAUSE_SECONDS > 0 )) && [[ "${source}" != "tf" ]]; then
    log "Pausing ${SOURCE_PAUSE_SECONDS}s before the next source."
    sleep "${SOURCE_PAUSE_SECONDS}"
  fi
}

acquire_lock
run_due_check

cd "${SCRIPT_DIR}"

CYCLE_START_EPOCH="$(now_epoch)"
CYCLE_START_ISO="$(now_iso)"

update_state start
log "Starting ingest cycle in ${SCRIPT_DIR}."
log "Config: interval=${INGEST_INTERVAL_SECONDS}s mtc_workers=${MTC_WORKERS} ttv_workers=${TTV_WORKERS} tf_workers=${TF_WORKERS}."
if (( ${#FORWARDED_ARGS[@]} > 0 )); then
  log "Forwarded ingest args: ${FORWARDED_ARGS[*]}"
fi

run_source "mtc" "${MTC_WORKERS}"
run_source "ttv" "${TTV_WORKERS}"
run_source "tf" "${TF_WORKERS}"

update_state success
log "Ingest cycle finished successfully."
