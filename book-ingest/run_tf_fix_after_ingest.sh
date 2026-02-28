#!/usr/bin/env bash
set -euo pipefail

# ── run_tf_fix_after_ingest.sh ──────────────────────────────────────────────
#
# Monitors the current TF ingest process, then runs --fix in a loop
# until all chapter gaps are filled.
#
# Usage:
#   ./run_tf_fix_after_ingest.sh          # default: 10 workers
#   ./run_tf_fix_after_ingest.sh 5        # custom worker count
#   ./run_tf_fix_after_ingest.sh 10 3     # 10 workers, max 3 fix rounds

WORKERS="${1:-10}"
MAX_ROUNDS="${2:-10}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DB_PATH="${SCRIPT_DIR}/../binslib/data/binslib.db"
LOG="${SCRIPT_DIR}/data/tf-fix-loop.log"

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg"
  echo "$msg" >> "$LOG"
}

get_stats() {
  python3 -c "
import sqlite3, json
db = sqlite3.connect('${DB_PATH}')
total_ch = db.execute(\"SELECT COALESCE(SUM(chapters_saved),0) FROM books WHERE source='tf'\").fetchone()[0]
with_ch = db.execute(\"SELECT COUNT(*) FROM books WHERE source='tf' AND chapters_saved > 0\").fetchone()[0]
total = db.execute(\"SELECT COUNT(*) FROM books WHERE source='tf'\").fetchone()[0]
db.close()
try:
    with open('${SCRIPT_DIR}/data/books_plan_tf.json') as f:
        plan = json.load(f)
    plan_ch = sum(e.get('chapter_count', 0) for e in plan)
except: plan_ch = 0
print(f'{with_ch} {total} {total_ch} {plan_ch}')
"
}

# ── Phase 1: Wait for any running ingest process ────────────────────────────

if pgrep -f 'ingest.py.*--source tf' > /dev/null 2>&1; then
  log "Waiting for running TF ingest to finish..."
  while pgrep -f 'ingest.py.*--source tf' > /dev/null 2>&1; do
    read -r with_ch total total_ch plan_ch <<< "$(get_stats)"
    pct=0
    if (( plan_ch > 0 )); then
      pct=$(python3 -c "print(f'{${total_ch}*100/${plan_ch}:.1f}')")
    fi
    log "  Progress: ${with_ch}/${total} books, ${total_ch}/${plan_ch} chapters (${pct}%)"
    sleep 60
  done
  log "Initial ingest finished."
else
  log "No running TF ingest detected."
fi

echo ""
read -r with_ch total total_ch plan_ch <<< "$(get_stats)"
log "Current state: ${with_ch}/${total} books, ${total_ch}/${plan_ch} chapters"

# ── Phase 2: Run --fix in a loop until no gaps remain ───────────────────────

round=0
while (( round < MAX_ROUNDS )); do
  round=$((round + 1))
  log ""
  log "════════════════════════════════════════════════════════════"
  log "  Fix round ${round}/${MAX_ROUNDS} — workers=${WORKERS}"
  log "════════════════════════════════════════════════════════════"

  # Dry-run first to check if there are gaps
  dry_output=$(cd "$SCRIPT_DIR" && python3 ingest.py --source tf --fix --dry-run 2>&1)

  if echo "$dry_output" | grep -q "Nothing to fix"; then
    log "All books are complete. Nothing to fix!"
    break
  fi

  # Extract gap count from dry-run output
  gap_line=$(echo "$dry_output" | grep "Total chapters to fix" || echo "")
  log "  ${gap_line:-Gaps detected, starting fix...}"

  # Run the actual fix
  cd "$SCRIPT_DIR"
  log "  Starting: python3 ingest.py --source tf --fix -w ${WORKERS}"
  python3 ingest.py --source tf --fix -w "$WORKERS" 2>&1 | tee -a "$LOG"

  # Post-fix stats
  read -r with_ch total total_ch plan_ch <<< "$(get_stats)"
  log "  After round ${round}: ${with_ch}/${total} books, ${total_ch}/${plan_ch} chapters"

  # Brief pause between rounds to let the server recover
  if (( round < MAX_ROUNDS )); then
    log "  Pausing 30s before next round..."
    sleep 30
  fi
done

# ── Summary ─────────────────────────────────────────────────────────────────

echo ""
log "════════════════════════════════════════════════════════════"
log "  Fix loop complete after ${round} round(s)"
read -r with_ch total total_ch plan_ch <<< "$(get_stats)"
pct=0
if (( plan_ch > 0 )); then
  pct=$(python3 -c "print(f'{${total_ch}*100/${plan_ch}:.1f}')")
fi
log "  Final: ${with_ch}/${total} books, ${total_ch}/${plan_ch} chapters (${pct}%)"
log "  Log: ${LOG}"
log "════════════════════════════════════════════════════════════"
