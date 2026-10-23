#!/usr/bin/env bash
# Signs a release DMG for Sparkle and writes (or extends) appcast.xml, the file the app's updater and the hub's "new version" banner read.
#
#   bash scripts/make-appcast.sh <dmg> <download-url> [options]
#
#   <dmg>            the notarized DMG from: bash scripts/package-mac.sh --release
#   <download-url>   the https address the DMG will be published at (the same file; users' updaters download it from there)
#   --out FILE       where to write appcast.xml (default: next to the DMG). An existing file keeps its earlier items.
#   --notes FILE     release notes, an HTML fragment (default: one line naming the version)
#   --min-os X.Y     the oldest macOS that can run it (default 14.0, the app's deployment target)
#   --version X      the version (default: from VERSION, in the form Info.plist uses)
#
# Sparkle's sign_update does the signing with the private EdDSA key that generate_keys put in your login keychain (or SPARKLE_ED_KEY_FILE,
# a file made by generate_keys -x). It is found at SPARKLE_SIGN_UPDATE, else in the Sparkle pod (run a --release build first), else on PATH.
# The private key never leaves your Mac and is never written by this script. Upload the DMG and appcast.xml yourself (docs/release.md).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
die() { printf '\n\033[1;31m%s\033[0m\n' "$1" >&2; exit 1; }
usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; }

[ "$#" -ge 2 ] || { usage; exit 2; }
DMG="$1"; URL="$2"; shift 2
OUT=""; NOTES=""; MINOS="14.0"
VERSION_TEXT="$(awk '{print $1; exit}' "$ROOT/VERSION")"; APPVER="${VERSION_TEXT//-/.}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out needs a file}"; shift 2 ;;
    --notes) NOTES="${2:?--notes needs a file}"; shift 2 ;;
    --min-os) MINOS="${2:?--min-os needs a version}"; shift 2 ;;
    --version) APPVER="${2:?--version needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) usage; die "Unknown option: $1" ;;
  esac
done

[ -f "$DMG" ] || die "No DMG at $DMG. Build one with: bash scripts/package-mac.sh --release"
[[ "$URL" =~ ^https://[^[:space:]\"\<\>]+$ ]] || die "The download URL must be an https address with no spaces or quotes."
[[ "$APPVER" =~ ^[0-9A-Za-z.+]+$ ]] || die "The version \"$APPVER\" has characters an appcast shouldn't."
[[ "$MINOS" =~ ^[0-9]+(\.[0-9]+){0,2}$ ]] || die "--min-os must look like 14.0"
[ -n "$OUT" ] || OUT="$(dirname "$DMG")/appcast.xml"

SIGN="${SPARKLE_SIGN_UPDATE:-}"
[ -n "$SIGN" ] || SIGN="$ROOT/packages/app/macos/Pods/Sparkle/bin/sign_update"
if [ ! -x "$SIGN" ]; then SIGN="$(command -v sign_update || true)"; fi
[ -n "$SIGN" ] && [ -x "$SIGN" ] || die "Can't find Sparkle's sign_update. Set SPARKLE_SIGN_UPDATE to its path (it is in Sparkle's release download, in bin/), or run a --release build first so the pod is installed."

KEYARGS=()
[ -z "${SPARKLE_ED_KEY_FILE:-}" ] || KEYARGS=(--ed-key-file "$SPARKLE_ED_KEY_FILE")
SIGOUT="$("$SIGN" ${KEYARGS[@]+"${KEYARGS[@]}"} "$DMG")" || die "sign_update failed. Is the EdDSA key in your keychain (generate_keys), or SPARKLE_ED_KEY_FILE set?"
SIG="$(printf '%s' "$SIGOUT" | sed -n 's/.*sparkle:edSignature="\([^"]*\)".*/\1/p' | head -1)"
LEN="$(printf '%s' "$SIGOUT" | sed -n 's/.*length="\([0-9]*\)".*/\1/p' | head -1)"
[ -n "$SIG" ] || die "sign_update printed no signature: $SIGOUT"
[ -n "$LEN" ] || LEN="$(wc -c < "$DMG" | tr -d ' ')"

NOTES_HTML="<p>Agent Room $APPVER</p>"
if [ -n "$NOTES" ]; then
  [ -f "$NOTES" ] || die "No notes file at $NOTES."
  NOTES_HTML="$(cat "$NOTES")"
  case "$NOTES_HTML" in *']]>'*) die "The release notes contain ]]>, which would end the XML early. Remove it." ;; esac
fi
xml_attr() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'; }
PUBDATE="$(LC_ALL=C date -u '+%a, %d %b %Y %H:%M:%S +0000')"

NEW="$(mktemp)"; trap 'rm -f "$NEW"' EXIT
{
  echo '    <item>'
  echo "      <title>Version $(xml_attr "$APPVER")</title>"
  echo "      <pubDate>$PUBDATE</pubDate>"
  echo "      <sparkle:version>$(xml_attr "$APPVER")</sparkle:version>"
  echo "      <sparkle:shortVersionString>$(xml_attr "$APPVER")</sparkle:shortVersionString>"
  echo "      <sparkle:minimumSystemVersion>$MINOS</sparkle:minimumSystemVersion>"
  echo "      <description><![CDATA[$NOTES_HTML]]></description>"
  echo "      <enclosure url=\"$(xml_attr "$URL")\" length=\"$LEN\" type=\"application/octet-stream\" sparkle:edSignature=\"$SIG\"/>"
  echo '    </item>'
} > "$NEW"

# Earlier items stay, except one for this same version (a re-run replaces it).
OLD=""
if [ -f "$OUT" ]; then
  OLD="$(awk -v v="<sparkle:version>$APPVER</sparkle:version>" '
    /^[[:space:]]*<item>/ { buf = $0 ORS; inItem = 1; keep = 1; next }
    inItem { buf = buf $0 ORS; if (index($0, v)) keep = 0; if ($0 ~ /<\/item>/) { if (keep) printf "%s", buf; inItem = 0; buf = "" } }
  ' "$OUT")"
fi

mkdir -p "$(dirname "$OUT")"
{
  echo '<?xml version="1.0" encoding="utf-8"?>'
  echo '<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle" xmlns:dc="http://purl.org/dc/elements/1.1/">'
  echo '  <channel>'
  echo '    <title>Agent Room</title>'
  echo '    <description>Agent Room updates</description>'
  echo '    <language>en</language>'
  cat "$NEW"
  [ -z "$OLD" ] || printf '%s\n' "$OLD"
  echo '  </channel>'
  echo '</rss>'
} > "$OUT"

printf '\n\033[1;32mWrote %s\033[0m\n  version %s, %s bytes, signed with Sparkle (EdDSA)\n' "$OUT" "$APPVER" "$LEN"
echo "Upload $(basename "$DMG") to $URL and appcast.xml to the address in the app's SUFeedURL (docs/release.md, \"Publishing\")."
