#!/usr/bin/env bash
#
# Builds Sources/ into a real .app bundle.
#
# SwiftPM alone produces a bare Mach-O executable, and a SwiftUI app run that way is
# subtly wrong: no Info.plist means no bundle identifier, which means App Transport
# Security has no configuration to read, the Keychain has no service identity, and
# os_log has no subsystem. So SwiftPM compiles, and this script does the bundling —
# which is also the layout `Bundle.main.resourceURL` expects at runtime.
#
# Usage:
#   ./build.sh                        debug build, ad-hoc signed, no sidecar copied
#   ./build.sh --release              optimised
#   ./build.sh --sidecar ../../dist/sidecar
#   ./build.sh --release --universal --sign "Developer ID Application: Example (TEAMID)"
#   ./build.sh --run                  build, then launch with logs on this terminal

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Agentic Workspace"
EXECUTABLE="MacShell"
BUNDLE_ID="co.apolitical.agentic.macshell"
VERSION="${MACSHELL_VERSION:-0.1.0}"
BUILD_NUMBER="${MACSHELL_BUILD:-$(date -u +%Y%m%d%H%M)}"
MIN_MACOS="14.0"

usage() {
  cat <<'USAGE'
build.sh [options]

  --release              optimised build (default: debug)
  --universal            arm64 + x86_64 (default: native arch only)
  --sidecar <dir>        copy a built sidecar into Contents/Resources/sidecar
  --sign <identity>      Developer ID signing with hardened runtime
  --run                  launch the built app with logs on this terminal
USAGE
}

CONFIGURATION="debug"
SIDECAR_DIR=""
SIGN_IDENTITY=""
UNIVERSAL=0
RUN_AFTER=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)   CONFIGURATION="release"; shift ;;
    --debug)     CONFIGURATION="debug"; shift ;;
    --universal) UNIVERSAL=1; shift ;;
    --run)       RUN_AFTER=1; shift ;;
    --sidecar)   SIDECAR_DIR="${2:?--sidecar needs a directory}"; shift 2 ;;
    --sign)      SIGN_IDENTITY="${2:?--sign needs an identity}"; shift 2 ;;
    -h|--help)   usage; exit 0 ;;
    *)           echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This builds a macOS app bundle and only runs on macOS." >&2
  exit 1
fi

command -v swift >/dev/null || { echo "swift not found. Install Xcode or the Swift toolchain." >&2; exit 1; }

BUILD_FLAGS=(-c "$CONFIGURATION" --package-path "$ROOT")
if [[ "$UNIVERSAL" -eq 1 ]]; then
  # Distribution builds must cover both architectures; a native-arch build is fine
  # for development and roughly twice as fast.
  BUILD_FLAGS+=(--arch arm64 --arch x86_64)
fi

ARCH_NOTE="native"
if [[ "$UNIVERSAL" -eq 1 ]]; then ARCH_NOTE="universal"; fi
echo "==> swift build ($CONFIGURATION, $ARCH_NOTE)"
swift build "${BUILD_FLAGS[@]}"
BIN_PATH="$(swift build "${BUILD_FLAGS[@]}" --show-bin-path)"

APP="$ROOT/build/$APP_NAME.app"
CONTENTS="$APP/Contents"

echo "==> assembling $APP"
rm -rf "$APP"
mkdir -p "$CONTENTS/MacOS" "$CONTENTS/Resources"
cp "$BIN_PATH/$EXECUTABLE" "$CONTENTS/MacOS/$EXECUTABLE"

