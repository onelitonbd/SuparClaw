#!/usr/bin/env bash
# SuparClaw installer — Termux-first, no root, no sudo, no sudoers, no build tools required.
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

bold()  { printf '\033[1m%s\033[22m\n' "$1"; }
ok()    { printf '\033[32m✔\033[39m %s\n' "$1"; }
warn()  { printf '\033[33m▲\033[39m %s\n' "$1"; }
fail()  { printf '\033[31m✖\033[39m %s\n' "$1"; }
info()  { printf '  %s\n' "$1"; }

is_termux() { [ -n "${TERMUX_VERSION:-}" ] || [ "${PREFIX:-}" = "${PREFIX:-/nonexistent}" ]; }
termux() {
  case "${PREFIX:-}" in *com.termux*) return 0 ;; *) return 1 ;; esac
}

uninstall() {
  for bin_dir in "${PREFIX:-}/bin" "${HOME}/.local/bin" "${HOME}/bin"; do
    [ -n "$bin_dir" ] || continue
    rm -f "$bin_dir/sc" "$bin_dir/suparclaw" 2>/dev/null || true
  done
  rm -rf "$PREFIX_DIR"
  ok "SuparClaw removed (your ~/.suparclaw data was left untouched)"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --dir) PREFIX_DIR="$2"; shift 2 ;;
    --uninstall) uninstall; exit 0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) fail "unknown option: $1"; exit 1 ;;
  esac
done

printf '\n\033[1m  SuparClaw\033[22m — personal AI gateway for your phone\n\n'

# ---------------------------------------------------------------- node check
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  local v major minor
  v="$(node -v 2>/dev/null | sed 's/^v//')"
  major="${v%%.*}"; minor="$(printf '%s' "$v" | cut -d. -f2)"
  [ "$major" -gt "$MIN_NODE_MAJOR" ] && return 0
  [ "$major" -eq "$MIN_NODE_MAJOR" ] && [ "$minor" -ge "$MIN_NODE_MINOR" ] && return 0
  return 1
}

if ! node_ok; then
  warn "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} is required"
  if termux; then
    info "installing it with pkg (this can take a minute)…"
    if command -v pkg >/dev/null 2>&1; then
      pkg install -y nodejs || true
    fi
  fi
  if ! node_ok; then
    fail "Node.js >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} still missing."
    if termux; then info "run: pkg install nodejs"; else info "see https://nodejs.org (nvm or brew also fine)"; fi
    exit 1
  fi
fi
ok "node $(node -v)"

# ------------------------------------------------------------------- fetch
command -v curl >/dev/null 2>&1 || { fail "curl is required"; exit 1; }
mkdir -p "$PREFIX_DIR"
TARBALL_URL="${SUPARCLAW_TARBALL_URL:-https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}}"

# Private repos need a token. Pass it as SUPARCLAW_GITHUB_TOKEN (a public repo needs nothing).
AUTH_ARGS=()
if [ -n "${SUPARCLAW_GITHUB_TOKEN:-}" ]; then
  AUTH_ARGS=(-H "Authorization: token ${SUPARCLAW_GITHUB_TOKEN}")
  info "using a GitHub token (private repo mode)"
fi

info "downloading ${REPO}@${REF} …"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if curl -fsSL "${AUTH_ARGS[@]}" "$TARBALL_URL" -o "$TMP/sc.tgz" && tar -xzf "$TMP/sc.tgz" -C "$TMP" 2>/dev/null; then
  SRC="$(find "$TMP" -maxdepth 1 -type d -name 'SuparClaw-*' | head -1)"
elif command -v git >/dev/null 2>&1 && git clone --depth 1 --branch "$REF" "https://github.com/${REPO}.git" "$TMP/repo" 2>/dev/null; then
  SRC="$TMP/repo"
else
  fail "download failed"
  info "private repo? re-run with SUPARCLAW_GITHUB_TOKEN=<your token>"
  exit 1
fi
[ -n "$SRC" ] || { fail "could not unpack archive"; exit 1; }
ok "source ready"

rm -rf "$PREFIX_DIR/current"
mkdir -p "$PREFIX_DIR/current"
if command -v tar >/dev/null 2>&1 && [ -n "$(find "$SRC" -maxdepth 1 -type d -name dist -print -quit)" ]; then
  # copy without tar for correctness on odd shells
  cp -R "$SRC/." "$PREFIX_DIR/current/"
  rm -rf "$PREFIX_DIR/current/.git" "$PREFIX_DIR/current/node_modules"
fi
[ -f "$PREFIX_DIR/current/dist/sc.js" ] || { fail "archive did not contain dist/"; exit 1; }
ok "installed to $PREFIX_DIR/current"

# ---------------------------------------------------------------- launcher
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

case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) warn "$BIN_DIR is not on your PATH — add this to ~/.bashrc:"
     info "export PATH=\"$BIN_DIR:\$PATH\"" ;;
esac

# ------------------------------------------------------------------ verify
VERSION="$("$BIN_DIR/sc" version 2>/dev/null || echo '?')"
ok "sc $VERSION installed"

bold ""
bold "  next steps"
info "1) sc init                       # workspace files (AGENTS.md, SOUL.md, …) + gateway token"
info "2) sc doctor                     # check this device"
info "3) sc config set agents.defaults.model \"openai/gpt-4o-mini\""
info "   sc config set providers.openai.baseUrl \"https://api.openai.com/v1\""
info "   sc config set providers.openai.apiKey  \"sk-...\""
info "4) sc chat                       # start chatting"
bold ""
info "background daemon:   sc gateway"
info "auto-start on boot:  sc service install   (termux-services)"
info "Telegram bot:        sc config set channels.telegram.enabled true"
info "                     sc config set channels.telegram.token <bot-token>"
info "                     sc pair approve <your-telegram-id>"
bold ""

"$BIN_DIR/sc" doctor || true