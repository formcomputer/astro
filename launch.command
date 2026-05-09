#!/bin/bash
# launch.command — Astro Core
# Double-click to start. First run installs everything automatically.

cd "$(dirname "$0")"
ROOT="$(pwd)"
LOG="$ROOT/logs/launch.log"
mkdir -p "$ROOT/logs"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; DIM='\033[0;90m'; BOLD='\033[1m'; RESET='\033[0m'

log()  { echo "$(date '+%Y-%m-%d %H:%M:%S') $1" | tee -a "$LOG"; }
ok()   { echo -e "${GREEN}✓${RESET} $1 ${DIM}$2${RESET}"; log "OK: $1 $2"; }
warn() { echo -e "${YELLOW}⚠${RESET}  $1"; log "WARN: $1"; }
fail() { echo -e "${RED}✗${RESET}  $1"; log "FAIL: $1"; }
step() { echo -e "\n${CYAN}→${RESET} ${BOLD}$1${RESET}"; log "STEP: $1"; }
banner() {
  clear
  echo -e "${BOLD}"
  echo "  ┌─────────────────────────────────┐"
  echo "  │         ASTRO CORE              │"
  echo "  │         Infrastructure          │"
  echo "  └─────────────────────────────────┘"
  echo -e "${RESET}"
}

# ── flush mode (wipe + reinstall) ──────────────────────────────────────
flush_mode() {
  echo -e "\n${RED}${BOLD}FLUSH MODE — this will wipe all data and reinstall.${RESET}"
  read -p "Are you sure? Type YES to continue: " confirm
  [[ "$confirm" != "YES" ]] && { warn "Flush cancelled."; return 1; }
  log "=== FLUSH STARTED ==="
  step "Stopping all services..."
  pkill -f "node server/server.js" 2>/dev/null
  brew services stop mysql 2>/dev/null
  pkill -f "turnserver" 2>/dev/null
  ok "Services stopped"
  step "Uninstalling MySQL..."
  brew uninstall --force mysql 2>/dev/null; ok "MySQL uninstalled"
  step "Uninstalling coTURN..."
  brew uninstall --force coturn 2>/dev/null; ok "coTURN uninstalled"
  step "Wiping MySQL data..."
  sudo rm -rf /usr/local/var/mysql /opt/homebrew/var/mysql 2>/dev/null; ok "MySQL data wiped"
  step "Wiping Astro config..."
  rm -f "$ROOT/config/astro.json" "$ROOT/ADMIN_PASSWORD.txt" 2>/dev/null; ok "Config wiped"
  ok "Flush complete. Continuing with fresh install..."
  return 0
}

banner
log "=== ASTRO CORE LAUNCH ==="

# ── flush flag ──────────────────────────────────────────────────────────
if [[ "$1" == "--flush" ]]; then
  flush_mode || { warn "Flush skipped. Proceeding with normal setup."; }
fi

# ── system check ────────────────────────────────────────────────────────
step "Checking system..."
if [[ "$(uname)" != "Darwin" ]]; then fail "macOS required."; exit 1; fi
ARCH=$(uname -m); ok "macOS detected ($ARCH)"

# ── homebrew ────────────────────────────────────────────────────────────
step "Checking Homebrew..."
if ! command -v brew &>/dev/null; then
  warn "Homebrew not found. Installing..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi
ok "Homebrew found"

# ── node ────────────────────────────────────────────────────────────────
step "Checking Node.js..."
if ! command -v node &>/dev/null; then
  warn "Node.js not found. Installing via Homebrew..."
  brew install node
fi
NODE_VER=$(node -v); ok "Node.js found ($NODE_VER)"

# ── mysql ────────────────────────────────────────────────────────────────
step "Checking MySQL..."
if ! command -v mysql &>/dev/null; then
  warn "MySQL not found. Installing..."
  brew install mysql
  # Fix data dir permissions
  MYSQL_DATA=$(brew --prefix)/var/mysql
  sudo mkdir -p "$MYSQL_DATA"
  sudo chown -R "$(whoami)" "$MYSQL_DATA"
  mysqld --initialize-insecure --user="$(whoami)" --datadir="$MYSQL_DATA" 2>/dev/null
fi
ok "MySQL found"

step "Starting MySQL..."
# Fix permissions before starting
MYSQL_DATA=$(brew --prefix)/var/mysql
sudo chown -R "$(whoami)" "$MYSQL_DATA" 2>/dev/null
brew services start mysql 2>/dev/null
sleep 3
if mysql -u root -e "SELECT 1" &>/dev/null; then
  ok "MySQL running"
else
  # Try mysqld_safe direct start as fallback
  warn "brew services start failed, trying direct start..."
  mysqld_safe --user="$(whoami)" &>/dev/null &
  sleep 4
  mysql -u root -e "SELECT 1" &>/dev/null && ok "MySQL running (direct)" || { fail "MySQL failed to start. Check permissions on $(brew --prefix)/var/mysql"; exit 1; }
fi

# ── coturn ───────────────────────────────────────────────────────────────
step "Checking coTURN..."
if ! command -v turnserver &>/dev/null; then
  warn "coTURN not found. Installing..."
  brew install coturn
fi
ok "coTURN found"

# ── node dependencies ────────────────────────────────────────────────────
step "Checking Node dependencies..."
if [[ ! -d "$ROOT/node_modules" ]] || [[ ! -f "$ROOT/node_modules/.package-lock.json" ]]; then
  warn "Installing npm packages..."
  cd "$ROOT" && npm install
  [[ $? -ne 0 ]] && { fail "npm install failed."; exit 1; }
fi
ok "Node dependencies ready"

