# MTC Chapter Content Encryption - Detailed Notes

## Mobile API Encryption Format

The `/api/chapters/{id}` endpoint returns a `content` field that is:

1. A base64-encoded string
2. When decoded, gives a JSON-like envelope: `{"iv":"...","value":"...","mac":"..."}`
3. The `value` field is clean base64 → AES-CBC ciphertext (always 16-byte aligned)
4. The `mac` field is a hex HMAC string (64 chars = SHA-256)
5. The `iv` field is obfuscated (see below)

### IV Obfuscation

- IV field is 36 bytes, ends with `==` (looks like base64 padding)
- Contains 7-12 non-base64 bytes (values > 0x7F or non-alphanum/+/=) at positions ~6-17
- The remaining base64 chars should decode to the 16-byte AES IV
- BUT: simply stripping non-b64 bytes gives inconsistent lengths (25-29 chars)
- Stripping positions 6-17 always gives 24 base64 chars = 16 bytes, but decryption fails

- **The correct IV extraction method is still unknown**

### Encryption (Laravel Crypt::encrypt)

- Server uses Laravel's `Crypt::encrypt()` which uses APP_KEY
- Standard format: `base64(json({"iv": base64(16_random_bytes), "value": base64(aes_cbc_encrypted), "mac": hmac_sha256}))`
- The non-standard IV suggests either custom obfuscation or non-standard PHP JSON encoding of binary data

## Web Frontend Encryption

### Key: `aa4uCch7CR8KiBdQ`

- 16 bytes = AES-128-CBC
- Used as BOTH key and IV: `CryptoJS.AES.decrypt(cipherParams, Utf8.parse(key), {iv: Utf8.parse(key), mode: CBC, padding: Pkcs7})`
- Web content format: plain base64(ciphertext) — NO JSON envelope

### Key Extraction from JS

- JS file: `https://assets.metruyencv.com/build/assets/app-635aaa21.js`
- Obfuscated with string array rotation
- Array function: `Qx()` returns string array (216 elements)
- Rotation: 125 iterations of `arr.push(arr.shift())` to match target checksum 135572
- Lookup: `i0(n) = arr[n - 363]`
- Key construction: `i0(402) + "ch7CR" + i0(398) + "Q"` = `"aa4uC" + "ch7CR" + "8KiBd" + "Q"`
- Can be verified with Node.js (see extraction script in session)

### Web vs Mobile

- Web API (`api.lonoapp.net`) returns 404 for chapters — site shut down 2026-02-10
- Mobile API (`android.lonoapp.net`) still works but uses different encryption
- The web key does NOT decrypt mobile API content

## Key Candidates Found in libapp.so (ALL TESTED, NONE WORK)

- `5eeefca380d02919dc2c6558bb6d8a5d` (32 hex chars)
- `D1514C98ABD0E809A47D6E13F2321E26` (32 hex chars, uppercase)
- `d6031998d1b3bbfebf59cc9bbff9aee1` (32 hex chars)
- `e87579c11079f43dd824993c2cee5ed3` (32 hex chars)
- Tested as both hex-decoded (16 bytes) and raw string (32 bytes)
- Tested with: zero IV, key-as-IV, stripped-b64 IV, sliding window IV, XOR'd IV
- Also tried MD5/SHA256 derivations of web key

## App Binary Analysis

- Dart 3.5.0 (stable), arm64
- Package: `package:novelfever/`
- Key files: `models/app_config.dart`, `models/chapter.dart`, `utils/api_client.dart`
- Functions: `decryptContent`, `encryptContent`
- Model: `AppConfig` has `app_key`, `app_secret`, `adFlySecret` fields
- `/api/init` returns config but NO encryption key

## Next Steps to Get the Key

**SOLVED** — Don't need the key! The app stores DECRYPTED plaintext in its SQLite database.

### Solution: Extract from App Database

After opening a chapter in the app, decrypted text is saved to:

- **Database**: `databases/app_database.db` (inside app data dir)
- **Table**: `Chapter` — columns: `id`, `name`, `slug`, `index`, `content` (plaintext!), `nextId`, `bookId`, etc.
- **Access**: `adb shell "run-as com.novelfever.app.android.debug cat databases/app_database.db" > app.db`
- **Requires**: APK with `android:debuggable="true"` (our patched APK has this)

### Emulator Setup (working as of 2026-02-15)

- **AVD**: Medium_Phone_API_36.1 (arm64-v8a, Google APIs Play Store)
- **APK**: `apk/mtc1.4.4/aligned_emu.apk` — reflutter proxy to `10.0.2.2:8083` + `debuggable=true`
- **mitmproxy**: `mitmdump --listen-port 8083` on host Mac
- **Launch**: `adb shell am start -n com.novelfever.app.android.debug/com.example.novelfeverx.MainActivity`
- **Activity**: `com.example.novelfeverx.MainActivity`

### Possible Automation Path

1. Script the emulator to open chapters via deep links or UI automation
2. After each chapter loads, pull the database and extract content
3. [NOT FEASIBLE] Or: use the API to fetch encrypted content + extract the key from the app at runtime via Frida
