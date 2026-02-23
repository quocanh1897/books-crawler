#!/bin/bash
# Launch both emulators and mitmproxy for parallel downloads.
#
# Usage:
#   ./start_emulators.sh          # launch both + proxy
#   ./start_emulators.sh --no-proxy   # emulators only

set -e

EMU=~/Library/Android/sdk/emulator/emulator
ADB=~/Library/Android/sdk/platform-tools/adb
APK=../apk/mtc1.4.4/aligned_emu.apk

echo "=== Starting emulators ==="

# Launch emulator 1 (port 5554)
if $ADB devices 2>/dev/null | grep -q "emulator-5554"; then
    echo "  emulator-5554 already running"
else
    echo "  Starting Medium_Phone_API_36.1 on port 5554..."
    $EMU -avd Medium_Phone_API_36.1 -port 5554 &
fi

# Launch emulator 2 (port 5556)
if $ADB devices 2>/dev/null | grep -q "emulator-5556"; then
    echo "  emulator-5556 already running"
else
    echo "  Starting Medium_Phone_2 on port 5556..."
    $EMU -avd Medium_Phone_2 -port 5556 &
fi

echo "  Waiting for devices..."
$ADB -s emulator-5554 wait-for-device
echo "  emulator-5554 ready"
$ADB -s emulator-5556 wait-for-device
echo "  emulator-5556 ready"

# Wait for boot completion
for dev in emulator-5554 emulator-5556; do
    echo "  Waiting for $dev to finish booting..."
    while [ "$($ADB -s $dev shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" != "1" ]; do
        sleep 2
    done
    echo "  $dev booted"
done

# Install APK on emulator-5556 if not already installed
if ! $ADB -s emulator-5556 shell pm list packages 2>/dev/null | grep -q "com.novelfever.app.android.debug"; then
    echo "  Installing APK on emulator-5556..."
    $ADB -s emulator-5556 install "$APK"
fi

# Start mitmproxy (both emulators share it via 10.0.2.2:8083)
if [[ "$1" != "--no-proxy" ]]; then
    if ! pgrep -f "mitmdump.*8083" > /dev/null; then
        echo "  Starting mitmproxy on :8083..."
        mitmdump --listen-port 8083 --ssl-insecure --set block_global=false &
    else
        echo "  mitmproxy already running on :8083"
    fi
fi

echo ""
echo "=== Ready ==="
echo "  Emulator 1: emulator-5554 (Medium_Phone_API_36.1)"
echo "  Emulator 2: emulator-5556 (Medium_Phone_2)"
echo ""
echo "  To copy auth from emu1 → emu2:"
echo "    python3 parallel_grab.py --setup"