# ── first-run setup ──────────────────────────────────────────────────────
step "Checking Astro config..."
if [[ ! -f "$ROOT/config/astro.json" ]]; then
  warn "No config found. Running first-time setup..."
  node "$ROOT/bin/setup.js"
  [[ $? -ne 0 ]] && { fail "Setup failed."; exit 1; }
  ok "First-run setup complete"
  if [[ -f "$ROOT/ADMIN_PASSWORD.txt" ]]; then
    echo ""
    echo -e "${YELLOW}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    cat "$ROOT/ADMIN_PASSWORD.txt"
    echo -e "${YELLOW}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
    echo ""
  fi
else
  ok "Config found"
fi

# ── tls certs ────────────────────────────────────────────────────────────
step "Checking TLS certs..."
if [[ ! -f "$ROOT/config/tls/cert.pem" ]]; then
  warn "Generating self-signed TLS certs..."
  mkdir -p "$ROOT/config/tls"
  openssl req -x509 -newkey rsa:4096 -keyout "$ROOT/config/tls/key.pem" \
    -out "$ROOT/config/tls/cert.pem" -days 3650 -nodes \
    -subj "/CN=astro-core" 2>/dev/null
fi
ok "TLS certs ready"

# ── coturn config ────────────────────────────────────────────────────────
step "Checking coTURN config..."
if [[ ! -f "$ROOT/config/turnserver.conf" ]]; then
  TURN_SECRET=$(node -e "const c=require('$ROOT/config/astro.json');console.log(c.turnSecret)")
  LOCAL_IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || echo "127.0.0.1")
  cat > "$ROOT/config/turnserver.conf" << TURNEOF
listening-port=3478
tls-listening-port=5349
listening-ip=$LOCAL_IP
relay-ip=$LOCAL_IP
external-ip=$LOCAL_IP
server-name=astro-core
realm=astro-core
use-auth-secret
static-auth-secret=$TURN_SECRET
cert=$ROOT/config/tls/cert.pem
pkey=$ROOT/config/tls/key.pem
no-stdout-log
log-file=$ROOT/logs/coturn.log
pidfile=$ROOT/logs/coturn.pid
min-port=49152
max-port=65535
TURNEOF
fi
ok "coTURN config ready"

# ── stop any existing instances ───────────────────────────────────────────
step "Stopping any running instances..."
[[ -f "$ROOT/logs/server.pid" ]] && OLD_PID=$(cat "$ROOT/logs/server.pid") && kill "$OLD_PID" 2>/dev/null && sleep 1
[[ -f "$ROOT/logs/coturn.pid" ]] && OLD_CPID=$(cat "$ROOT/logs/coturn.pid") && kill "$OLD_CPID" 2>/dev/null && sleep 1
pkill -f "node $ROOT/server/server.js" 2>/dev/null
ok "Old instances cleared"

# ── start coturn ─────────────────────────────────────────────────────────
step "Starting coTURN..."
turnserver -c "$ROOT/config/turnserver.conf" &
COTURN_PID=$!
sleep 2
if kill -0 $COTURN_PID 2>/dev/null; then
  echo $COTURN_PID > "$ROOT/logs/coturn.pid"
  ok "coTURN" "(pid $COTURN_PID)"
else
  warn "coTURN failed to start — P2P relay unavailable, REST fallback active"
fi

# ── build dashboard ───────────────────────────────────────────────────────
step "Building dashboard..."
cd "$ROOT/dashboard"
npm install --silent 2>/dev/null
npm run build 2>&1 | tee -a "$LOG" | grep -E "✓|error|Error|warn" | head -5
[[ ${PIPESTATUS[0]} -ne 0 ]] && { fail "Dashboard build failed."; exit 1; }
ok "Dashboard built"
cd "$ROOT"

# ── start server ──────────────────────────────────────────────────────────
step "Starting Astro Core..."
node "$ROOT/server/server.js" >> "$ROOT/logs/server.log" 2>&1 &
SERVER_PID=$!
sleep 3
if kill -0 $SERVER_PID 2>/dev/null; then
  echo $SERVER_PID > "$ROOT/logs/server.pid"
  ok "Astro Core" "(pid $SERVER_PID)"
else
  fail "Server failed to start. Check $ROOT/logs/server.log"
  exit 1
fi

# ── watchdog ─────────────────────────────────────────────────────────────
(while true; do
  sleep 10
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    log "WATCHDOG: Server died, restarting..."
    node "$ROOT/server/server.js" >> "$ROOT/logs/server.log" 2>&1 &
    SERVER_PID=$!
    echo $SERVER_PID > "$ROOT/logs/server.pid"
    log "WATCHDOG: Restarted (pid $SERVER_PID)"
  fi
done) &
WATCHDOG_PID=$!

# ── caffeinate (prevent sleep) ────────────────────────────────────────────
caffeinate -dims &
CAFE_PID=$!
echo $CAFE_PID > "$ROOT/logs/caffeinate.pid"

# ── open dashboard ────────────────────────────────────────────────────────
PORT=$(node -e "const c=require('$ROOT/config/astro.json');console.log(c.ports.http)" 2>/dev/null || echo 2000)
sleep 1
open "http://localhost:$PORT"

# ── done ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo -e "${GREEN}${BOLD}  Astro Core is running.${RESET}"
echo -e "  Dashboard  →  ${CYAN}http://localhost:$PORT${RESET}"
echo -e "  Server log →  ${DIM}logs/server.log${RESET}"
echo -e "  Stop       →  ${DIM}kill $SERVER_PID${RESET}"
echo -e "${GREEN}${BOLD}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${RESET}"
echo ""
log "launch complete. server: $SERVER_PID watchdog: $WATCHDOG_PID caffeinate: $CAFE_PID"

# Keep terminal open so logs are visible
tail -f "$ROOT/logs/server.log"
