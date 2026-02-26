# crawler-descryptor — Plan

## Problem

The mobile API (`android.lonoapp.net/api/chapters/{id}`) returns chapter content encrypted with AES-CBC in a Laravel envelope format (`{iv, value, mac}`). The current crawler bypasses this by running an Android emulator, letting the app decrypt chapters internally, then extracting plaintext from the app's SQLite DB via `adb`.

This is slow (~1 chapter/second at best), fragile (depends on emulator + UI automation), and heavy (requires a full Android emulator stack).

**Goal**: Reverse-engineer the decryption so we can call the API directly and decrypt content in-process — enabling a pure HTTP-based crawler that's orders of magnitude faster.

## What We Know

- Server uses Laravel `Crypt::encrypt()` → AES-CBC with JSON envelope: `base64(json({iv, value, mac}))`
- The `iv` field is **obfuscated**: 36 bytes with non-base64 bytes injected around positions 6–17; correct extraction method unknown
- The `value` field is clean base64 → AES-CBC ciphertext (16-byte aligned)
- The `mac` field is 64-char hex HMAC-SHA256
- Web key (`aa4uCch7CR8KiBdQ`) does NOT decrypt mobile API content
- 4 key candidates from `libapp.so` were tested — none work (tested as hex-decoded and raw, with every IV variant)
- The app is **Flutter/Dart 3.5** with `decryptContent` / `encryptContent` functions in `libapp.so`
- `AppConfig` model has `app_key`, `app_secret`, `adFlySecret` fields
- `/api/init` returns config — needs re-examination for encryption key
- Frida v17.7.2 is installed but limited on the non-root emulator
- The patched APK has `android:debuggable="true"`

## Emulator Isolation — CRITICAL

The production crawler runs on **two emulators** (ports `5554` and `5556`) that must NOT be touched at any time. All Frida/testing work in this project uses a **separate third emulator** on a different port (e.g. `5558`).

Rules:

- **NEVER** `adb connect`, `adb shell`, `adb install`, or target devices on ports `5554` / `5556`
- Always launch a dedicated AVD for this project (e.g. `Medium_Phone_API_36_frida`)
- Always specify the device explicitly: `adb -s emulator-5558 ...`, `frida -D emulator-5558 ...`
- Scripts must accept a `--device` / `-s` flag and default to `emulator-5558` — never auto-detect or use the first available device
- If an `adb` command doesn't include `-s`, it's a bug

## Approach: Three Phases

### Phase 1 — Dynamic Key Extraction via Frida

Hook the running app's cryptographic operations at runtime to capture the actual key, IV derivation, and plaintext.

#### Why Frida

The key isn't in the APK binary (tested all candidates from `libapp.so`). It's likely:

- Fetched from the server at runtime (`/api/init` → `AppConfig.app_key`), or
- Derived at runtime from multiple components

Frida can intercept the actual decryption call with all parameters resolved.

#### Tasks

1. **Launch a dedicated third emulator** — Create or reuse an AVD (e.g. `Medium_Phone_API_36_frida`) on port `5558`. Keep it completely separate from the crawler's `5554`/`5556` emulators.
2. **Embed Frida gadget into the patched APK** — Since the emulator isn't rooted, inject `libfrida-gadget.so` + config into the APK's lib directory. This lets Frida attach without root. Install this APK only on the `5558` emulator.
3. **Hook BoringSSL AES functions** — Flutter uses BoringSSL inside `libflutter.so`. Hook:
   - `EVP_DecryptInit_ex` → capture key and IV bytes
   - `EVP_DecryptUpdate` → capture ciphertext input
   - `EVP_DecryptFinal_ex` → capture plaintext output
4. **Hook Dart-level `decryptContent`** — Locate and hook the Dart function in `libapp.so` to see its input (encrypted envelope) and output (plaintext)
5. **Intercept `/api/init` response** — Capture the full response body to check if the encryption key is delivered dynamically at app startup
6. **Collect sample pairs** — For every chapter decrypted at runtime, log both the encrypted API response and the decrypted plaintext. These become test fixtures.

#### Deliverables

- Frida scripts (JS) for each hook target
- Extracted key material (raw bytes)
- Documented IV extraction algorithm
- Sample encrypted/decrypted pairs for validation

### Phase 2 — Build Decryption Library

Once Phase 1 yields the key and IV logic:

