# Parallel Book Download with 2 Emulators

## Overview

Run **2 separate Android emulators**, each with its own app instance in the foreground, to double download throughput. Single-emulator parallel downloads don't work — Android throttles background app downloads after ~60s.

## Architecture

```
   emulator-5554              emulator-5556
  ┌──────────────┐          ┌──────────────┐
  │  MTC Debug   │          │  MTC Debug   │
  │  (foreground)│          │  (foreground)│
  │  ┌────────┐  │          │  ┌────────┐  │
  │  │SQLite  │  │          │  │SQLite  │  │
  │  │  DB    │  │          │  │  DB    │  │
  │  └────────┘  │          │  └────────┘  │
  └──────┬───────┘          └──────┬───────┘
         │                         │
         └───────────┬─────────────┘
                     │
            mitmproxy :8083
            (shared — reflutter hardcodes
             10.0.2.2:8083 for both)
```

**Key insight**: Each emulator has its own screen, so both apps run in the foreground simultaneously. No background throttling.

## Files

| File                                 | Purpose                                            |
| ------------------------------------ | -------------------------------------------------- |
| `~/.android/avd/Medium_Phone_2.avd/` | Second AVD config (cloned from Medium_Phone)       |
| `~/.android/avd/Medium_Phone_2.ini`  | AVD pointer file                                   |
| `crawler/grab_book.py`               | `--device` arg + `set_device()` for multi-emulator |
| `crawler/batch_grab.py`              | `--device` arg passthrough                         |
| `crawler/parallel_grab.py`           | 2-emulator parallel coordinator                    |
| `crawler/start_emulators.sh`         | Launch both emulators + mitmproxy                  |

## Setup

### 1. Start both emulators

```bash
cd crawler/
./start_emulators.sh
```

This launches:

- `Medium_Phone_API_36.1` on port 5554
- `Medium_Phone_2` on port 5556
- `mitmproxy` on port 8083 (shared by both)

### 2. Copy auth to second emulator

```bash
python3 parallel_grab.py --setup
```

This copies:

- SharedPreferences (auth token) from emu1 → emu2
- BaseBook table (bookmarks) from emu1 → emu2
- Installs APK on emu2 if needed

### 3. Verify

Open the app on emulator-5556 and check that bookmarks are visible.

## Usage

```bash
cd crawler/

# List pending books
python3 parallel_grab.py --list

# Download all pending (split across 2 emulators)
python3 parallel_grab.py

# Download first 4 books (2 per emulator)
python3 parallel_grab.py --limit 4

# Single-emulator mode still works
python3 grab_book.py "book name"
python3 grab_book.py "book name" --device emulator-5556
python3 batch_grab.py --device emulator-5556
```

## How parallel_grab.py works

1. Reads bookmarks from emulator-5554's DB
2. Filters out already-extracted books
3. Pre-fetches chapter counts from API (single-threaded)
4. Splits books round-robin into 2 queues
5. Spawns 2 `multiprocessing.Process` workers:
   - Process 1 → `set_device("emulator-5554")` → downloads odd books
   - Process 2 → `set_device("emulator-5556")` → downloads even books
6. Each process runs fully independently (separate emulator, no UI conflicts)
7. Collects results via `multiprocessing.Queue` and prints summary

## Risks & Mitigations

- **RAM**: 2 emulators × ~2GB = ~4GB. May slow down Mac.
- **mitmproxy**: Both emulators share the same proxy (reflutter hardcodes `10.0.2.2:8083`). Works fine.
- **Port allocation**: `-port 5554` and `-port 5556` use separate ADB pairs, no conflicts.
- **No UI conflicts**: Each emulator has its own screen. Workers are fully independent.
- **Temp files**: Each device uses unique paths (`/tmp/mtc_grab_emulator-5554.db` vs `emulator-5556`).
- **Output dir**: Shared `output/` — book IDs are unique, no collisions.
- **NEVER force-stop**: Force-stop breaks bookmark search. Use BACK presses via `launch_app()`.
- **Download queue bloat**: Workers call `clear_download_queue()` before each book to prevent ANR.

## Troubleshooting

1. **Emulator won't start**: Check RAM. Try closing other apps. Run `./start_emulators.sh`.
2. **Auth missing on emu2**: Re-run `python3 parallel_grab.py --setup`.
3. **Downloads stall**: Check mitmproxy is running on :8083.
4. **App freezes**: Download queue may be bloated. The worker clears it automatically, but if needed manually:
   - Pull SharedPrefs, remove `flutter.downloadQueueWithId`, push back.
5. **Books not found in search on emu2**: Bookmarks may not have synced. Re-run `--setup`.
