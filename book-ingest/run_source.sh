#!/usr/bin/env bash
set -euo pipefail

# ─── Single-source ingest runner ─────────────────────────────────────────────
#
# Runs ingest.py for exactly ONE source (mtc, ttv, or tf).  Designed to be
# invoked by systemd (book-ingest@<source>.service) on a 15-minute timer, but
# also works standalone for manual/ad-hoc runs.
#
# Lifecycle per invocation:
#   1. Acquire per-source lock (skip if another instance is running)
#   2. Check interval gate (skip if last successful run was recent enough)
#   3. Run ingest.py --source <name> with a 10-hour hard timeout
#   4. Update per-source state file on completion/failure
#   5. Signal trap cleans up on interruption (SIGTERM/SIGINT/SIGHUP)
#
# Per-source state file:  data/cron/state_<source>.json
# Per-source lock dir:    data/cron/ingest-<source>.lock
# Wrapper log:            data/cron/cycle.log
#
# Environment overrides (or via EnvironmentFile in systemd):
#   WORKERS                  — worker count for this source (default: 5)
#   INGEST_INTERVAL_SECONDS  — cooldown after successful run (default: 18000 = 5h)
#   INGEST_EXTRA_ARGS        — additional args forwarded to ingest.py
#   PYTHON_BIN               — python interpreter (default: python3)
#   MAX_RUNTIME_SECONDS      — hard timeout for ingest.py (default: 36000 = 10h)
#
# Usage:
#   ./run_source.sh --source mtc                     # normal run
#   ./run_source.sh --source ttv --workers 5         # override workers
#   ./run_source.sh --source tf --force-run-now      # bypass interval gate
#   ./run_source.sh --source mtc -- --dry-run        # forward args to ingest.py
#
# systemd quick reference:
#   systemctl --user start book-ingest@mtc           # trigger one source
#   systemctl --user start book-ingest.target        # trigger all sources
#   systemctl --user list-timers                     # check timer schedule
#   journalctl --user -u 'book-ingest@*' -f          # follow all source logs
# ──────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRON_DIR="${SCRIPT_DIR}/data/cron"

PYTHON_BIN="${PYTHON_BIN:-python3}"
INGEST_INTERVAL_SECONDS="${INGEST_INTERVAL_SECONDS:-18000}"  # 5 hours
MAX_RUNTIME_SECONDS="${MAX_RUNTIME_SECONDS:-36000}"          # 10 hours
INGEST_EXTRA_ARGS="${INGEST_EXTRA_ARGS:-}"

# Source name and workers (set via args or env)
SOURCE=""
WORKERS="${WORKERS:-5}"
FORCE_RUN_NOW=0
PASSTHROUGH_ARGS=()

# ── Argument parsing ─────────────────────────────────────────────────────────

print_usage() {
  cat <<'EOF'
Usage: ./run_source.sh --source <name> [options] [--] [ingest.py args...]

Required:
  --source <name>      Source to ingest: mtc, ttv, or tf

Options:
  --workers <n>        Worker count (default: $WORKERS or 5)
  --force-run-now      Bypass the interval gate for this invocation
  -h, --help           Show this help message

All arguments after -- are forwarded to ingest.py.
EOF
}

while (($# > 0)); do
  case "$1" in
    --source)
      SOURCE="$2"
      shift 2
      ;;
    --workers)
      WORKERS="$2"
      shift 2
      ;;
    --force-run-now)
      FORCE_RUN_NOW=1
      shift
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    --)
      shift
      PASSTHROUGH_ARGS+=("$@")
      break
      ;;
    *)
      PASSTHROUGH_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -z "${SOURCE}" ]]; then
  echo "Error: --source is required (mtc, ttv, or tf)" >&2
  print_usage >&2
  exit 1
fi

case "${SOURCE}" in
  mtc|ttv|tf) ;;
  *)
    echo "Error: unknown source '${SOURCE}'. Must be mtc, ttv, or tf." >&2
    exit 1
    ;;
esac

# ── Paths ────────────────────────────────────────────────────────────────────

STATE_FILE="${CRON_DIR}/state_${SOURCE}.json"
LOCK_DIR="${CRON_DIR}/ingest-${SOURCE}.lock"
CYCLE_LOG="${CRON_DIR}/cycle.log"

