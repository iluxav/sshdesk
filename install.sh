#!/bin/sh
#
# sshdesk installer.
#
#   curl -fsSL https://raw.githubusercontent.com/iluxav/sshdesk/main/install.sh | sh
#
# Why this exists rather than a .dmg: the app is not notarised, and macOS
# quarantines anything a *browser* downloads, so a downloaded .dmg would be
# refused by Gatekeeper. curl sets no quarantine attribute, so an app installed
# this way launches normally. The trade is that you are trusting this script and
# the checksums it verifies, which is why it verifies them.
#
# Environment:
#   SSHDESK_REPO     owner/repo to install from (default below)
#   SSHDESK_VERSION  a tag such as v0.1.0 (default: latest release)
#   SSHDESK_PREFIX   where the app goes (default: /Applications, else ~/Applications)
#   SSHDESK_BASE_URL where assets are fetched from (default: the GitHub release)

set -eu

REPO="${SSHDESK_REPO:-iluxav/sshdesk}"
VERSION="${SSHDESK_VERSION:-latest}"
API="https://api.github.com/repos/$REPO/releases"

say()  { printf '%s\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "sshdesk is macOS only for now (this is $(uname -s))."

case "$(uname -m)" in
  arm64)  ARCH=aarch64 ;;
  x86_64) ARCH=x86_64 ;;
  *)      die "unsupported architecture: $(uname -m)" ;;
esac

command -v curl >/dev/null 2>&1 || die "curl is required."
command -v shasum >/dev/null 2>&1 || die "shasum is required."

# Resolve the release, and say which one, so an unexpected version is visible
# before anything is written.
if [ -n "${SSHDESK_BASE_URL:-}" ]; then
  TAG="${VERSION#latest}"; TAG="${TAG:-local}"
elif [ "$VERSION" = "latest" ]; then
  TAG=$(curl -fsSL "$API/latest" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$TAG" ] || die "no published release in $REPO yet."
else
  TAG="$VERSION"
fi

ASSET="sshdesk-${TAG}-${ARCH}.tar.gz"
BASE="${SSHDESK_BASE_URL:-https://github.com/$REPO/releases/download/$TAG}"

say "sshdesk $TAG ($ARCH)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

say "  downloading $ASSET"
curl -fSL --progress-bar -o "$TMP/$ASSET" "$BASE/$ASSET" \
  || die "could not download $BASE/$ASSET"

# The checksum is not optional: this puts an executable in /Applications.
say "  verifying checksum"
curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" \
  || die "could not download SHA256SUMS — refusing to install unverified."
WANT=$(grep " $ASSET\$" "$TMP/SHA256SUMS" | awk '{print $1}' | head -1)
[ -n "$WANT" ] || die "$ASSET is not listed in SHA256SUMS."
GOT=$(shasum -a 256 "$TMP/$ASSET" | awk '{print $1}')
[ "$WANT" = "$GOT" ] || die "checksum mismatch
  expected $WANT
  got      $GOT
Refusing to install."

say "  unpacking"
tar -xzf "$TMP/$ASSET" -C "$TMP"
[ -d "$TMP/sshdesk.app" ] || die "the archive did not contain sshdesk.app"

# /Applications when writable, otherwise the user's own — never sudo behind
# your back.
if [ -n "${SSHDESK_PREFIX:-}" ]; then
  DEST="$SSHDESK_PREFIX"
elif [ -w /Applications ]; then
  DEST=/Applications
else
  DEST="$HOME/Applications"
  warn "  /Applications is not writable, installing to $DEST"
fi
# Every branch, not just the fallback: a prefix that does not exist yet is a
# perfectly reasonable thing to ask for.
mkdir -p "$DEST" || die "cannot create $DEST"
[ -w "$DEST" ] || die "$DEST is not writable"



if [ -d "$DEST/sshdesk.app" ]; then
  say "  replacing the existing install"
  rm -rf "$DEST/sshdesk.app"
fi
mv "$TMP/sshdesk.app" "$DEST/sshdesk.app"

# curl leaves no quarantine attribute, so this is belt and braces for anyone
# who fetched the tarball with a browser instead.
xattr -dr com.apple.quarantine "$DEST/sshdesk.app" 2>/dev/null || true

say ""
say "Installed to $DEST/sshdesk.app"
say ""
say "  open -a sshdesk        # or find it in Launchpad"
say ""
say "It is not signed by Apple, so a browser download would have been blocked."
say "Installed this way it just opens. To remove it:  rm -rf $DEST/sshdesk.app"
