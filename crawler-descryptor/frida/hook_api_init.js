/**
 * Intercept the /api/init HTTP response to check if the encryption key
 * is delivered dynamically at app startup via AppConfig.
 *
 * Hooks both BoringSSL's SSL_read (for raw TLS data) and Dart's HTTP layer.
 * The most reliable approach is to read the decrypted HTTP response after
 * TLS termination inside the app.
 *
 * Usage:
 *   frida -D emulator-5558 -n com.novelfever.app.android.debug -l hook_api_init.js
 *
 * Then launch/restart the app — /api/init is called on startup.
 */

"use strict";

const LIB = "libflutter.so";
const CAPTURE_BYTES = 8192;

function tryReadUtf8(buf, len) {
    try {
        return buf.readUtf8String(len);
    } catch (_) {
        try {
            const bytes = new Uint8Array(buf.readByteArray(len));
            return String.fromCharCode.apply(null, bytes);
        } catch (_) {}
    }
    return null;
}

function hookSSLRead() {
    // SSL_read is called after TLS decryption — gives us plaintext HTTP responses
    const syms = Module.enumerateExports(LIB).filter(
        e => e.name === "SSL_read" || e.name === "SSL_read_ex"
    );

    // Buffer to accumulate response fragments
    let responseBuffer = "";
    let capturing = false;

    for (const sym of syms) {
        console.log("[*] Hooking " + sym.name + " @ " + sym.address);
        Interceptor.attach(sym.address, {
            onEnter(args) {
                this.buf = args[1];
                this.len = sym.name === "SSL_read_ex" ? args[3] : null;
            },
            onLeave(retval) {
                const n = retval.toInt32();
                if (n <= 0) return;

                const text = tryReadUtf8(this.buf, Math.min(n, CAPTURE_BYTES));
                if (!text) return;

                // Check for /api/init response
                if (text.indexOf("api/init") !== -1 || text.indexOf("app_key") !== -1 ||
                    text.indexOf("app_secret") !== -1 || text.indexOf("adFlySecret") !== -1) {
                    console.log("\n============ /api/init RESPONSE ============");
                    console.log(text.substring(0, 4096));
                    console.log("============================================\n");
                    capturing = false;
                }

                // Look for JSON bodies that might contain config
                if (text.indexOf('"success"') !== -1 && text.indexOf('"data"') !== -1) {
                    // Try to extract JSON body from HTTP response
                    const jsonStart = text.indexOf("{");
                    if (jsonStart !== -1) {
                        const body = text.substring(jsonStart);
                        if (body.indexOf("app_key") !== -1 || body.indexOf("encrypt") !== -1 ||
                            body.indexOf("secret") !== -1 || body.indexOf("config") !== -1) {
                            console.log("\n============ CONFIG-LIKE RESPONSE ============");
                            console.log(body.substring(0, 4096));
                            console.log("==============================================\n");
                        }
                    }
                }

                // Also capture any chapter content responses
                if (text.indexOf('"content"') !== -1 && text.indexOf('"Chapter"') !== -1) {
                    console.log("\n============ CHAPTER RESPONSE ============");
                    console.log(text.substring(0, 2048));
                    console.log("==========================================\n");
                }
            }
        });
    }
}

function hookSSLWrite() {
    // Also hook SSL_write to see outgoing requests (to correlate with responses)
    const syms = Module.enumerateExports(LIB).filter(
        e => e.name === "SSL_write" || e.name === "SSL_write_ex"
    );

    for (const sym of syms) {
        console.log("[*] Hooking " + sym.name + " @ " + sym.address);
        Interceptor.attach(sym.address, {
            onEnter(args) {
                const len = args[2].toInt32();
                if (len <= 0 || len > CAPTURE_BYTES) return;

                const text = tryReadUtf8(args[1], len);
                if (!text) return;

                // Log outgoing HTTP requests
                if (text.indexOf("GET /api/") !== -1 || text.indexOf("POST /api/") !== -1) {
                    const firstLine = text.split("\n")[0];
                    console.log("[REQ] " + firstLine.trim());
                }
            }
        });
    }
}

function main() {
    console.log("[*] crawler-descryptor: API init interceptor loaded");
    console.log("[*] Restart the app to capture /api/init response");

    const mod = Process.findModuleByName(LIB);
    if (mod) {
        console.log("[*] " + LIB + " already loaded");
        hookSSLRead();
        hookSSLWrite();
    } else {
        const interval = setInterval(function () {
            const m = Process.findModuleByName(LIB);
            if (m) {
                clearInterval(interval);
                console.log("[*] " + LIB + " loaded");
                hookSSLRead();
                hookSSLWrite();
            }
        }, 500);
    }
}

main();
