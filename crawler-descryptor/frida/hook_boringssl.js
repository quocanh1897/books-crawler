/**
 * Hook BoringSSL's EVP_Decrypt* functions inside libflutter.so to capture
 * the AES key, IV, ciphertext, and resulting plaintext at decryption time.
 *
 * Usage:
 *   frida -D emulator-5558 -n com.novelfever.app.android.debug -l hook_boringssl.js
 *
 * Then open a chapter in the app — the hook will dump all AES decryption params.
 */

"use strict";

const LIB = "libflutter.so";

function hexdump(buf, len) {
    const bytes = new Uint8Array(buf.readByteArray(len));
    return Array.from(bytes).map(b => ("0" + b.toString(16)).slice(-2)).join(" ");
}

function tryReadUtf8(buf, len) {
    try {
        const bytes = new Uint8Array(buf.readByteArray(len));
        const str = String.fromCharCode.apply(null, bytes);
        if (/^[\x20-\x7e\n\r\t]+$/.test(str)) return str;
    } catch (_) {}
    return null;
}

// State tracking per EVP_CIPHER_CTX pointer
const ctxState = {};

function hookDecryptInit() {
    // int EVP_DecryptInit_ex(EVP_CIPHER_CTX *ctx, const EVP_CIPHER *type,
    //                        ENGINE *impl, const unsigned char *key,
    //                        const unsigned char *iv)
    const syms = Module.enumerateExports(LIB).filter(
        e => e.name.indexOf("EVP_DecryptInit") !== -1
    );

    for (const sym of syms) {
        console.log("[*] Hooking " + sym.name + " @ " + sym.address);
        Interceptor.attach(sym.address, {
            onEnter(args) {
                const ctx = args[0];
                const key = args[3];
                const iv = args[4];
                const ctxKey = ctx.toString();

                if (!key.isNull()) {
                    // AES-128 = 16 bytes, AES-256 = 32 bytes — dump both
                    const keyHex16 = hexdump(key, 16);
                    const keyHex32 = hexdump(key, 32);
                    console.log("\n========== EVP_DecryptInit_ex ==========");
                    console.log("[KEY-16] " + keyHex16);
                    console.log("[KEY-32] " + keyHex32);
                    console.log("[KEY-STR-16] " + JSON.stringify(key.readCString(16)));
                    console.log("[KEY-STR-32] " + JSON.stringify(key.readCString(32)));

                    ctxState[ctxKey] = { key16: keyHex16, key32: keyHex32 };
                }
                if (iv && !iv.isNull()) {
                    const ivHex = hexdump(iv, 16);
                    console.log("[IV]     " + ivHex);
                    if (ctxState[ctxKey]) ctxState[ctxKey].iv = ivHex;
                }
            },
            onLeave(retval) {}
        });
    }
}

function hookDecryptUpdate() {
    // int EVP_DecryptUpdate(EVP_CIPHER_CTX *ctx, unsigned char *out,
    //                       int *outl, const unsigned char *in, int inl)
    const syms = Module.enumerateExports(LIB).filter(
        e => e.name.indexOf("EVP_DecryptUpdate") !== -1
    );

    for (const sym of syms) {
        console.log("[*] Hooking " + sym.name + " @ " + sym.address);
        Interceptor.attach(sym.address, {
            onEnter(args) {
                this.ctx = args[0];
                this.outBuf = args[1];
                this.outLen = args[2];
                this.inLen = args[4].toInt32();

                if (this.inLen > 0 && this.inLen < 1024 * 1024) {
                    console.log("\n---------- EVP_DecryptUpdate ----------");
                    console.log("[IN-LEN]  " + this.inLen);
                    if (this.inLen <= 64) {
                        console.log("[IN-HEX]  " + hexdump(args[3], this.inLen));
                    } else {
                        console.log("[IN-HEX]  " + hexdump(args[3], 64) + " ... (truncated)");
                    }
                }
            },
            onLeave(retval) {
                if (this.outLen && !this.outLen.isNull()) {
                    const written = this.outLen.readInt();
                    if (written > 0 && written < 1024 * 1024) {
                        const text = tryReadUtf8(this.outBuf, Math.min(written, 512));
                        if (text) {
                            console.log("[OUT-TXT] " + JSON.stringify(text.substring(0, 200)));
                        }
                        console.log("[OUT-LEN] " + written);
                    }
                }
            }
        });
    }
}

function hookDecryptFinal() {
    // int EVP_DecryptFinal_ex(EVP_CIPHER_CTX *ctx, unsigned char *out, int *outl)
    const syms = Module.enumerateExports(LIB).filter(
        e => e.name.indexOf("EVP_DecryptFinal") !== -1
    );

    for (const sym of syms) {
        console.log("[*] Hooking " + sym.name + " @ " + sym.address);
        Interceptor.attach(sym.address, {
            onEnter(args) {
                this.outBuf = args[1];
                this.outLen = args[2];
            },
            onLeave(retval) {
                console.log("\n========== EVP_DecryptFinal ==========");
                console.log("[RET] " + retval.toInt32());
                if (this.outLen && !this.outLen.isNull()) {
                    const padLen = this.outLen.readInt();
                    console.log("[PAD-LEN] " + padLen);
                    if (padLen > 0 && padLen <= 16) {
                        console.log("[PAD-HEX] " + hexdump(this.outBuf, padLen));
                    }
                }
            }
        });
    }
}

// Also hook EVP_EncryptInit to see if the same key is used for encryption
function hookEncryptInit() {
    const syms = Module.enumerateExports(LIB).filter(
        e => e.name.indexOf("EVP_EncryptInit") !== -1
    );
    for (const sym of syms) {
        console.log("[*] Hooking " + sym.name + " @ " + sym.address);
        Interceptor.attach(sym.address, {
            onEnter(args) {
                const key = args[3];
                const iv = args[4];
                if (key && !key.isNull()) {
                    console.log("\n========== EVP_EncryptInit_ex ==========");
                    console.log("[ENC-KEY-16] " + hexdump(key, 16));
                    console.log("[ENC-KEY-32] " + hexdump(key, 32));
                }
                if (iv && !iv.isNull()) {
                    console.log("[ENC-IV]     " + hexdump(iv, 16));
                }
            }
        });
    }
}

function main() {
    console.log("[*] crawler-descryptor: BoringSSL hook loaded");
    console.log("[*] Waiting for " + LIB + " to be loaded...");

    // libflutter.so might already be loaded, or we wait for it
    const mod = Process.findModuleByName(LIB);
    if (mod) {
        console.log("[*] " + LIB + " already loaded at " + mod.base);
        hookDecryptInit();
        hookDecryptUpdate();
        hookDecryptFinal();
        hookEncryptInit();
    } else {
        const interval = setInterval(function () {
            const m = Process.findModuleByName(LIB);
            if (m) {
                clearInterval(interval);
                console.log("[*] " + LIB + " loaded at " + m.base);
                hookDecryptInit();
                hookDecryptUpdate();
                hookDecryptFinal();
                hookEncryptInit();
            }
        }, 500);
    }
}

main();
