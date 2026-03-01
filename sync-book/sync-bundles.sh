#!/usr/bin/env bash
set -euo pipefail

# ── Argument parsing ────────────────────────────────────────────────────────

DIRECTION=""
COVER_ONLY=false
BUNDLE_ONLY=false
DB_ONLY=false
YES=false
OVERWRITE=false

for arg in "$@"; do
  case "$arg" in
    --cover-only)  COVER_ONLY=true ;;
    --bundle-only) BUNDLE_ONLY=true ;;
    --db-only)     DB_ONLY=true ;;
    -y|--yes)      YES=true ;;
    --overwrite)   OVERWRITE=true ;;
    upload|download)
      if [[ -n "$DIRECTION" ]]; then
        echo "ERROR: direction specified twice" >&2; exit 1
      fi
      DIRECTION="$arg"
      ;;
    -h|--help)
      cat <<EOF
Usage: $0 [upload|download] [--cover-only] [--bundle-only] [--db-only] [--overwrite] [-y|--yes]

Sync bundle files, cover images, and SQLite DB between local and remote.

Positional:
  upload      Push local files to server (default)
  download    Pull server files to local

Options:
  --cover-only    Only sync covers (binslib/public/covers/*.jpg)
  --bundle-only   Only sync bundles (binslib/data/compressed/*.bundle)
  --db-only       Only sync SQLite DB (binslib/data/binslib.db*)
  --overwrite     Force-sync all source files, even if dst >= src size
  -y, --yes       Skip confirmation prompt
  -h, --help      Show this help and exit

By default, syncs bundles, covers, and DB.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [upload|download] [--cover-only] [--bundle-only] [--db-only] [--overwrite] [-y]" >&2
      exit 1
      ;;
  esac
done

DIRECTION="${DIRECTION:-upload}"

# At most one --*-only flag allowed
only_count=0
$COVER_ONLY  && only_count=$((only_count + 1))
$BUNDLE_ONLY && only_count=$((only_count + 1))
$DB_ONLY     && only_count=$((only_count + 1))
if (( only_count > 1 )); then
  echo "ERROR: --cover-only, --bundle-only, and --db-only are mutually exclusive" >&2
  exit 1
fi

# ── Config ──────────────────────────────────────────────────────────────────

REMOTE_USER="alex"
REMOTE_HOST="192.168.1.22"
REMOTE_DOCKER_COMPOSE_DIR="/data/mtc/binslib"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BATCH_SIZE=500

LOCAL_BUNDLE_DIR="${PROJECT_ROOT}/binslib/data/compressed"
REMOTE_BUNDLE_DIR="/data/mtc/binslib/data/compressed"

LOCAL_COVERS_DIR="${PROJECT_ROOT}/binslib/public/covers"
REMOTE_COVERS_DIR="/data/mtc/binslib/public/covers"

LOCAL_DB_DIR="${PROJECT_ROOT}/binslib/data"
REMOTE_DB_DIR="/data/mtc/binslib/data"

LOG_FILE="${SCRIPT_DIR}/sync-bundles-${DIRECTION}.log"

# ── Plan directory (cleaned up on exit) ─────────────────────────────────────

PLAN_DIR=$(mktemp -d)
trap 'rm -rf "$PLAN_DIR"' EXIT

# Ordered list of categories that were scanned (populated by scan_dir)
PLAN_LABELS=()

# Totals across all categories (accumulated by scan_dir)
GRAND_NEW=0
GRAND_REPLACE=0
GRAND_SKIP=0

# ── Helpers ─────────────────────────────────────────────────────────────────

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
}

# human_size <bytes>
# Converts a byte count to a compact human-readable string.
human_size() {
  local bytes=$1
  if (( bytes >= 1073741824 )); then
    awk "BEGIN { printf \"%.1f GB\", $bytes / 1073741824 }"
  elif (( bytes >= 1048576 )); then
    awk "BEGIN { printf \"%.1f MB\", $bytes / 1048576 }"
  elif (( bytes >= 1024 )); then
    awk "BEGIN { printf \"%.1f KB\", $bytes / 1024 }"
  else
    printf "%d B" "$bytes"
  fi
}

# list_local_files <dir> <glob_pattern>
# Outputs "filename size" lines for matching files in <dir>.
list_local_files() {
  local dir="$1" pattern="$2"
  # macOS stat fallback to GNU find -printf
  find "$dir" -maxdepth 1 -name "$pattern" -exec stat -f '%N %z' {} \; 2>/dev/null \
    | sed "s|${dir}/||" \
    || find "$dir" -maxdepth 1 -name "$pattern" -printf '%f %s\n'
}

# list_remote_files <remote_dir> <glob_pattern>
# Outputs "filename size" lines for matching files on the remote.
list_remote_files() {
  local rdir="$1" pattern="$2"
  ssh "${REMOTE_USER}@${REMOTE_HOST}" \
    "find ${rdir} -maxdepth 1 -name '${pattern}' -printf '%f %s\n'"
}

# ── Phase 1: Scan ──────────────────────────────────────────────────────────
# scan_dir <local_dir> <remote_dir> <glob_pattern> <label>
#
# Builds the diff between source and destination. Writes plan files under
# $PLAN_DIR/<label>_* and accumulates grand totals. Does NOT transfer.
scan_dir() {
  local local_dir="$1" remote_dir="$2" pattern="$3" label="$4"
  local label_lc; label_lc=$(echo "$label" | tr A-Z a-z)

  PLAN_LABELS+=("$label")

  # Persist args so transfer_dir can read them back
  echo "$local_dir"  > "${PLAN_DIR}/${label}_local_dir"
  echo "$remote_dir" > "${PLAN_DIR}/${label}_remote_dir"

  log "--- Scanning ${label} (${DIRECTION}) ---"
  log "Local:  ${local_dir}"
  log "Remote: ${REMOTE_USER}@${REMOTE_HOST}:${remote_dir}"

  mkdir -p "$local_dir"
  ssh "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p ${remote_dir}"

  # ── Build file lists ──────────────────────────────────────────────────

  log "Building local ${label_lc} list..."
  local local_list; local_list=$(mktemp)
  list_local_files "$local_dir" "$pattern" > "$local_list"
  local local_count; local_count=$(wc -l < "$local_list" | tr -d ' ')
  log "Local ${label_lc}: ${local_count}"

  log "Fetching remote ${label_lc} list with sizes..."
  local remote_list; remote_list=$(mktemp)
  list_remote_files "$remote_dir" "$pattern" > "$remote_list"
  local remote_count; remote_count=$(wc -l < "$remote_list" | tr -d ' ')
  log "Remote ${label_lc}: ${remote_count}"

  # ── Diff by size ──────────────────────────────────────────────────────

  local to_sync_file="${PLAN_DIR}/${label}_to_sync"
  local replaces_file="${PLAN_DIR}/${label}_replaces"
  : > "$to_sync_file"
  : > "$replaces_file"

  local skipped=0 new_count=0 replace_count=0

  local src_list dst_list
  if [[ "$DIRECTION" == "upload" ]]; then
    src_list="$local_list"
    dst_list="$remote_list"
  else
    src_list="$remote_list"
    dst_list="$local_list"
  fi

  local joined; joined=$(mktemp)
  sort -k1,1 "$src_list" > "${src_list}.sorted"
  sort -k1,1 "$dst_list" > "${dst_list}.sorted"
  join -a1 -j1 -o '1.1 1.2 2.2' -e 0 "${src_list}.sorted" "${dst_list}.sorted" > "$joined"

  while IFS=' ' read -r fname src_size dst_size; do
    dst_size=${dst_size:-0}
    if ! $OVERWRITE && (( dst_size >= src_size )); then
      skipped=$((skipped + 1))
      continue
    fi
    if (( dst_size > 0 )); then
      # Overwrite — record details for the summary
      echo "${fname} ${src_size} ${dst_size}" >> "$replaces_file"
      replace_count=$((replace_count + 1))
    else
      new_count=$((new_count + 1))
    fi
    echo "$fname" >> "$to_sync_file"
  done < "$joined"

  rm -f "${src_list}.sorted" "${dst_list}.sorted" "$joined" "$local_list" "$remote_list"

  # Persist counts
  echo "$new_count"     > "${PLAN_DIR}/${label}_new"
  echo "$replace_count" > "${PLAN_DIR}/${label}_replace"
  echo "$skipped"       > "${PLAN_DIR}/${label}_skip"

  GRAND_NEW=$((GRAND_NEW + new_count))
  GRAND_REPLACE=$((GRAND_REPLACE + replace_count))
  GRAND_SKIP=$((GRAND_SKIP + skipped))

  local queued=$((new_count + replace_count))
  log "${label}: ${queued} to ${DIRECTION} (new=${new_count}, overwrite=${replace_count}), skip=${skipped}"
}

# ── Phase 2: Display plan ──────────────────────────────────────────────────
# Prints a human-readable summary of everything scan_dir found.
print_plan() {
  local dir_arrow
  if [[ "$DIRECTION" == "upload" ]]; then
    dir_arrow="LOCAL → REMOTE"
  else
    dir_arrow="REMOTE → LOCAL"
  fi

  echo ""
  echo "┌──────────────────────────────────────────────────────────────────┐"
  local dir_upper; dir_upper=$(echo "$DIRECTION" | tr a-z A-Z)
  local overwrite_tag=""
  $OVERWRITE && overwrite_tag="  [--overwrite]"
  printf "│  %-64s│\n" "Sync Plan: ${dir_upper}  (${dir_arrow})${overwrite_tag}"
  printf "│  %-64s│\n" "Remote: ${REMOTE_USER}@${REMOTE_HOST}"
  echo "├──────────────────────────────────────────────────────────────────┤"

  for label in "${PLAN_LABELS[@]}"; do
    local new_count; new_count=$(cat "${PLAN_DIR}/${label}_new")
    local replace_count; replace_count=$(cat "${PLAN_DIR}/${label}_replace")
    local skip_count; skip_count=$(cat "${PLAN_DIR}/${label}_skip")
    local queued=$((new_count + replace_count))

    echo "│                                                                  │"
    printf "│  %-64s│\n" "${label}"

    # New files
    if (( new_count > 0 )); then
      printf "│    %-62s│\n" "New:        ${new_count} file(s)"
    else
      printf "│    %-62s│\n" "New:        —"
    fi

    # Overwrites
    if (( replace_count > 0 )); then
      printf "│    %-62s│\n" "Overwrite:  ${replace_count} file(s)"

      local shown=0 max_show=10
      while IFS=' ' read -r fname src_size dst_size; do
        if (( shown >= max_show )); then
          local remaining=$((replace_count - max_show))
          printf "│    %-62s│\n" "            ... and ${remaining} more"
          break
        fi
        local h_dst; h_dst=$(human_size "$dst_size")
        local h_src; h_src=$(human_size "$src_size")
        printf "│      %-60s│\n" "$(printf '%-30s %8s → %8s' "$fname" "$h_dst" "$h_src")"
        shown=$((shown + 1))
      done < "${PLAN_DIR}/${label}_replaces"
    else
      printf "│    %-62s│\n" "Overwrite:  —"
    fi

    # Skipped
    if (( skip_count > 0 )); then
      printf "│    %-62s│\n" "Skip:       ${skip_count} file(s) (dst >= src)"
    else
      printf "│    %-62s│\n" "Skip:       —"
    fi
  done

  echo "│                                                                  │"
  echo "├──────────────────────────────────────────────────────────────────┤"

  local grand_total=$((GRAND_NEW + GRAND_REPLACE))
  printf "│  %-64s│\n" "Total: ${grand_total} to sync (${GRAND_NEW} new, ${GRAND_REPLACE} overwrite), ${GRAND_SKIP} to skip"
  echo "└──────────────────────────────────────────────────────────────────┘"
  echo ""
}

# ── Phase 3: Transfer ──────────────────────────────────────────────────────
# transfer_dir <label>
# Reads the plan built by scan_dir and rsyncs in batches.
transfer_dir() {
  local label="$1"
  local local_dir; local_dir=$(cat "${PLAN_DIR}/${label}_local_dir")
  local remote_dir; remote_dir=$(cat "${PLAN_DIR}/${label}_remote_dir")
  local to_sync_file="${PLAN_DIR}/${label}_to_sync"

  local queued; queued=$(wc -l < "$to_sync_file" | tr -d ' ')
  if (( queued == 0 )); then
    log "${label}: nothing to ${DIRECTION}. Already up to date."
    return 0
  fi

  log "--- Transferring ${label} (${queued} files) ---"

  local transferred=0 failed=0 total=$queued batch_num=0

  while true; do
    local offset=$((batch_num * BATCH_SIZE))
    if (( offset >= total )); then break; fi

    local batch_files; batch_files=$(sed -n "$((offset + 1)),$((offset + BATCH_SIZE))p" "$to_sync_file")
    local batch_count; batch_count=$(echo "$batch_files" | wc -l | tr -d ' ')
    local batch_end=$((offset + batch_count))
    batch_num=$((batch_num + 1))

    log "Batch ${batch_num}: files $((offset+1))-${batch_end} of ${total}"

    local include_args=""
    while IFS= read -r f; do
      include_args="${include_args} --include=${f}"
    done <<< "$batch_files"

    local rsync_src rsync_dst
    if [[ "$DIRECTION" == "upload" ]]; then
      rsync_src="${local_dir}/"
      rsync_dst="${REMOTE_USER}@${REMOTE_HOST}:${remote_dir}/"
    else
      rsync_src="${REMOTE_USER}@${REMOTE_HOST}:${remote_dir}/"
      rsync_dst="${local_dir}/"
    fi

    if rsync -az --progress \
      ${include_args} \
      --exclude='*' \
      "$rsync_src" \
      "$rsync_dst" 2>> "$LOG_FILE"; then
      transferred=$((transferred + batch_count))
      log "Batch complete: ${transferred}/${total} so far"
    else
      failed=$((failed + batch_count))
      log "ERROR: Batch failed, ${failed} files affected"
    fi
  done

  local skipped; skipped=$(cat "${PLAN_DIR}/${label}_skip")
  log "${label} done: ${DIRECTION}ed=${transferred}, skipped=${skipped}, failed=${failed}"
}

# ── Main ────────────────────────────────────────────────────────────────────

log "=== Sync ${DIRECTION} started ==="

# ── Phase 1: Scan all applicable categories ─────────────────────────────────

if $COVER_ONLY; then
  log "Mode: covers only"
  scan_dir "$LOCAL_COVERS_DIR" "$REMOTE_COVERS_DIR" '*.jpg' "Covers"
elif $BUNDLE_ONLY; then
  log "Mode: bundles only"
  scan_dir "$LOCAL_BUNDLE_DIR" "$REMOTE_BUNDLE_DIR" '*.bundle' "Bundles"
elif $DB_ONLY; then
  log "Mode: db only"
  scan_dir "$LOCAL_DB_DIR" "$REMOTE_DB_DIR" 'binslib.db*' "DB"
else
  log "Mode: bundles + covers + db"
  scan_dir "$LOCAL_BUNDLE_DIR" "$REMOTE_BUNDLE_DIR" '*.bundle' "Bundles"
  scan_dir "$LOCAL_COVERS_DIR" "$REMOTE_COVERS_DIR" '*.jpg' "Covers"
  scan_dir "$LOCAL_DB_DIR" "$REMOTE_DB_DIR" 'binslib.db*' "DB"
fi

# ── Phase 2: Show plan and confirm ──────────────────────────────────────────

grand_total=$((GRAND_NEW + GRAND_REPLACE))

if (( grand_total == 0 )); then
  log "Everything is up to date. Nothing to sync."
  exit 0
fi

print_plan

if ! $YES; then
  printf "Proceed with %s? [y/N]: " "$DIRECTION"
  read -r answer
  case "$answer" in
    [Yy]|[Yy][Ee][Ss]) ;;
    *)
      log "Aborted by user."
      echo "Aborted."
      exit 0
      ;;
  esac
fi

# ── Phase 3: Transfer ───────────────────────────────────────────────────────

for label in "${PLAN_LABELS[@]}"; do
  transfer_dir "$label"
done

# ── Phase 4: Restart container after DB upload ──────────────────────────────
# When the DB is uploaded, the remote binslib container must be restarted so
# the startup migration rebuilds the FTS5 index (remove_diacritics 2, đ→d
# normalization).  Without this, the uploaded DB has a stale FTS index and
# search for diacritics-stripped queries (from vbook) returns 0 results.

DB_WAS_SYNCED=false
if $DB_ONLY; then
  DB_WAS_SYNCED=true
elif ! $COVER_ONLY && ! $BUNDLE_ONLY; then
  # Full sync includes DB
  DB_WAS_SYNCED=true
fi

if $DB_WAS_SYNCED && [[ "$DIRECTION" == "upload" ]]; then
  log "Restarting binslib container to apply DB migrations (FTS rebuild)..."
  if ssh "${REMOTE_USER}@${REMOTE_HOST}" \
       "cd ${REMOTE_DOCKER_COMPOSE_DIR} && docker compose restart binslib" 2>> "$LOG_FILE"; then
    # Wait for startup and check migration output
    sleep 3
    MIGRATE_LOG=$(ssh "${REMOTE_USER}@${REMOTE_HOST}" "docker logs --tail 5 binslib 2>&1" || true)
    if echo "$MIGRATE_LOG" | grep -q "Migrations complete"; then
      log "Container restarted. Migration applied successfully."
      echo "$MIGRATE_LOG" | grep -E "FTS|Migrations" | while read -r line; do
        log "  $line"
      done
    else
      log "WARNING: Container restarted but migration status unclear. Check: docker logs binslib"
    fi
  else
    log "WARNING: Failed to restart container. Run manually: docker compose restart binslib"
  fi
fi

log "=== Sync ${DIRECTION} finished ==="
