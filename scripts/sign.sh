#!/bin/sh
# Sign the built app with a stable local certificate, so macOS keeps its Screen Recording and Microphone
# permissions across rebuilds (an ad-hoc signature changes every build, and each change resets them).
# One-time setup: create a self-signed code-signing certificate named "Sidekick Local Signing" in the login
# keychain (Keychain Access → Certificate Assistant → Create a Certificate → type "Code Signing").
APP="$1"
ID="${SIDEKICK_SIGN_ID:-Sidekick Local Signing}"
if security find-identity -p codesigning | grep -q "\"$ID\""; then
  codesign --force --deep -s "$ID" "$APP" && echo "Signed with $ID"
else
  echo "No \"$ID\" certificate found: keeping the ad-hoc signature (permissions reset on each rebuild)"
fi
