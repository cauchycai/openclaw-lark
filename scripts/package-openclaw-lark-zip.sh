#!/usr/bin/env bash
# Build a self-contained openclaw-lark ZIP for Bundle local-plugin upload.
# Unlike openclaw-personal-assets (vendored runtime), this plugin needs real
# npm dependencies at load time — package production node_modules into the ZIP.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLUGIN_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PLUGIN_NAME="openclaw-lark"
OUTPUT="$PLUGIN_DIR/release/$PLUGIN_NAME.zip"
SKIP_BUILD=false

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

usage() {
  cat <<EOF
Build a self-contained ZIP for Bundle's plugin_local_install mode.

Usage:
  $(basename "$0") [options]

Options:
  --output PATH   ZIP output path
                  (default: $OUTPUT)
  --skip-build    Reuse existing dist/ (still installs production deps in a stage dir)
  -h, --help      Show this help

The ZIP contains plugin files at its root (not inside another
$PLUGIN_NAME/ directory). Production node_modules are included so
plugin_local_install can load without a sandbox npm install.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      [[ $# -ge 2 ]] || die "--output requires a path"
      OUTPUT="$2"
      shift 2
      ;;
    --skip-build)
      SKIP_BUILD=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

[[ -d "$PLUGIN_DIR" ]] || die "plugin directory not found: $PLUGIN_DIR"
command -v zip >/dev/null 2>&1 || die "zip is required"
command -v unzip >/dev/null 2>&1 || die "unzip is required"
command -v npm >/dev/null 2>&1 || die "npm is required"
command -v rsync >/dev/null 2>&1 || die "rsync is required"

if ! $SKIP_BUILD; then
  log "building $PLUGIN_NAME..."
  (cd "$PLUGIN_DIR" && npm run build)
else
  log "skipping build; validating existing build output..."
fi

required_files=(
  "openclaw.plugin.json"
  "package.json"
  "dist/index.mjs"
  "secret-contract-api.js"
  "bin/openclaw-lark.js"
)
for relative_path in "${required_files[@]}"; do
  [[ -f "$PLUGIN_DIR/$relative_path" ]] \
    || die "required package file missing: $PLUGIN_DIR/$relative_path"
done

STAGE_ROOT="$(mktemp -d /tmp/openclaw-lark-zip.XXXXXX)"
cleanup() { rm -rf "$STAGE_ROOT"; }
trap cleanup EXIT
STAGE_DIR="$STAGE_ROOT/$PLUGIN_NAME"
mkdir -p "$STAGE_DIR"

log "staging plugin tree (excluding local node_modules / git / release)..."
rsync -a \
  --exclude node_modules/ \
  --exclude .git/ \
  --exclude release/ \
  --exclude '.DS_Store' \
  --exclude '*.log' \
  --exclude '*.tsbuildinfo' \
  --exclude '*.zip' \
  "$PLUGIN_DIR/" "$STAGE_DIR/"

log "installing production dependencies into stage..."
(
  cd "$STAGE_DIR"
  npm install --omit=dev --legacy-peer-deps
  # Match pack.sh / Docker: host openclaw is linked at install time.
  rm -rf node_modules/openclaw node_modules/.bin/openclaw 2>/dev/null || true
)

[[ -d "$STAGE_DIR/node_modules/@larksuiteoapi/node-sdk" ]] \
  || die "production install missing @larksuiteoapi/node-sdk"

OUTPUT_DIR="$(dirname "$OUTPUT")"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
OUTPUT="$OUTPUT_DIR/$(basename "$OUTPUT")"
[[ "$OUTPUT" == *.zip ]] || die "output path must end in .zip: $OUTPUT"

rm -f "$OUTPUT"
log "creating Bundle local-plugin ZIP: $OUTPUT"
(
  cd "$STAGE_DIR"
  zip -q -r -X "$OUTPUT" . \
    -x '.DS_Store' '*/.DS_Store' \
       '*.log' '*.tsbuildinfo' \
       '*.zip'
)

ZIP_LIST="$(unzip -Z1 "$OUTPUT")"
for relative_path in "${required_files[@]}"; do
  grep -Fxq "$relative_path" <<< "$ZIP_LIST" \
    || die "ZIP validation failed; missing: $relative_path"
done
grep -Eq '(^|/)node_modules/@larksuiteoapi/node-sdk/' <<< "$ZIP_LIST" \
  || die "ZIP validation failed; missing node_modules/@larksuiteoapi/node-sdk"

file_count="$(wc -l <<< "$ZIP_LIST" | tr -d ' ')"
size_bytes="$(wc -c < "$OUTPUT" | tr -d ' ')"
log "done: $OUTPUT ($file_count entries, $size_bytes bytes)"
log "upload this ZIP as a local plugin with name: $PLUGIN_NAME"
log "note: Bundle openclaw_config keys must use plugin id '$PLUGIN_NAME' (not a custom resource alias)"
