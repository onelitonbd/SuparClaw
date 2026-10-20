#!/usr/bin/env bash
# SuparClaw installer — Termux-first, no root, no sudo, no build tools required.
#
#   curl -fsSL https://raw.githubusercontent.com/onelitonbd/SuparClaw/main/install.sh | bash
#
# Options:
#   --ref <branch|tag>   install another ref (default: main)
#   --dir <path>         install location (default: $HOME/.suparclaw-install)
#   --uninstall          remove the launcher and the install directory
#
set -euo pipefail

REPO="onelitonbd/SuparClaw"
REF="main"
PREFIX_DIR="${HOME}/.suparclaw-install"
MIN_NODE_MAJOR=24
MIN_NODE_MINOR=16

# ---------------------------------------------------------------- brand
# /// suparclaw · your phone is the machine.
# A clawed-up installer should feel like the product: violet, mint, snippy.
USE_COLOR=1
if [ -n "${NO_COLOR:-}" ] || [ "${TERM:-dumb}" = "dumb" ] || [ ! -t 1 ]; then
  USE_COLOR=0
fi
if [ "$USE_COLOR" = "1" ]; then
  BOLD=$'\033[1m'
  ACCENT=$'\033[38;2;167;139;250m'      # violet  #a78bfa
  ACCENT_BRIGHT=$'\033[38;2;196;181;253m' # #c4b5fd
  SUCCESS=$'\033[38;2;52;211;153m'      # mint    #34d399
  WARN=$'\033[38;2;251;191;36m'         # amber   #fbbf24
  ERROR=$'\033[38;2;248;113;113m'       # red     #f87171
  INFO=$'\033[38;2;148;163;184m'        # slate   #94a3b8
  MUTED=$'\033[38;2;100;116;139m'       # #64748b
  NC=$'\033[0m'
else
  BOLD=""; ACCENT=""; ACCENT_BRIGHT=""; SUCCESS=""; WARN=""; ERROR=""; INFO=""; MUTED=""; NC=""
fi

TAGLINE="your phone is the machine."
INSTALLER_HINT="installer · zero native modules · runs on a phone"

bold()  { printf '%s%s%s\n' "$BOLD" "$*" "$NC"; }
info()  { printf '  %s·%s %s\n' "$INFO" "$NC" "$*"; }
ok()    { printf '  %s✓%s %s\n' "$SUCCESS" "$NC" "$*"; }
warn()  { printf '  %s▲%s %s\n' "$WARN" "$NC" "$*"; }
fail()  { printf '  %s✗%s %s\n' "$ERROR" "$NC" "$*"; }
step()  { printf '\n  %s[%s/%s]%s %s%s%s\n' "$ACCENT" "$1" "$TOTAL_STEPS" "$NC" "$BOLD" "$2" "$NC"; }
kv()    { printf '        %s%-12s%s %s\n' "$MUTED" "$1" "$NC" "$2"; }

# The card: identity in a box (open right edge — immune to terminal width).
card() { # card <border-color> <line>...
  local border="$1"; shift
  local line
  printf '  %s┌────────────────────────────────────────────%s\n' "$border" "$NC"
  for line in "$@"; do
    printf '  %s│%s %s\n' "$border" "$NC" "$line"
  done
  printf '  %s└────────────────────────────────────────────%s\n' "$border" "$NC"
}

banner() {
  echo ""
  printf '  %s///%s  %sSUPARCLAW%s\n' "$ACCENT_BRIGHT" "$NC" "$BOLD$ACCENT" "$NC"
  printf '      %s%s%s\n' "$INFO" "$TAGLINE" "$NC"
  printf '      %s%s%s\n\n' "$MUTED" "$INSTALLER_HINT" "$NC"
}

celebrate() { # celebrate <line>
  printf '\n  %s🦀  %s%s%s\n' "$ACCENT_BRIGHT" "$BOLD" "$1" "$NC"
}

