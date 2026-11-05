#!/bin/bash
# Jimmy for Mac: starts the local server in the background (no window) and opens the editor.
# Started by "Jimmy.app"; server output goes to data/server.log. It stops by itself when the editor window is closed.
cd "$(dirname "$0")/.." || exit 1
APP="$(pwd)"

# Apps opened from Finder get a bare PATH: add the usual Homebrew / npm / Claude locations and the login shell's PATH.
LOGIN_PATH="$(/bin/zsh -lc 'printf %s "$PATH"' 2>/dev/null)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.npm-global/bin:$HOME/.claude/local:${LOGIN_PATH}:$PATH"

# Started under Rosetta (Intel emulation) on Apple Silicon: restart natively, so Node matches the arm64 modules.
if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" = "1" ]; then
  exec arch -arm64 /bin/bash "$0" "$@"
fi

alert() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button 1 with title \"Jimmy - The Editor\" with icon caution" >/dev/null 2>&1
}

if ! command -v node >/dev/null 2>&1; then
  alert "Node.js 20 or newer is required. Install it from nodejs.org (or run: brew install node), then open Jimmy again."
  open "https://nodejs.org"
  exit 1
fi
command -v ffmpeg >/dev/null 2>&1 || alert "ffmpeg is not installed — previews and exports need it. Install it with: brew install ffmpeg"

mkdir -p data
PORT="$(node -e "try{console.log(require('./data/config.json').port||4377)}catch{console.log(4377)}" 2>/dev/null)"

# Already running: just open another editor window.
if curl -s -m 1 "http://127.0.0.1:${PORT:-4377}/api/state" >/dev/null 2>&1; then
  node server/index.js --open >/dev/null 2>&1 &
  exit 0
fi

# Modules were installed for a different CPU type (e.g. Intel Node vs Apple Silicon Node): reinstall them.
ARCH="$(node -p 'process.platform + "-" + process.arch' 2>/dev/null)"
if [ -f node_modules/.claude-edit-installed ] && [ "$(cat node_modules/.claude-edit-installed 2>/dev/null)" != "$ARCH" ]; then
  if [ -n "$(cat node_modules/.claude-edit-installed 2>/dev/null)" ] || ! node -e "require('@lydell/node-pty')" >/dev/null 2>&1; then
    rm -rf node_modules
  else
    echo "$ARCH" > node_modules/.claude-edit-installed
  fi
fi

# First run (or an earlier install that didn't finish): install dependencies in a visible Terminal window, then start.
# A .command file opened with `open` runs in Terminal without needing permission to control Terminal.
if [ ! -f node_modules/.claude-edit-installed ]; then
  cat > data/install.command <<EOF
#!/bin/bash
export PATH="$PATH"
cd "$APP" || exit 1
echo 'Installing Jimmy (first run)...'
if npm install && node -p 'process.platform + "-" + process.arch' > node_modules/.claude-edit-installed; then
  # Claude Code powers the Claude panel: install it, offer to add it to PATH, and sign in (standard browser login)
  if ! command -v claude >/dev/null 2>&1; then
    echo
    read -r -p 'Claude Code powers the Claude panel. Install it now? [Y/n] ' a
    if [[ ! "\$a" =~ ^[Nn] ]]; then curl -fsSL https://claude.ai/install.sh | bash; fi
    export PATH="\$HOME/.local/bin:\$PATH"
  fi
  if command -v claude >/dev/null 2>&1; then
    if ! /bin/zsh -lc 'command -v claude' >/dev/null 2>&1; then
      read -r -p 'Add Claude Code to your PATH so Terminal can find "claude"? [Y/n] ' a
      if [[ ! "\$a" =~ ^[Nn] ]]; then echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> "\$HOME/.zshrc"; echo 'Added to ~/.zshrc'; fi
    fi
    if ! claude auth status 2>/dev/null | grep -q '"loggedIn": true'; then
      echo
      echo 'Sign in to Claude: your browser opens the standard Claude login page. Approve it, then come back here.'
      read -r -p 'Sign in now? [Y/n] ' a
      if [[ ! "\$a" =~ ^[Nn] ]]; then claude auth login; fi
    fi
  fi
  /bin/bash "$APP/bin/start-mac.sh"
  echo 'Done - you can close this window.'
  exit 0
fi
echo
echo 'Install failed (see the messages above). Check your internet connection, then open Jimmy again.'
read -n 1 -s -r -p 'Press any key to close.'
EOF
  chmod +x data/install.command
  open -a Terminal "$APP/data/install.command"
  exit 0
fi

# set -m puts the server in a process group of its own, so it isn't ended along with this script's group
# when Jimmy.app's launcher exits (or the first-run Terminal window is closed).
set -m
nohup node server/index.js --open > data/server.log 2>&1 &
PID=$!
sleep 3
if ! kill -0 "$PID" 2>/dev/null; then
  alert "Jimmy's server stopped right after starting. Details are in: $APP/data/server.log"
  open -a TextEdit "$APP/data/server.log"
  exit 1
fi
exit 0
