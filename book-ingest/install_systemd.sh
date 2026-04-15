#!/usr/bin/env bash
set -euo pipefail

# ─── Install book-ingest systemd user timer ──────────────────────────────────
#
# One-time setup script.  Safe to re-run (idempotent).
#
# What it does:
#   1. Copies unit files to ~/.config/systemd/user/
#   2. Reloads systemd daemon
#   3. Enables and starts the timer
#   4. Cleans up stale locks and state from previous manual runs
#   5. Prints status
# ──────────────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRON_DIR="${SCRIPT_DIR}/data/cron"
SYSTEMD_USER_DIR="${HOME}/.config/systemd/user"

echo "=== Installing book-ingest systemd timer ==="

# ── 1. Unit files ────────────────────────────────────────────────────────────

echo "Checking systemd unit files in ${SYSTEMD_USER_DIR}/ ..."

UNITS=(
  "book-ingest@.service"
  "book-ingest.target"
  "book-ingest.timer"
)

all_present=true
for unit in "${UNITS[@]}"; do
  if [[ ! -f "${SYSTEMD_USER_DIR}/${unit}" ]]; then
    echo "  MISSING: ${unit}"
    all_present=false
  else
    echo "  OK: ${unit}"
  fi
done

if [[ "${all_present}" != "true" ]]; then
  echo ""
  echo "ERROR: Some unit files are missing from ${SYSTEMD_USER_DIR}/."
  echo "Please copy them first, e.g.:"
  echo "  cp book-ingest@.service book-ingest.target book-ingest.timer ${SYSTEMD_USER_DIR}/"
  exit 1
fi

# ── 2. Reload systemd ───────────────────────────────────────────────────────

echo ""
echo "Reloading systemd user daemon..."
systemctl --user daemon-reload
echo "  Done."

# ── 3. Enable and start timer ───────────────────────────────────────────────

echo ""
echo "Enabling and starting book-ingest.timer..."
systemctl --user enable book-ingest.timer
systemctl --user start book-ingest.timer
echo "  Done."

# ── 4. Clean up stale state ─────────────────────────────────────────────────

echo ""
echo "Cleaning up stale state..."

# Remove old single-lock directory (pre-refactor)
if [[ -d "${CRON_DIR}/ingest-cycle.lock" ]]; then
  rm -rf "${CRON_DIR}/ingest-cycle.lock"
  echo "  Removed stale ingest-cycle.lock/"
fi

# Remove old global state file (pre-refactor)
if [[ -f "${CRON_DIR}/state.json" ]]; then
  rm -f "${CRON_DIR}/state.json"
  echo "  Removed stale state.json"
fi

# Fix per-source state files stuck in "running" with dead PIDs
PYTHON_BIN="${PYTHON_BIN:-python3}"
for source in mtc ttv tf; do
  state_file="${CRON_DIR}/state_${source}.json"
  if [[ ! -f "${state_file}" ]]; then
    continue
  fi

  result="$(STATE_FILE="${state_file}" STATE_KEY="last_result" "${PYTHON_BIN}" -c '
import json, os
from pathlib import Path
p = Path(os.environ["STATE_FILE"])
d = json.loads(p.read_text()) if p.exists() else {}
print(d.get(os.environ["STATE_KEY"], ""))
' 2>/dev/null || true)"

  if [[ "${result}" == "running" ]]; then
    pid="$(STATE_FILE="${state_file}" STATE_KEY="last_pid" "${PYTHON_BIN}" -c '
import json, os
from pathlib import Path
p = Path(os.environ["STATE_FILE"])
d = json.loads(p.read_text()) if p.exists() else {}
print(d.get(os.environ["STATE_KEY"], ""))
' 2>/dev/null || true)"

    if [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null; then
      echo "  ${source}: still running (pid=${pid}), leaving as-is"
    else
      # Mark as interrupted so the next timer tick will retry
      "${PYTHON_BIN}" -c "
import json
from pathlib import Path
p = Path('${state_file}')
d = json.loads(p.read_text())
d['last_result'] = 'interrupted'
p.write_text(json.dumps(d, indent=2, sort_keys=True) + '\n')
"
      echo "  ${source}: marked stale 'running' state as 'interrupted' (pid=${pid:-unknown} dead)"
    fi
  fi

  # Also remove stale per-source locks
  lock_dir="${CRON_DIR}/ingest-${source}.lock"
  if [[ -d "${lock_dir}" ]]; then
    lock_pid="$(awk -F= '/^pid=/{print $2; exit}' "${lock_dir}/owner.txt" 2>/dev/null || true)"
    if [[ -n "${lock_pid}" ]] && kill -0 "${lock_pid}" 2>/dev/null; then
      echo "  ${source}: lock held by live pid=${lock_pid}, leaving"
    else
      rm -rf "${lock_dir}"
      echo "  ${source}: removed stale lock (pid=${lock_pid:-unknown})"
    fi
  fi
done

# ── 5. Status ────────────────────────────────────────────────────────────────

echo ""
echo "=== Timer status ==="
systemctl --user list-timers 'book-ingest*' --all 2>/dev/null || true

echo ""
echo "=== Service status ==="
for source in mtc ttv tf; do
  echo "--- ${source} ---"
  systemctl --user status "book-ingest@${source}.service" --no-pager 2>/dev/null || true
  echo ""
done

echo "=== Installation complete ==="
echo ""
echo "Useful commands:"
echo "  systemctl --user start book-ingest.target          # trigger all sources now"
echo "  systemctl --user start book-ingest@mtc.service     # trigger one source"
echo "  systemctl --user stop book-ingest@mtc.service      # stop one source"
echo "  systemctl --user list-timers 'book-ingest*'        # check timer"
echo "  journalctl --user -u 'book-ingest@*' -f            # follow all logs"
echo "  journalctl --user -u book-ingest@mtc --since '1h ago'  # one source"
