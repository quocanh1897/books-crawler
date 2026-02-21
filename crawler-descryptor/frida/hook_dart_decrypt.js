/**
 * Hook Dart-level decryptContent / encryptContent functions in libapp.so.
 *
 * Since Dart AOT compiles to native code, we can't hook by function name directly.
 * Strategy:
 *   1. Search for string references to find the decryption function address
 *   2. Hook the function to capture input (encrypted envelope) and output (plaintext)
 *
 * Alternative: use the BoringSSL hooks (hook_boringssl.js) which are more reliable
 * since they hook at the C level regardless of Dart compilation details.
 *
 * Usage:
 *   frida -D emulator-5558 -n com.novelfever.app.android.debug -l hook_dart_decrypt.js
 */

"use strict";

const LIB_APP = "libapp.so";

function scanForString(mod, str) {
    const pattern = str.split("").map(c => ("0" + c.charCodeAt(0).toString(16)).slice(-2)).join(" ");
    const matches = Memory.scanSync(mod.base, mod.size, pattern);
    return matches;
}

function main() {
    console.log("[*] crawler-descryptor: Dart decrypt hook loaded");

    const mod = Process.findModuleByName(LIB_APP);
    if (!mod) {
        console.log("[!] " + LIB_APP + " not found. Waiting...");
        const interval = setInterval(function () {
            const m = Process.findModuleByName(LIB_APP);
            if (m) {
                clearInterval(interval);
                exploreDartSymbols(m);
            }
        }, 1000);
        return;
    }
    exploreDartSymbols(mod);
}

function exploreDartSymbols(mod) {
    console.log("[*] " + LIB_APP + " at " + mod.base + " size=" + mod.size);

    // Search for known string patterns that would appear near the decrypt function
    const searchStrings = [
        "decryptContent",
        "encryptContent",
        "app_key",
        "AES",
        "base64",
    ];

    for (const s of searchStrings) {
        const hits = scanForString(mod, s);
        if (hits.length > 0) {
            console.log("[FOUND] '" + s + "' at " + hits.length + " location(s):");
            for (const hit of hits.slice(0, 5)) {
                console.log("  " + hit.address + " (offset: +" + hit.address.sub(mod.base) + ")");
            }
        } else {
            console.log("[MISS]  '" + s + "' not found in " + LIB_APP);
        }
    }

    // Dump Dart snapshot info — look for Dart VM snapshot markers
    const dartMarkers = ["_kDartVmSnapshotInstructions", "_kDartIsolateSnapshotInstructions"];
    const exports = mod.enumerateExports();
    console.log("\n[*] Exports containing 'dart' or 'Dart' or 'snapshot':");
    for (const e of exports) {
        const lower = e.name.toLowerCase();
        if (lower.indexOf("dart") !== -1 || lower.indexOf("snapshot") !== -1) {
            console.log("  " + e.name + " @ " + e.address);
        }
    }

    // List all exports for reference (first 50)
    console.log("\n[*] First 50 exports of " + LIB_APP + ":");
    for (const e of exports.slice(0, 50)) {
        console.log("  " + e.name + " @ " + e.address);
    }

    console.log("\n[*] Total exports: " + exports.length);
    console.log("[*] Use hook_boringssl.js to capture the actual AES key/IV at the C level.");
    console.log("[*] This script helps locate Dart functions for more targeted hooking.");
}

main();
