# MTC Project Knowledge

## Project Goal

Crawl data from metruyencv.net (online book reading platform) which is only accessible via mobile app.

## App Details

- **App name**: MTC (displayed as "Novel Fever" in Play Store)
- **Package**: `com.novelfever.app.android`
- **Framework**: Flutter app with split APKs (base + arm64_v8a + vi + xxhdpi)
- **Dart version**: 3.5.0 (stable), arm64
- **App package**: `package:novelfever/`
- **Main activity**: `com.example.novelfeverx.MainActivity`
- **Key**: Flutter uses BoringSSL in `libflutter.so` — ignores Android system proxy AND user CA certificates

## What Worked: reflutter + mitmproxy + Patched APK

### The Problem Chain

1. Android system proxy → Flutter ignores it (only Java SDKs use it)
2. User CA certificates → Flutter's BoringSSL ignores `network_security_config.xml`
3. WireGuard VPN mode → blocked by managed Mac firewall (UDP)
4. Env var injection (`http_proxy`) → Flutter release mode ignores it
5. **reflutter** patching `libflutter.so` → WORKS

### Working Setups

**Physical phone setup:**

- mitmproxy on Mac port **8083** (reflutter default)
- Patched APK proxying to `192.168.1.12:8083`
- Phone proxy: `adb shell settings put global http_proxy 192.168.1.12:8083`

**Emulator setup (preferred — no phone needed):**

- AVD: `Medium_Phone_API_36.1` (arm64-v8a, Google APIs Play Store)
- Patched APK proxying to `10.0.2.2:8083` (emulator host loopback)
- mitmproxy: `mitmdump --listen-port 8083` on host Mac
- Launch: `~/Library/Android/sdk/emulator/emulator -avd Medium_Phone_API_36.1`
- Start app: `adb shell am start -n com.novelfever.app.android.debug/com.example.novelfeverx.MainActivity`

## APK Patching Process

### For physical phone (proxy to 192.168.1.12)

```bash
echo "192.168.1.12" | reflutter combined.apk
```

### For emulator (proxy to 10.0.2.2)

```bash
echo "10.0.2.2" | reflutter combined_emu.apk
# Note: reflutter zero-pads to "012.000.002.002" — 012 octal = 10 decimal, this is correct
```

### Full rebuild steps

1. Decompile: `apktool d base.apk -o decoded`
2. Merge native libs from split APK
3. Patch libflutter.so with reflutter
4. Modify AndroidManifest.xml:
   - `android:debuggable="true"` (enables `run-as` for DB extraction)
   - `android:allowBackup="true"`
   - `android:extractNativeLibs="true"`
   - Change package to `.debug` suffix
   - Remove split requirements
5. Rebuild: `apktool b decoded/ -o patched.apk`
6. Zipalign THEN sign:
   ```
   ~/Library/Android/sdk/build-tools/34.0.0/zipalign -p 4 patched.apk aligned.apk
   ~/Library/Android/sdk/build-tools/34.0.0/apksigner sign --ks ../debug.keystore --ks-pass pass:android aligned.apk
   ```

## API Findings (tested 2026-02-15, updated 2026-02-16)

- **x-signature NOT validated** — can be omitted entirely; only Bearer token needed
- **Chapter navigation**: each chapter response has `next: {id, name, index}` — no chapter-list endpoint needed
- **Base URL**: `https://android.lonoapp.net`
- **Key endpoints**: `/api/books/ranking`, `/api/books?filter[...]`, `/api/books/search`, `/api/chapters/{id}`, `/api/init`, `/api/account`
- **Content is encrypted** — API returns AES-CBC encrypted chapter content in Laravel envelope
- **Search endpoints** (added 2026-02-16):
  - `filter[keyword]` on `/api/books` — exact keyword match
  - `/api/books/search?keyword=` — fuzzy search, more results

## Chapter Content Encryption — SOLVED

- **Mobile API returns encrypted content** in Laravel format: `base64(json({"iv":"...", "value":"...", "mac":"..."}))`
- **Web JS key**: `aa4uCch7CR8KiBdQ` — does NOT work for mobile API (different key)
- **Mobile key**: NOT in APK binary, NOT in API responses — unknown
- **SOLUTION**: The app stores **DECRYPTED plaintext** in its local SQLite database after opening a chapter
  - Database: `databases/app_database.db`
  - Table: `Chapter` — columns: `id`, `name`, `content` (plaintext!), `nextId`, `bookId`, etc.
  - Extract: `adb shell "run-as com.novelfever.app.android.debug cat databases/app_database.db" > app.db`
  - Requires: APK with `android:debuggable="true"` (our patched APK has this)
- **See**: `ENCRYPTION.md` for full analysis details

## Crawler & Extraction Tools (2026-02-16)

