#!/usr/bin/env bash
# Regenerates Resources/AppIcon.icns from Tools/MakeAppIcon.swift.
# Run by hand when the icon changes — not from build.sh, which should not depend on
# a code-signing-adjacent art pipeline to produce a debug build.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICONSET="$(mktemp -d)/AppIcon.iconset"
mkdir -p "$ROOT/Resources"
swift "$ROOT/Tools/MakeAppIcon.swift" "$ICONSET"
iconutil -c icns -o "$ROOT/Resources/AppIcon.icns" "$ICONSET"
echo "==> wrote $ROOT/Resources/AppIcon.icns"