mkdir -p "${CRON_DIR}"

# ── Helpers ──────────────────────────────────────────────────────────────────

now_epoch() { date +%s; }
now_iso()   { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

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
  (( hours > 0 ))   && parts+=("${hours}h")
  (( minutes > 0 )) && parts+=("${minutes}m")
  (( seconds > 0 || ${#parts[@]} == 0 )) && parts+=("${seconds}s")
  echo "${parts[*]}"
}

log() {
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  local msg="[${ts}] [${SOURCE}] $*"
  echo "${msg}"
  echo "${msg}" >> "${CYCLE_LOG}" 2>/dev/null || true
}

# ── JSON state helpers (use python for safe read/write) ──────────────────────

json_value() {
  local key="$1"
  STATE_FILE="${STATE_FILE}" STATE_KEY="${key}" "${PYTHON_BIN}" - <<'PY'
import json, os
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

update_state() {
  local action="$1"
  local exit_code="${2:-}"
  local ts_epoch ts_iso
  ts_epoch="$(now_epoch)"
  ts_iso="$(now_iso)"

  STATE_FILE="${STATE_FILE}" \
  STATE_ACTION="${action}" \
  STATE_NOW_EPOCH="${ts_epoch}" \
  STATE_NOW_ISO="${ts_iso}" \
  STATE_PID="$$" \
  STATE_SOURCE="${SOURCE}" \
  STATE_EXIT_CODE="${exit_code}" \
  "${PYTHON_BIN}" - <<'PY'
import json, os
from pathlib import Path

path = Path(os.environ["STATE_FILE"])
path.parent.mkdir(parents=True, exist_ok=True)
try:
    data = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
except Exception:
    data = {}

action    = os.environ["STATE_ACTION"]
now_epoch = int(os.environ["STATE_NOW_EPOCH"])
now_iso   = os.environ["STATE_NOW_ISO"]

data["last_pid"] = int(os.environ["STATE_PID"])
data["source"]   = os.environ.get("STATE_SOURCE", "")

if action == "start":
    data["last_started_epoch"] = now_epoch
    data["last_started_at"]    = now_iso
    data["last_result"]        = "running"
    data["last_exit_code"]     = None
elif action == "success":
    data["last_completed_epoch"]         = now_epoch
    data["last_completed_at"]            = now_iso
    data["last_result"]                  = "success"
    data["last_exit_code"]               = None
    data["last_success_completed_epoch"] = now_epoch
    data["last_success_completed_at"]    = now_iso
elif action == "failure":
    data["last_completed_epoch"] = now_epoch
    data["last_completed_at"]    = now_iso
    data["last_result"]          = "failure"
    data["last_exit_code"]       = int(os.environ.get("STATE_EXIT_CODE") or "1")
elif action == "interrupted":
    data["last_completed_epoch"] = now_epoch
    data["last_completed_at"]    = now_iso
    data["last_result"]          = "interrupted"
    data["last_exit_code"]       = None

path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

# ── Per-source lock (mkdir-based, atomic) ────────────────────────────────────

acquire_lock() {
  local info_file="${LOCK_DIR}/owner.txt"

  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    cat > "${info_file}" <<EOF
pid=$$
source=${SOURCE}
started_at=$(now_iso)
host=$(hostname)
EOF
    return 0
  fi

  # Lock exists — check if holder is alive
  local existing_pid=""
  if [[ -f "${info_file}" ]]; then
    existing_pid="$(awk -F= '/^pid=/{print $2; exit}' "${info_file}" || true)"
  fi

  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" 2>/dev/null; then
    log "Another instance already running (pid=${existing_pid}). Skipping."
    return 1
  fi

  # Stale lock — remove and retry
  log "Removing stale lock (pid=${existing_pid:-unknown})."
  rm -rf "${LOCK_DIR}"

  if mkdir "${LOCK_DIR}" 2>/dev/null; then
    cat > "${info_file}" <<EOF
pid=$$
source=${SOURCE}
started_at=$(now_iso)
host=$(hostname)
EOF
    return 0
  fi

  log "Could not acquire lock. Skipping."
  return 1
}

release_lock() {
  rm -rf "${LOCK_DIR}"
}

# ── Signal trap — clean up on interruption ───────────────────────────────────

CHILD_PID=""
CLEANUP_DONE=0

cleanup() {
  # Guard against double-cleanup (EXIT fires after signal traps)
  if (( CLEANUP_DONE )); then
    return
  fi
  CLEANUP_DONE=1

  log "Interrupted (signal). Cleaning up."

  # Kill child ingest.py process if still running
  if [[ -n "${CHILD_PID}" ]] && kill -0 "${CHILD_PID}" 2>/dev/null; then
    log "Sending SIGTERM to child pid=${CHILD_PID}."
    kill -TERM "${CHILD_PID}" 2>/dev/null || true
    # Give it a few seconds to flush checkpoints
    sleep 3
    if kill -0 "${CHILD_PID}" 2>/dev/null; then
      log "Child still alive, sending SIGKILL."
      kill -KILL "${CHILD_PID}" 2>/dev/null || true
    fi
  fi

  update_state interrupted
  release_lock
}

trap cleanup SIGTERM SIGINT SIGHUP
trap 'cleanup' EXIT

# ── Log rotation ─────────────────────────────────────────────────────────────

rotate_log() {
  if [[ ! -f "${CYCLE_LOG}" ]]; then
    return
  fi
  local size
  size="$(stat -c%s "${CYCLE_LOG}" 2>/dev/null || echo 0)"
  if (( size > 10485760 )); then  # 10 MB
    mv "${CYCLE_LOG}" "${CYCLE_LOG}.$(date +%Y%m%d_%H%M%S)"
    # Keep only 3 rotated files
    ls -t "${CRON_DIR}"/cycle.log.* 2>/dev/null | tail -n +4 | xargs rm -f 2>/dev/null || true
    log "Rotated cycle.log (was $(( size / 1048576 )) MB)."
  fi
}

rotate_log

# ── Parse INGEST_EXTRA_ARGS from env ─────────────────────────────────────────

ENV_EXTRA_ARGS=()
if [[ -n "${INGEST_EXTRA_ARGS}" ]]; then
  while IFS= read -r -d '' arg; do
    ENV_EXTRA_ARGS+=("${arg}")
  done < <(
    INGEST_EXTRA_ARGS="${INGEST_EXTRA_ARGS}" "${PYTHON_BIN}" - <<'PY'
import os, shlex, sys
for arg in shlex.split(os.environ.get("INGEST_EXTRA_ARGS", "")):
    sys.stdout.write(arg + "\0")
PY
  )
fi

FORWARDED_ARGS=("${ENV_EXTRA_ARGS[@]}" "${PASSTHROUGH_ARGS[@]}")

# ── Stale state recovery ────────────────────────────────────────────────────

recover_stale_state() {
  local last_result=""
  last_result="$(json_value "last_result" || true)"

  if [[ "${last_result}" != "running" ]]; then
    return 0  # not stale
  fi

  local last_pid=""
  last_pid="$(json_value "last_pid" || true)"

  if [[ -n "${last_pid}" ]] && kill -0 "${last_pid}" 2>/dev/null; then
    return 0  # genuinely still running
  fi

  # PID is dead but state says "running" — mark as interrupted
  log "Previous run (pid=${last_pid:-unknown}) is dead with state 'running'. Recovering."
  update_state interrupted
}

# ── Interval gate ────────────────────────────────────────────────────────────
#
# Gate logic:
#   - If last_result is "running" and PID is alive → skip (already running)
#   - If last_result is "failure" or "interrupted" → allow re-run immediately
#   - If last_result is "success" → gate on last_completed_epoch + INTERVAL
#   - If no state exists → allow run
#
# This means: successful runs respect the 5h cooldown, but failed/interrupted
# runs retry on the next timer tick (max 15 min delay).

check_interval_gate() {
  if (( FORCE_RUN_NOW )); then
    log "Force run requested; bypassing interval gate."
    return 0
  fi

  local last_result=""
  last_result="$(json_value "last_result" || true)"

  # No previous state — first run ever
  if [[ -z "${last_result}" ]]; then
    return 0
  fi

  # Failed or interrupted → allow immediate retry
  if [[ "${last_result}" == "failure" || "${last_result}" == "interrupted" ]]; then
    log "Last run was '${last_result}'. Retrying."
    return 0
  fi

  # Still running (live PID) — should have been caught by lock, but double-check
  if [[ "${last_result}" == "running" ]]; then
    local last_pid=""
    last_pid="$(json_value "last_pid" || true)"
    if [[ -n "${last_pid}" ]] && kill -0 "${last_pid}" 2>/dev/null; then
      log "Previous run (pid=${last_pid}) still active. Skipping."
      return 1
    fi
    # Dead PID with "running" state — stale recovery should have caught this,
    # but allow run anyway.
    return 0
  fi

  # Success → gate on last_completed_epoch
  if (( INGEST_INTERVAL_SECONDS <= 0 )); then
    return 0
  fi

  local last_completed=""
  last_completed="$(json_value "last_completed_epoch" || true)"
  if [[ -z "${last_completed}" ]]; then
    return 0
  fi

  local current elapsed remaining
  current="$(now_epoch)"
  elapsed=$(( current - last_completed ))
  if (( elapsed >= INGEST_INTERVAL_SECONDS )); then
    return 0
  fi

  remaining=$(( INGEST_INTERVAL_SECONDS - elapsed ))
  local last_at=""
  last_at="$(json_value "last_completed_at" || true)"
  log "Skipping: last successful run completed at ${last_at:-unknown}; next eligible in $(format_duration "${remaining}")."
  return 1
}

# ══════════════════════════════════════════════════════════════════════════════
# MAIN
# ══════════════════════════════════════════════════════════════════════════════

cd "${SCRIPT_DIR}"

log "=== Starting (pid=$$, workers=${WORKERS}) ==="

# Step 1: Acquire lock
if ! acquire_lock; then
  # Not an error — another instance is handling this source
  CLEANUP_DONE=1  # prevent EXIT trap from running cleanup
  exit 0
fi

# Step 2: Recover stale state (dead PID still marked "running")
recover_stale_state

# Step 3: Check interval gate
if ! check_interval_gate; then
  release_lock
  CLEANUP_DONE=1
  exit 0
fi

# Step 4: Run ingest
update_state start
log "Config: interval=$(format_duration ${INGEST_INTERVAL_SECONDS}), max_runtime=$(format_duration ${MAX_RUNTIME_SECONDS}), workers=${WORKERS}"
if (( ${#FORWARDED_ARGS[@]} > 0 )); then
  log "Extra args: ${FORWARDED_ARGS[*]}"
fi

cmd=(
  timeout --signal=TERM --kill-after=60 "${MAX_RUNTIME_SECONDS}"
  "${PYTHON_BIN}"
  "${SCRIPT_DIR}/ingest.py"
  "--source" "${SOURCE}"
  "-w" "${WORKERS}"
)
if (( ${#FORWARDED_ARGS[@]} > 0 )); then
  cmd+=("${FORWARDED_ARGS[@]}")
fi

# Run ingest.py — stdout/stderr go to journald (when run via systemd)
# and also to cycle.log via tee for manual runs.
RC=0
CHILD_PID=""

if [[ -t 1 ]]; then
  # Interactive terminal — tee to cycle.log
  "${cmd[@]}" 2>&1 | tee -a "${CYCLE_LOG}" &
  CHILD_PID=$!
else
  # Non-interactive (systemd) — just run, journald captures output
  "${cmd[@]}" &
  CHILD_PID=$!
fi

wait "${CHILD_PID}" || RC=$?
CHILD_PID=""  # done, prevent cleanup from killing it

# Step 5: Update state and release lock
if (( RC == 0 )); then
  log "Completed successfully."
  update_state success
elif (( RC == 124 )); then
  log "Timed out after $(format_duration ${MAX_RUNTIME_SECONDS}). Marked as failure."
  update_state failure "${RC}"
else
  log "Failed with exit code ${RC}."
  update_state failure "${RC}"
fi

release_lock
CLEANUP_DONE=1
log "=== Finished (rc=${RC}) ==="

exit "${RC}"
