#!/bin/sh
# Build the page-layout helper the PDF reflow calls (spec D4R, Annex C.5).
#
# Needs the Xcode toolchain. The binary runs on macOS 12 and later and reports
# "supported": false below macOS 26, where Vision's document request does not
# exist — so a machine that cannot use it gets a reason, not a crash.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/helpers/bin"
xcrun swiftc -O -parse-as-library -target arm64-apple-macos12.0 \
  -o "$root/helpers/bin/musaeum-layout" "$root/helpers/musaeum-layout/main.swift"
echo "built $root/helpers/bin/musaeum-layout ($(du -h "$root/helpers/bin/musaeum-layout" | cut -f1))"