- **Location**: `/Users/alenguyen/Documents/mtc/crawler/`
- **`grab_book.py`**: Main script — end-to-end automated: API search → app UI search → trigger download → monitor DB → extract plaintext
  - Usage: `python3 grab_book.py "Book Name"`
  - Uses API search (`filter[keyword]`) to find book ID and chapter count
  - Opens app search, types ASCII-approximated name (diacritics-insensitive)
  - Triggers download via 3-dot menu → Tải truyện → fill dialog → TAB TAB ENTER
  - Monitors DB and extracts chapters to `output/<book_id>/` (individual + combined txt)
- **`config.py`**: API configuration (base URL, bearer token, headers)
- **`extract_book.py`**: Standalone DB extraction — monitors DB + extracts after manual download trigger
  - Usage: `python3 extract_book.py <book_id> [total_chapters]`
- **Python 3.9 compat**: uses `from __future__ import annotations`
- Obsolete scripts deleted (2026-02-16): `crawler.py`, `auto_download.py`, `smart_download.py`, `download_book.py`, `emu_crawler.py`

## Working Download Workflow

**Automated (preferred):**
```bash
python3 grab_book.py "book name"    # fully automated end-to-end
```

**Manual fallback:**
1. Start emulator + mitmproxy
2. Open app → Đánh dấu tab → 3-dot → Tải truyện → enter range → Đồng ý
3. Run `python3 extract_book.py <book_id> <total>` to extract

### Flutter UI Automation — Lessons Learned

- **Dialog buttons**: use **TAB TAB ENTER** (direct taps on Flutter buttons are unreliable)
- **Dialog focus**: dialog opens with focus on title → TAB once to reach first input field
- **Search icon**: magnifying glass at (882, 122); search field at (350, 68)
- **Tab context**: must be on "Đánh dấu" tab BEFORE opening search (otherwise defaults to empty "Lịch sử")
- **3-dot icon**: tap at x≈1008 (consistent), y varies per entry — around y≈411 for first result
- **Tải truyện**: y≈2040 in bottom sheet
- **Text input**: `adb shell input text` only handles ASCII — strip diacritics with `unicodedata.normalize("NFKD")`
- **Short queries**: use first 4 words only — avoids issues with commas/special chars in `adb input text`
- **DO NOT press BACK** after confirming download — it closes the app and stops the download
- **TAB navigation in Flutter**: only works within dialogs; on regular pages it jumps to bottom nav bar
- **Clipboard paste**: does NOT work (macOS → emulator clipboard sync broken, KEYCODE_PASTE fails)
- **Invalid chapter range**: silently fails — must use exact chapter count

## Files Location

- APK source: `apk/mtc1.4.4/`
- Decoded APK: `apk/mtc1.4.4/decoded/`
- Phone APK: `apk/mtc1.4.4/aligned_ssl.apk` (proxy to 192.168.1.12)
- Emulator APK: `apk/mtc1.4.4/aligned_emu.apk` (proxy to 10.0.2.2)
- Debug keystore: `apk/debug.keystore` (pass: android)
- Crawler: `crawler/grab_book.py`, `crawler/config.py`, `crawler/extract_book.py`
- Encryption analysis: `ENCRYPTION.md`
- API docs: `API.md`

## Downloaded Books

| Book | ID | Chapters | Date |
|------|----|----------|------|
| Hủ Bại Thế Giới | 148610 | 256 | 2026-02-16 |
| Cẩu Tại Võ Đạo Thế Giới Thành Thánh | 144812 | 1050 | 2026-02-15 |
| (book 145005) | 145005 | 961 | 2026-02-15 |
| (book 137544) | 137544 | 712 | 2026-02-15 |

## Platform Compatibility

**Currently macOS-only.** The crawler has 5 blockers preventing Windows use:
1. Hardcoded macOS ADB path (`~/Library/Android/sdk/...`)
2. Hardcoded `/tmp/` temp paths (6 occurrences across 3 files)
3. `multiprocessing.get_context('fork')` — Windows only supports `spawn`
4. `sips` command (macOS-only image tool)
5. `start_emulators.sh` (Bash script)

See `crawler/WINDOWS_MIGRATION.md` for the full migration plan (~3 hours of code changes).

## Key Gotchas

- **Flutter ignores everything**: system proxy, env vars, user CAs, network_security_config.xml
- reflutter requires Python 3.10+ (3.9 fails with type union syntax)
- reflutter hardcodes proxy port to **8083**
- Must zipalign BEFORE apksigner (not after)
- System Python is 3.9 — use `from __future__ import annotations` for type hints
- Emulator host IP is `10.0.2.2` (not localhost)
- Google Play emulator images don't have root — use `android:debuggable="true"` + `run-as` instead

## Tools Used

- `mitmproxy` (v12.2.1) — HTTPS traffic interception
- `apktool` — APK decompile/rebuild
- `reflutter` (v0.8.6, Python 3.13) — Flutter SSL bypass
- `apksigner` / `zipalign` (Android SDK build-tools 34.0.0)
- `adb` — Android Debug Bridge
- Android emulator (SDK 36.1, arm64)
- `frida` (17.7.2) — installed but limited on non-root emulator
- `pycryptodome` — AES decryption testing