1. **Core decryption module** (`decrypt.py`):
   - Parse Laravel envelope: base64 decode → JSON → extract `iv`, `value`, `mac`
   - De-obfuscate IV (based on Phase 1 findings)
   - Verify HMAC-SHA256 MAC
   - AES-CBC decrypt + PKCS7 unpad
2. **API client** (`client.py`):
   - Fetch chapter content: `GET /api/chapters/{id}`
   - Sequential chapter traversal using `next` field from each response
   - Book metadata lookup (reuse existing API knowledge from `API.md`)
   - Rate limiting, retry with backoff (Cloudflare is in front)
3. **CLI entry point** (`main.py`):
   - `fetch-chapter <chapter_id>` — fetch + decrypt one chapter
   - `fetch-book <book_id>` — fetch all chapters of a book, decrypt, save
   - Progress bar, resume from last fetched chapter

### Phase 3 — Integration

1. **Output format** — Write to `crawler/output/{book_id}/{index}.txt` + `metadata.json`, matching the existing format so `binslib/scripts/import.ts` works unchanged
2. **Config** — Reuse `crawler/config.py` for API base URL and bearer token
3. **Benchmark** — Compare speed vs emulator-based extraction
4. **Key rotation plan** — Document how to re-run Frida extraction if the key changes

## Tech Stack

| Component | Choice               | Reason                                 |
| --------- | -------------------- | -------------------------------------- |
| Language  | Python 3.9+          | Matches crawler, system Python         |
| HTTP      | `httpx`              | Already used in crawler, async support |
| Crypto    | `pycryptodome`       | Already installed, AES-CBC + HMAC      |
| Frida     | `frida-tools` 17.7.2 | Already installed                      |
| CLI       | `argparse`           | No extra deps needed                   |

## Project Structure

```
crawler-descryptor/
├── PLAN.md                     # This file
├── README.md                   # Setup & usage instructions
├── requirements.txt
├── main.py                     # CLI entry point
├── src/
│   ├── __init__.py
│   ├── decrypt.py              # AES-CBC decryption + envelope parsing
│   ├── iv_extract.py           # IV de-obfuscation logic
│   ├── client.py               # API client (fetch chapters/books)
│   └── utils.py                # Shared helpers
├── frida/
│   ├── hook_boringssl.js       # BoringSSL EVP_Decrypt* hooks
│   ├── hook_dart_decrypt.js    # Dart decryptContent hook
│   ├── hook_api_init.js        # Intercept /api/init response
│   └── gadget-config.json      # Frida gadget embedding config
└── tests/
    ├── test_decrypt.py         # Validate against known plaintext pairs
    └── samples/                # Encrypted + decrypted chapter pairs
```

## Risks

| Risk                                        | Likelihood     | Mitigation                                                                            |
| ------------------------------------------- | -------------- | ------------------------------------------------------------------------------------- |
| Accidentally disrupting production crawlers | **Must avoid** | All scripts default to `emulator-5558`; `-s` flag required; never auto-detect devices |
| Key is per-session (fetched fresh at login) | Medium         | Hook `/api/init` and auth flow; replicate session setup if needed                     |
| Key rotates over time                       | Low            | Document Frida re-extraction workflow                                                 |
| IV obfuscation varies per chapter           | High (likely)  | Collect many samples via Frida to identify the pattern                                |
| Frida gadget injection breaks the APK       | Low            | Test incrementally; fallback to `frida-server` with Magisk if needed                  |
| Cloudflare blocks rapid API calls           | Medium         | Adaptive rate limiting, randomized delays                                             |
| MAC verification uses a separate key        | Medium         | Hook HMAC calls too; Laravel typically uses same APP_KEY                              |

## Execution Order

1. Scaffold project directory and files
2. Create/configure a third AVD (`Medium_Phone_API_36_frida`) on port `5558`
3. Write Frida BoringSSL hook script (highest value — captures everything)
4. Write helper script to collect encrypted/decrypted sample pairs from existing data
5. Patch APK with Frida gadget, install on `emulator-5558` only, test hooks
6. Extract key + IV algorithm
7. Implement `decrypt.py` + `iv_extract.py`
8. Implement `client.py` + `main.py`
9. Test end-to-end: fetch a known chapter via API → decrypt → compare with crawler output
10. Integration with existing output format