# One voice line at the end — an installer should have a pulse.
completion_line() {
  local lines=(
    "Snip snip. The claw is installed."
    "Small footprint. Big claw."
    "One phone. One daemon. Zero drama."
    "That's the whole install. Yes, really — 1.1 MB."
    "Freshly molted and ready to work."
    "You bring the problems. I'll bring the claws."
    "Home is a phone. Cozy."
  )
  printf '  %s%s%s\n' "$MUTED" "${lines[$((RANDOM % ${#lines[@]}))]}" "$NC"
}

TOTAL_STEPS=5
STAGE_T0=0
stage_done() {
  local dt=$(( $(date +%s) - STAGE_T0 ))
  [ "$dt" -ge 1 ] && printf '        %s↳ %ss%s\n' "$MUTED" "$dt" "$NC"
  return 0
}
stage() { STAGE_T0=$(date +%s); step "$1" "$2"; }

is_termux() { case "${PREFIX:-}" in *com.termux*) return 0 ;; *) return 1 ;; esac; }

uninstall() {
  echo ""
  printf '  %s///%s  %sSUPARCLAW%s  %suninstall%s\n\n' "$ACCENT_BRIGHT" "$NC" "$BOLD$ACCENT" "$NC" "$INFO" "$NC"
  for bin_dir in "${PREFIX:-}/bin" "${HOME}/.local/bin" "${HOME}/bin"; do
    [ -n "$bin_dir" ] || continue
    rm -f "$bin_dir/sc" "$bin_dir/suparclaw" 2>/dev/null || true
  done
  rm -rf "$PREFIX_DIR"
  ok "removed the launcher and $PREFIX_DIR"
  info "your ~/.suparclaw data was left untouched"
  echo ""
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --dir) PREFIX_DIR="$2"; shift 2 ;;
    --uninstall) uninstall ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) fail "unknown option: $1"; exit 1 ;;
  esac
done

banner

trap 'echo ""; warn "installation interrupted"; exit 130' INT
trap 'echo ""; warn "installation terminated"; exit 143' TERM

# ------------------------------------------------------------------ [1/5]
stage 1 "Checking your device"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${v%%.*}"; minor="$(printf '%s' "$v" | cut -d. -f2)"
  [ "$major" -gt "$MIN_NODE_MAJOR" ] && return 0
  [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ] && return 0
  return 1
}

if node_ok; then
  ok "node $(node -v) $(uname -m)$(is_termux && echo " · Termux" || true)"
else
  warn "node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required"
  if is_termux; then
    info "installing it with pkg (this can take a minute)…"
    command -v pkg >/dev/null 2>&1 && pkg install -y nodejs || true
  fi
  if node_ok; then
    ok "node $(node -v)"
  else
    fail "node >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} still missing."
    if is_termux; then info "run: pkg install nodejs"; else info "see https://nodejs.org (nvm or brew also fine)"; fi
    exit 1
  fi
fi

command -v curl >/dev/null 2>&1 || { fail "curl is required"; exit 1; }

# ------------------------------------------------------------------ [2/5]
stage 2 "Downloading SuparClaw"
kv "source" "${REPO}@${REF}"
mkdir -p "$PREFIX_DIR"
TARBALL_URL="${SUPARCLAW_TARBALL_URL:-https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}}"

# Private repos need a token. Pass it as SUPARCLAW_GITHUB_TOKEN (public needs nothing).
AUTH_ARGS=()
if [ -n "${SUPARCLAW_GITHUB_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: token ${SUPARCLAW_GITHUB_TOKEN}")
  info "using a GitHub token (private repo mode)"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; echo ""; warn "installation interrupted"; exit 130' INT
trap 'rm -rf "$TMP"; echo ""; warn "installation terminated"; exit 143' TERM

# Runtime files only — the install is the product, not the repo.
RUNTIME_FILES="dist skills README.md LICENSE package.json"