# Classic four-char type/creator file. Harmless, and some tools still look for it.
printf 'APPL????' > "$CONTENTS/PkgInfo"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>                 <string>$APP_NAME</string>
  <key>CFBundleDisplayName</key>          <string>$APP_NAME</string>
  <key>CFBundleExecutable</key>           <string>$EXECUTABLE</string>
  <key>CFBundleIdentifier</key>           <string>$BUNDLE_ID</string>
  <key>CFBundlePackageType</key>          <string>APPL</string>
  <key>CFBundleShortVersionString</key>   <string>$VERSION</string>
  <key>CFBundleVersion</key>              <string>$BUILD_NUMBER</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key>       <string>$MIN_MACOS</string>
  <key>LSApplicationCategoryType</key>    <string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key>      <true/>
  <key>NSHumanReadableCopyright</key>     <string>Apolitical</string>

  <!-- The workspace is served over plain HTTP on the loopback interface. There is no
       transport to secure: the traffic never leaves the machine, and terminating TLS
       on a self-signed loopback certificate would only add a trust-store problem.
       NSAllowsLocalNetworking is the narrow key for exactly this; NSAllowsArbitraryLoads
       would disable ATS for the whole app and must not be used. -->
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsLocalNetworking</key><true/>
    <key>NSExceptionDomains</key>
    <dict>
      <key>localhost</key>
      <dict>
        <key>NSExceptionAllowsInsecureHTTPLoads</key><true/>
      </dict>
    </dict>
  </dict>
</dict>
</plist>
PLIST

if [[ -n "$SIDECAR_DIR" ]]; then
  if [[ ! -d "$SIDECAR_DIR" ]]; then
    echo "--sidecar: not a directory: $SIDECAR_DIR" >&2
    exit 1
  fi
  echo "==> copying sidecar from $SIDECAR_DIR"
  mkdir -p "$CONTENTS/Resources/sidecar"
  cp -R "$SIDECAR_DIR"/. "$CONTENTS/Resources/sidecar/"
  if [[ ! -f "$CONTENTS/Resources/sidecar/server.js" ]]; then
    echo "    warning: no server.js at the top of the sidecar directory." >&2
    echo "    The app looks for Contents/Resources/sidecar/server.js." >&2
  fi
  if [[ ! -x "$CONTENTS/Resources/sidecar/node" ]]; then
    echo "    note: no bundled node runtime; the app will fall back to one on disk." >&2
  fi
else
  echo "==> no --sidecar given; set AGENTIC_SIDECAR_PATH to a server entry point when running"
fi

# Signing. On Apple silicon every executable must carry at least an ad-hoc signature
# or the kernel refuses to run it, so there is no unsigned path.
if [[ -n "$SIGN_IDENTITY" ]]; then
  echo "==> signing with: $SIGN_IDENTITY"
  # Inside-out, never --deep: --deep is deprecated, applies the wrong entitlements to
  # nested code, and is the usual cause of a notarization rejection.
  if [[ -x "$CONTENTS/Resources/sidecar/node" ]]; then
    codesign --force --timestamp --options runtime \
      --entitlements "$ROOT/Entitlements/Sidecar.entitlements" \
      --sign "$SIGN_IDENTITY" "$CONTENTS/Resources/sidecar/node"
  fi
  # Any other Mach-O in Resources (native addons, helper binaries) also needs its own
  # signature before the outer bundle is sealed.
  while IFS= read -r -d '' macho; do
    codesign --force --timestamp --options runtime \
      --entitlements "$ROOT/Entitlements/Sidecar.entitlements" \
      --sign "$SIGN_IDENTITY" "$macho"
  done < <(find "$CONTENTS/Resources" -type f \( -name '*.node' -o -name '*.dylib' \) -print0 2>/dev/null || true)

  codesign --force --timestamp --options runtime \
    --entitlements "$ROOT/Entitlements/MacShell.entitlements" \
    --sign "$SIGN_IDENTITY" "$APP"
  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "==> next: notarize with"
  echo "    ditto -c -k --keepParent \"$APP\" build/AgenticWorkspace.zip"
  echo "    xcrun notarytool submit build/AgenticWorkspace.zip --keychain-profile <profile> --wait"
  echo "    xcrun stapler staple \"$APP\""
else
  echo "==> ad-hoc signing (local use only; not distributable)"
  codesign --force --sign - "$APP"
fi

echo "==> built $APP"

if [[ "$RUN_AFTER" -eq 1 ]]; then
  # Executed directly rather than via `open` so stdout, stderr and any crash text
  # land on this terminal. Bundle.main still resolves to the .app, because the
  # binary is inside it.
  echo "==> running"
  exec "$CONTENTS/MacOS/$EXECUTABLE"
fi
