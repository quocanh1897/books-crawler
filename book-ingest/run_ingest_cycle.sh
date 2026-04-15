#!/usr/bin/env bash
set -euo pipefail

# ─── Parallel ingest cycle (manual / ad-hoc use) ────────────────────────────
#
# NOTE: For production, use the systemd timer instead:
#   systemctl --user start book-ingest.target        # trigger all sources now
#   systemctl --user start book-ingest@mtc.service   # trigger one source
#   systemctl --user list-timers 'book-ingest*'      # check timer schedule
#   journalctl --user -u 'book-ingest@*' -f          # follow all source logs
#
# This script is retained for manual / ad-hoc runs.  It spawns all 3 sources
# (mtc, ttv, tf) as parallel background processes, each with its own 5-hour
# interval gate and per-source lock.
#
# Per-source state files:  data/cron/state_<source>.json
# Per-source lock dirs:    data/cron/ingest-<source>.lock
# Shared cycle log:        data/cron/cycle.log
#
# Environment overrides:
#   INGEST_INTERVAL_SECONDS  — per-source cooldown (default: 18000 = 5h)
#   MTC_WORKERS / TTV_WORKERS / TF_WORKERS — worker counts per source
#   INGEST_EXTRA_ARGS        — additional args forwarded to ingest.py
#   PYTHON_BIN               — python interpreter (default: python3)
# ──────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRON_DIR="${SCRIPT_DIR}/data/cron"
CYCLE_LOG="${CRON_DIR}/cycle.log"

PYTHON_BIN="${PYTHON_BIN:-python3}"
INGEST_INTERVAL_SECONDS="${INGEST_INTERVAL_SECONDS:-18000}"  # 5 hours
MTC_WORKERS="${MTC_WORKERS:-5}"
TTV_WORKERS="${TTV_WORKERS:-3}"
TF_WORKERS="${TF_WORKERS:-3}"
INGEST_EXTRA_ARGS="${INGEST_EXTRA_ARGS:-}"
FORCE_RUN_NOW=0

print_usage() {
  cat <<'EOF'
Usage: ./run_ingest_cycle.sh [options] [--] [ingest.py args...]

Options:
  --force-run-now  Bypass the per-source interval gate for this invocation.
  -h, --help       Show this help message.

All arguments after -- are forwarded to ingest.py for every source.

Sources (mtc, ttv, tf) run in parallel.  Each source has its own:
  - Interval gate (default 5 hours)
  - Lock file (prevents duplicate runs of the same source)
  - State file (tracks last run time and result)
EOF
}

