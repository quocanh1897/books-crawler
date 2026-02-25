#!/usr/bin/env bash
set -euo pipefail

# ── Argument parsing ────────────────────────────────────────────────────────

DIRECTION=""
COVER_ONLY=false
BUNDLE_ONLY=false

for arg in "$@"; do
  case "$arg" in
    --cover-only)  COVER_ONLY=true ;;
    --bundle-only) BUNDLE_ONLY=true ;;
    upload|download)
      if [[ -n "$DIRECTION" ]]; then
        echo "ERROR: direction specified twice" >&2; exit 1
      fi
      DIRECTION="$arg"
      ;;
    -h|--help)
      cat <<EOF
Usage: $0 [upload|download] [--cover-only] [--bundle-only]

Sync bundle files and cover images between local and remote.

Positional:
  upload      Push local files to server (default)
  download    Pull server files to local

Options:
  --cover-only    Only sync covers (binslib/public/covers/*.jpg)
  --bundle-only   Only sync bundles (binslib/data/compressed/*.bundle)
  -h, --help      Show this help and exit

By default, syncs both bundles and covers.
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [upload|download] [--cover-only] [--bundle-only]" >&2
      exit 1
      ;;
  esac
done

DIRECTION="${DIRECTION:-upload}"

if $COVER_ONLY && $BUNDLE_ONLY; then
  echo "ERROR: --cover-only and --bundle-only are mutually exclusive" >&2
  exit 1
fi

# ── Config ──────────────────────────────────────────────────────────────────

REMOTE_USER="alex"
REMOTE_HOST="central7567.binscode.site"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BATCH_SIZE=500

LOCAL_BUNDLE_DIR="${PROJECT_ROOT}/binslib/data/compressed"
REMOTE_BUNDLE_DIR="/data/mtc/binslib/data/compressed"

LOCAL_COVERS_DIR="${PROJECT_ROOT}/binslib/public/covers"
REMOTE_COVERS_DIR="/data/mtc/binslib/public/covers"

LOG_FILE="${SCRIPT_DIR}/sync-bundles-${DIRECTION}.log"

# ── Helpers ─────────────────────────────────────────────────────────────────

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo "$msg"
  echo "$msg" >> "$LOG_FILE"
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

# sync_dir <local_dir> <remote_dir> <glob_pattern> <label>
# Compares src vs dst by file size, then rsyncs in batches.
sync_dir() {
  local local_dir="$1" remote_dir="$2" pattern="$3" label="$4"
  local label_lc; label_lc=$(echo "$label" | tr A-Z a-z)

  log "--- ${label} ${DIRECTION} ---"
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

  local to_sync_list; to_sync_list=$(mktemp)
  local skipped=0 queued=0

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
    if (( dst_size >= src_size )); then
      skipped=$((skipped + 1))
      continue
    fi
    if (( dst_size > 0 )); then
      if [[ "$DIRECTION" == "upload" ]]; then
        log "REPLACE ${fname}: remote=${dst_size} < local=${src_size}"
      else
        log "REPLACE ${fname}: local=${dst_size} < remote=${src_size}"
      fi
    fi
    echo "$fname" >> "$to_sync_list"
    queued=$((queued + 1))
  done < "$joined"

  rm -f "${src_list}.sorted" "${dst_list}.sorted" "$joined"
  log "${label} to ${DIRECTION}: ${queued}, skipped (dst >= src): ${skipped}"

  if (( queued == 0 )); then
    log "${label}: nothing to ${DIRECTION}. Already up to date."
    rm -f "$local_list" "$remote_list" "$to_sync_list"
    return 0
  fi

  # ── Batched rsync ─────────────────────────────────────────────────────

  local transferred=0 failed=0 total=$queued batch_num=0

  while true; do
    local offset=$((batch_num * BATCH_SIZE))
    if (( offset >= total )); then break; fi

    local batch_files; batch_files=$(sed -n "$((offset + 1)),$((offset + BATCH_SIZE))p" "$to_sync_list")
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

  log "${label} done: ${DIRECTION}ed=${transferred}, skipped=${skipped}, failed=${failed}"
  rm -f "$local_list" "$remote_list" "$to_sync_list"
}

# ── Main ────────────────────────────────────────────────────────────────────

log "=== Sync ${DIRECTION} started ==="

if $COVER_ONLY; then
  log "Mode: covers only"
  sync_dir "$LOCAL_COVERS_DIR" "$REMOTE_COVERS_DIR" '*.jpg' "Covers"
elif $BUNDLE_ONLY; then
  log "Mode: bundles only"
  sync_dir "$LOCAL_BUNDLE_DIR" "$REMOTE_BUNDLE_DIR" '*.bundle' "Bundles"
else
  log "Mode: bundles + covers"
  sync_dir "$LOCAL_BUNDLE_DIR" "$REMOTE_BUNDLE_DIR" '*.bundle' "Bundles"
  sync_dir "$LOCAL_COVERS_DIR" "$REMOTE_COVERS_DIR" '*.jpg' "Covers"
fi

log "=== Sync ${DIRECTION} finished ==="