# Sparse clone first when git is around: a phone should fetch ~2 MB, not the
# whole history. The codeload tarball stays as the universal fallback.
SRC=""
if [ -z "${SUPARCLAW_TARBALL_URL:-}" ] && command -v git >/dev/null 2>&1 \
  && git clone --depth 1 --filter=blob:none --sparse --branch "$REF" "https://github.com/${REPO}.git" "$TMP/repo" 2>/dev/null; then
  # cone mode: root files (README, LICENSE, package.json) are already present
  (cd "$TMP/repo" && git sparse-checkout set dist skills) 2>/dev/null || true
  if [ -f "$TMP/repo/dist/sc.js" ]; then
    SRC="$TMP/repo"
    ok "sparse checkout ready (~2 MB, runtime files only)"
  fi
fi
if [ -z "$SRC" ] && curl -fL --progress-bar "${AUTH_ARGS[@]}" "$TARBALL_URL" -o "$TMP/sc.tgz" && tar -xzf "$TMP/sc.tgz" -C "$TMP" 2>/dev/null; then
  SRC="$(find "$TMP" -maxdepth 1 -type d -name 'SuparClaw-*' | head -1)"
  ok "source archive ready"
elif [ -z "$SRC" ] && command -v git >/dev/null 2>&1 && git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP/repo" 2>/dev/null; then
  SRC="$TMP/repo"
  ok "source ready"
fi
if [ -z "$SRC" ]; then
  fail "download failed"
  info "private repo? re-run with SUPARCLAW_GITHUB_TOKEN=<your token>"
  exit 1
fi
stage_done

# ------------------------------------------------------------------ [3/5]
stage 3 "Unpacking files"
rm -rf "$PREFIX_DIR/current"
mkdir -p "$PREFIX_DIR/current"
for f in $RUNTIME_FILES; do
  [ -e "$SRC/$f" ] && cp -R "$SRC/$f" "$PREFIX_DIR/current/"
done
[ -f "$PREFIX_DIR/current/dist/sc.js" ] || { fail "archive did not contain dist/"; exit 1; }
ok "installed $(du -sh "$PREFIX_DIR/current" 2>/dev/null | cut -f1 || echo "runtime") to $PREFIX_DIR/current"
stage_done

# ------------------------------------------------------------------ [4/5]
stage 4 "Wiring the sc command"
BIN_DIR="${PREFIX:-$HOME/.local}/bin"
[ -d "$BIN_DIR" ] || mkdir -p "$BIN_DIR" 2>/dev/null || BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR" 2>/dev/null || true
NODE_BIN="$(command -v node)"

cat > "$BIN_DIR/sc" <<EOF
#!/usr/bin/env bash
exec "$NODE_BIN" "$PREFIX_DIR/current/dist/sc.js" "\$@"
EOF
chmod +x "$BIN_DIR/sc"
ln -sf "$BIN_DIR/sc" "$BIN_DIR/suparclaw" 2>/dev/null || true
ok "launcher: $BIN_DIR/sc"
stage_done

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add this to ~/.bashrc:"
     info "export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# ------------------------------------------------------------------ [5/5]
stage 5 "Verifying install"
VERSION="$("$BIN_DIR/sc" version 2>/dev/null || echo '?')"
ok "suparclaw $VERSION ready"
stage_done

echo ""
card "$ACCENT" \
  "🦀  SuparClaw ${VERSION} is installed" \
  "${INFO}${TAGLINE}${NC}"
completion_line

echo ""
bold "  next steps"
printf '    %s1%s  sc init              workspace + gateway token\n' "$ACCENT" "$NC"
printf '    %s2%s  sc doctor            check this device\n' "$ACCENT" "$NC"
printf '    %s3%s  sc security audit    lock down the gateway\n' "$ACCENT" "$NC"
printf '    %s4%s  sc chat              say hello\n' "$ACCENT" "$NC"
printf '    %s5%s  sc gateway           run the daemon\n' "$ACCENT" "$NC"
echo ""
bold "  connect a model"
info "sc setup                                       guided provider setup"
info "sc config set providers.openai.apiKey \"sk-…\"    or configure by hand"
echo ""
bold "  go further"
info "background daemon:   sc gateway · sc service install (termux-services)"
info "telegram bot:        sc config set channels.telegram.enabled true"
info "                       sc pair approve <your-telegram-id>"
echo ""

"$BIN_DIR/sc" doctor || true