PASSTHROUGH_ARGS=()
while (($# > 0)); do
  case "$1" in
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

mkdir -p "${CRON_DIR}"
touch "${CYCLE_LOG}"

# ── Shared helpers ────────────────────────────────────────────────────────────

log() {
  local ts
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  local msg="[${ts}] $*"
  echo "${msg}"
  echo "${msg}" >> "${CYCLE_LOG}"
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
  (( hours > 0 ))   && parts+=("${hours}h")
  (( minutes > 0 )) && parts+=("${minutes}m")
  (( seconds > 0 || ${#parts[@]} == 0 )) && parts+=("${seconds}s")
  echo "${parts[*]}"
}

now_epoch() { date +%s; }
now_iso()   { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

# ── Per-source state helpers (use python for safe JSON read/write) ────────────

json_value() {
  local state_file="$1" key="$2"
  STATE_FILE="${state_file}" STATE_KEY="${key}" "${PYTHON_BIN}" - <<'PY'
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

update_source_state() {
  local state_file="$1" action="$2"
  local source_name="${3:-}" exit_code="${4:-}"
  local ts_epoch ts_iso
  ts_epoch="$(now_epoch)"
  ts_iso="$(now_iso)"

  STATE_FILE="${state_file}" \
  STATE_ACTION="${action}" \
  STATE_NOW_EPOCH="${ts_epoch}" \
  STATE_NOW_ISO="${ts_iso}" \
  STATE_PID="$$" \
  STATE_SOURCE="${source_name}" \
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

action   = os.environ["STATE_ACTION"]
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
    data["last_completed_epoch"]        = now_epoch
    data["last_completed_at"]           = now_iso
    data["last_result"]                 = "success"
    data["last_exit_code"]              = None
    data["last_success_completed_epoch"] = now_epoch
    data["last_success_completed_at"]   = now_iso
elif action == "failure":
    data["last_completed_epoch"] = now_epoch
    data["last_completed_at"]    = now_iso
    data["last_result"]          = "failure"
    data["last_exit_code"]       = int(os.environ.get("STATE_EXIT_CODE") or "1")

path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

# ── Per-source lock (mkdir-based) ─────────────────────────────────────────────

acquire_source_lock() {
  local lock_dir="$1" source_name="$2"
  local info_file="${lock_dir}/owner.txt"

  if mkdir "${lock_dir}" 2>/dev/null; then
    cat > "${info_file}" <<EOF
pid=$$
source=${source_name}
started_at=$(now_iso)
host=$(hostname)
EOF
    return 0
  fi

  # Check if existing holder is alive
  local existing_pid=""
  if [[ -f "${info_file}" ]]; then
    existing_pid="$(awk -F= '/^pid=/{print $2; exit}' "${info_file}" || true)"
  fi

  if [[ -n "${existing_pid}" ]] && kill -0 "${existing_pid}" 2>/dev/null; then
    log "[${source_name}] Another instance already running (pid=${existing_pid}). Skipping."
    return 1
  fi

  # Stale lock
  log "[${source_name}] Removing stale lock at ${lock_dir}."
  rm -rf "${lock_dir}"

  if mkdir "${lock_dir}" 2>/dev/null; then
    cat > "${info_file}" <<EOF
pid=$$
source=${source_name}
started_at=$(now_iso)
host=$(hostname)
EOF
    return 0
  fi

  log "[${source_name}] Could not acquire lock. Skipping."
  return 1
}

release_source_lock() {
  local lock_dir="$1"
  rm -rf "${lock_dir}"
}

# ── Parse INGEST_EXTRA_ARGS from env ─────────────────────────────────────────

parse_env_extra_args() {
  if [[ -z "${INGEST_EXTRA_ARGS}" ]]; then
    return
  fi
  INGEST_EXTRA_ARGS="${INGEST_EXTRA_ARGS}" "${PYTHON_BIN}" - <<'PY'
import os, shlex, sys
for arg in shlex.split(os.environ.get("INGEST_EXTRA_ARGS", "")):
    sys.stdout.write(arg + "\0")
PY
}

ENV_EXTRA_ARGS=()
if [[ -n "${INGEST_EXTRA_ARGS}" ]]; then
  while IFS= read -r -d '' arg; do
    ENV_EXTRA_ARGS+=("${arg}")
  done < <(parse_env_extra_args)
fi

FORWARDED_ARGS=("${ENV_EXTRA_ARGS[@]}" "${PASSTHROUGH_ARGS[@]}")

# ── run_source: self-contained function for one source ────────────────────────
#
# Each invocation:
#   1. Acquires its own lock
#   2. Checks its own interval gate
#   3. Runs ingest.py --source <name>
#   4. Updates its own state file
#   5. Releases its lock
#
# Returns 0 on success or skip, non-zero on failure.

run_source() {
  local source="$1"
  local workers="$2"

  local state_file="${CRON_DIR}/state_${source}.json"
  local lock_dir="${CRON_DIR}/ingest-${source}.lock"

  # ── Lock ──
  if ! acquire_source_lock "${lock_dir}" "${source}"; then
    return 0  # skip, not an error
  fi

  # ── Interval gate ──
  if (( FORCE_RUN_NOW == 0 )); then
    local last_started=""
    last_started="$(json_value "${state_file}" "last_started_epoch" || true)"
    if [[ -n "${last_started}" ]] && (( INGEST_INTERVAL_SECONDS > 0 )); then
      local current elapsed remaining
      current="$(now_epoch)"
      elapsed=$(( current - last_started ))
      if (( elapsed < INGEST_INTERVAL_SECONDS )); then
        remaining=$(( INGEST_INTERVAL_SECONDS - elapsed ))
        local last_at=""
        last_at="$(json_value "${state_file}" "last_started_at" || true)"
        log "[${source}] Skipping: last run at ${last_at:-unknown}; next eligible in $(format_duration "${remaining}")."
        release_source_lock "${lock_dir}"
        return 0
      fi
    fi
  else
    log "[${source}] Force run requested; bypassing interval gate."
  fi

  # ── Run ingest ──
  update_source_state "${state_file}" start "${source}"
  log "[${source}] Starting ingest with workers=${workers}."

  local cmd=(
    "${PYTHON_BIN}"
    "${SCRIPT_DIR}/ingest.py"
    "--source" "${source}"
    "-w" "${workers}"
  )
  if (( ${#FORWARDED_ARGS[@]} > 0 )); then
    cmd+=("${FORWARDED_ARGS[@]}")
  fi

  local rc=0
  if "${cmd[@]}" 2>&1 | tee -a "${CYCLE_LOG}"; then
    log "[${source}] Completed successfully."
    update_source_state "${state_file}" success "${source}"
  else
    rc=${PIPESTATUS[0]}
    log "[${source}] Failed with exit code ${rc}."
    update_source_state "${state_file}" failure "${source}" "${rc}"
  fi

  release_source_lock "${lock_dir}"
  return "${rc}"
}

# ── Main: launch all sources in parallel ──────────────────────────────────────

cd "${SCRIPT_DIR}"

log "=== Parallel ingest cycle starting (pid=$$) ==="
log "Config: interval=${INGEST_INTERVAL_SECONDS}s ($(format_duration ${INGEST_INTERVAL_SECONDS})), mtc_workers=${MTC_WORKERS}, ttv_workers=${TTV_WORKERS}, tf_workers=${TF_WORKERS}"
if (( ${#FORWARDED_ARGS[@]} > 0 )); then
  log "Forwarded ingest args: ${FORWARDED_ARGS[*]}"
fi

# Spawn each source in a subshell background process
PIDS=()
SOURCES=()

run_source "mtc" "${MTC_WORKERS}" &
PIDS+=($!)
SOURCES+=("mtc")

run_source "ttv" "${TTV_WORKERS}" &
PIDS+=($!)
SOURCES+=("ttv")

run_source "tf" "${TF_WORKERS}" &
PIDS+=($!)
SOURCES+=("tf")

log "Spawned ${#PIDS[@]} source processes: ${SOURCES[*]} (pids: ${PIDS[*]})"

# Wait for all and collect exit codes
FAILURES=0
for i in "${!PIDS[@]}"; do
  pid="${PIDS[$i]}"
  source_name="${SOURCES[$i]}"
  if wait "${pid}"; then
    log "[${source_name}] Process ${pid} exited successfully."
  else
    rc=$?
    log "[${source_name}] Process ${pid} exited with code ${rc}."
    (( FAILURES++ )) || true
  fi
done

if (( FAILURES > 0 )); then
  log "=== Parallel ingest cycle finished with ${FAILURES} failure(s) ==="
  exit 1
else
  log "=== Parallel ingest cycle finished successfully ==="
  exit 0
fi
