#!/bin/sh
# scripts/install-onchainos.sh
#
# Downloads and installs the OKX onchainos binary.
# Verifies the installer against the official checksum before running it.
#
# Usage:
#   ./scripts/install-onchainos.sh              # install latest stable
#   ONCHAINOS_VERSION=v2.2.9 ./scripts/install-onchainos.sh   # pin version
#
# Installs to ~/.local/bin/onchainos by default (per OKX install.sh).
# The Meridian provider wrapper resolves this path automatically via
# providers/okx/scan.ts → resolveBinaryPath().

set -e

REPO="okx/onchainos-skills"

# Resolve target version (env override wins; otherwise latest stable)
if [ -n "$ONCHAINOS_VERSION" ]; then
  TAG="v${ONCHAINOS_VERSION#v}"
else
  echo "[install-onchainos] Fetching latest release tag from GitHub..."
  TAG=$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | grep '"tag_name"' | head -1 \
    | sed -E 's/.*"v([^"]+)".*/\1/')
  if [ -z "$TAG" ]; then
    echo "[install-onchainos] ERROR: could not resolve latest version" >&2
    exit 1
  fi
fi
echo "[install-onchainos] Target version: v${TAG}"

# Download the upstream installer + its checksum
INSTALLER="/tmp/onchainos-install-${TAG}.sh"
CHECKSUMS="/tmp/onchainos-install-checksums-${TAG}.txt"

echo "[install-onchainos] Downloading installer..."
curl -sSL --fail "https://raw.githubusercontent.com/${REPO}/v${TAG}/install.sh" -o "$INSTALLER"
curl -sSL --fail "https://github.com/${REPO}/releases/download/v${TAG}/installer-checksums.txt" -o "$CHECKSUMS"
chmod +x "$INSTALLER"

# Verify installer integrity BEFORE running it (defense in depth)
if [ -f "$CHECKSUMS" ]; then
  echo "[install-onchainos] Verifying installer checksum..."
  EXPECTED=$(grep -E "install\.sh" "$CHECKSUMS" | awk '{print $1}' | head -1)
  ACTUAL=$(shasum -a 256 "$INSTALLER" 2>/dev/null | awk '{print $1}' \
            || sha256sum "$INSTALLER" | awk '{print $1}')
  if [ -n "$EXPECTED" ] && [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "[install-onchainos] ERROR: installer checksum mismatch" >&2
    echo "  expected: $EXPECTED" >&2
    echo "  actual:   $ACTUAL" >&2
    exit 1
  fi
  echo "[install-onchainos] Installer checksum OK"
else
  echo "[install-onchainos] WARNING: no checksums file available, skipping integrity check"
fi

# Run the upstream installer
echo "[install-onchainos] Running installer..."
sh "$INSTALLER"

# Verify the binary is now available
INSTALL_DIR="${HOME}/.local/bin"
if [ -x "${INSTALL_DIR}/onchainos" ]; then
  echo "[install-onchainos] OK — installed to ${INSTALL_DIR}/onchainos"
  "${INSTALL_DIR}/onchainos" --version 2>/dev/null || true
else
  echo "[install-onchainos] WARNING: binary not found at ${INSTALL_DIR}/onchainos"
  echo "[install-onchainos]         (check installer output above for actual path)"
fi
