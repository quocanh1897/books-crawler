# Windows 11 Migration Plan

## Current State

The crawler was built and tested on macOS. It has **5 critical blockers** preventing it from running on Windows 11.

## Critical Issues

### 1. Hardcoded macOS ADB path

**Files:** `grab_book.py:35`, `parallel_grab.py:26`, `extract_book.py:22`

**Current:**

```python
ADB = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
```

**Fix:** Create a platform-aware `find_adb()` function in `config.py`:

```python
import shutil, platform

def find_adb() -> str:
    # 1. Check PATH first (works if user added SDK to PATH)
    adb = shutil.which("adb")
    if adb:
        return adb
    # 2. Platform-specific default locations
    if platform.system() == "Windows":
        localappdata = os.environ.get("LOCALAPPDATA", "")
        candidate = os.path.join(localappdata, "Android", "Sdk", "platform-tools", "adb.exe")
    else:  # macOS / Linux
        candidate = os.path.expanduser("~/Library/Android/sdk/platform-tools/adb")
    if os.path.isfile(candidate):
        return candidate
    raise FileNotFoundError("adb not found. Add Android SDK platform-tools to PATH.")
```

Then replace `ADB = ...` in all 3 files with `from config import find_adb; ADB = find_adb()`.

**Effort:** ~30 min

---

### 2. Hardcoded `/tmp/` paths

**Files:** `grab_book.py:80,161,226`, `parallel_grab.py:48,179`, `extract_book.py:29`

**Current:**

```python
db_path = f"/tmp/mtc_grab_{DEVICE}.db"
path = f"/tmp/mtc_{tag}_{int(time.time())}.png"
```

**Fix:** Replace all `/tmp/` with `tempfile.gettempdir()`:

```python
import tempfile
db_path = os.path.join(tempfile.gettempdir(), f"mtc_grab_{DEVICE}.db")
```

This returns `C:\Users\<user>\AppData\Local\Temp` on Windows and `/tmp` on macOS/Linux.

**Effort:** ~15 min (6 occurrences, mechanical replacement)

---

### 3. `multiprocessing.get_context('fork')` (parallel_grab.py:425)

**Current:**

```python
ctx = multiprocessing.get_context('fork')
```

**Problem:** Windows only supports `spawn` — calling `get_context('fork')` raises `ValueError`.

**Why `fork` was used:** On macOS, the default `spawn` context creates child processes that don't inherit the parent's stdout, so print output was lost. `fork` copies the parent process entirely, preserving stdout.

**Fix:**

```python
import platform
if platform.system() == "Windows":
    ctx = multiprocessing.get_context('spawn')
else:
    ctx = multiprocessing.get_context('fork')
```

On Windows, `spawn` is the only option. The stdout issue from macOS doesn't apply on Windows — `spawn` works normally there. The `sys.stdout.reconfigure(line_buffering=True)` call in the worker function will still help with buffering.

**Effort:** ~15 min

---

### 4. `sips` command (macOS-only image tool) — grab_book.py:170

**Current:**

```python
subprocess.run(["sips", "-s", "format", "bmp", path, "--out", bmp], capture_output=True)
```

This converts PNG screenshots to BMP for analysis. `sips` is a macOS-only tool.

**Fix options (pick one):**

**Option A — Pillow (recommended):**

```python
from PIL import Image
img = Image.open(path)
img.save(bmp, "BMP")
```

Adds `Pillow` as a dependency but works cross-platform. Install: `pip install Pillow`

**Option B — Read PNG directly:**
The BMP conversion exists to read raw pixel data. If we switch to Pillow for pixel reading too, we can skip BMP entirely:

```python
from PIL import Image
img = Image.open(path)
pixels = list(img.getdata())
```

This eliminates the conversion step entirely.

**Effort:** ~30 min (including testing screenshot analysis still works)

---

### 5. `start_emulators.sh` — entire file is Bash

**Current:** 70-line Bash script using `pgrep`, `grep`, `tr`, background `&`, macOS paths.

**Fix:** Rewrite as `start_emulators.py` (Python, cross-platform):

Key changes needed:

- Use `find_adb()` and platform-aware emulator path
- Replace `pgrep -f "mitmdump"` with `subprocess` + process listing
- Replace `grep -q` with Python string matching
- Replace `&` background with `subprocess.Popen()`
- Replace `tr -d '\r'` with `.strip()`

Also create `start_emulators.ps1` (PowerShell) as an alternative for users who prefer it.

**Effort:** ~1 hour

---

## Minor Issues (nice-to-have)

### 6. Filename sanitization

Windows forbids `< > : " / \ | ? *` in filenames. Chapter titles could contain `:` or `?`.

**Fix:** Add to the filename sanitization function:

```python
if platform.system() == "Windows":
    name = re.sub(r'[<>:"/\\|?*]', '_', name)
```

**Effort:** ~10 min

### 7. Python command name

macOS/Linux uses `python3`, Windows often uses `python` or `py`.

**Fix:** Documentation only — tell Windows users to use `python` instead of `python3`.

---

## Implementation Order

1. **`config.py`** — add `find_adb()` and `get_temp_path()` helpers
2. **`grab_book.py`** — replace ADB path, `/tmp/` paths, `sips` → Pillow
3. **`extract_book.py`** — replace ADB path, `/tmp/` path
4. **`parallel_grab.py`** — replace ADB path, `/tmp/` paths, fork → spawn on Windows
5. **`batch_grab.py`** — no changes needed (inherits from grab_book.py)
6. **`start_emulators.py`** — rewrite shell script in Python
7. **Test on Windows** — verify end-to-end with Windows emulator

## New Dependency

- `Pillow` — for cross-platform image handling (replaces macOS `sips`)

Add to a new `requirements.txt`:

```
httpx
uiautomator2
requests
Pillow
```

## Windows Setup Guide (for docs)

1. Install Android Studio → SDK + emulator + platform-tools
2. Add `%LOCALAPPDATA%\Android\Sdk\platform-tools` to PATH
3. Create AVD (arm64 or x86_64 image with Google APIs)
4. Install Python 3.9+ from python.org
5. `pip install -r crawler/requirements.txt`
6. Patch APK with reflutter (same process, just use `python` not `python3`)
7. Install patched APK on emulator
8. Run: `python grab_book.py "book name"`

## Estimated Total Effort

~3 hours for all code changes + ~1 hour for testing on Windows.
