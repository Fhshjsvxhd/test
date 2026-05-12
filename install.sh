#!/usr/bin/env bash
# AdTrack one-line installer
# Usage:  curl -fsSL https://raw.githubusercontent.com/Fhshjsvxhd/test/main/install.sh | sudo bash
# or:     sudo bash install.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Fhshjsvxhd/test.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/adtrack}"
SERVICE_USER="${SERVICE_USER:-adtrack}"
PORT="${PORT:-80}"
BRANCH="${BRANCH:-main}"

C_GREEN="\033[32m"; C_BLUE="\033[34m"; C_YELLOW="\033[33m"; C_RED="\033[31m"; C_RESET="\033[0m"
step()  { echo -e "\n${C_BLUE}==>${C_RESET} $*"; }
ok()    { echo -e "${C_GREEN}[OK]${C_RESET} $*"; }
warn()  { echo -e "${C_YELLOW}[!!]${C_RESET} $*"; }
die()   { echo -e "${C_RED}[XX]${C_RESET} $*" >&2; exit 1; }

[ "$EUID" -eq 0 ] || die "Run as root:  sudo bash install.sh"

# ---------- detect package manager ----------
if   command -v apt-get >/dev/null 2>&1; then PM=apt
elif command -v dnf     >/dev/null 2>&1; then PM=dnf
elif command -v yum     >/dev/null 2>&1; then PM=yum
else die "Unsupported distro (need apt/dnf/yum). Use Ubuntu, Debian, Rocky or AlmaLinux."
fi
ok "Detected package manager: $PM"

# ---------- install prerequisites ----------
step "Installing prerequisites (curl, git, build tools)"
if [ "$PM" = "apt" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl git ca-certificates build-essential python3 ufw sqlite3
else
  $PM install -y curl git ca-certificates gcc-c++ make python3 sqlite
fi

# ---------- install Node.js 20 if missing ----------
step "Ensuring Node.js 20+ is installed"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed -E 's/v([0-9]+).*/\1/')
  [ "$NODE_MAJOR" -ge 18 ] && NODE_OK=1
fi
if [ "$NODE_OK" -eq 0 ]; then
  if [ "$PM" = "apt" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  else
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    $PM install -y nodejs
  fi
fi
ok "Node $(node -v) / npm $(npm -v)"

# ---------- install PM2 globally ----------
step "Installing PM2 process manager"
npm install -g pm2 --silent

# ---------- create service user ----------
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  step "Creating system user '$SERVICE_USER'"
  useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
fi

# ---------- clone / update repo ----------
step "Installing AdTrack into $INSTALL_DIR"

# If the script is being run from an already-cloned directory (e.g. private repo
# cloned manually), use that directory as the source rather than re-cloning.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "$SCRIPT_DIR/package.json" ] && [ -d "$SCRIPT_DIR/src" ]; then
  if [ "$SCRIPT_DIR" != "$INSTALL_DIR" ]; then
    mkdir -p "$INSTALL_DIR"
    cp -a "$SCRIPT_DIR/." "$INSTALL_DIR/"
  fi
  ok "Using local source from $SCRIPT_DIR"
elif [ -d "$INSTALL_DIR/.git" ]; then
  git -C "$INSTALL_DIR" fetch --all
  git -C "$INSTALL_DIR" reset --hard "origin/$BRANCH"
else
  mkdir -p "$INSTALL_DIR"
  if ! git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$INSTALL_DIR" 2>/dev/null; then
    die "Failed to clone $REPO_URL. If this is a private repo, clone it manually first:
  sudo git clone https://TOKEN@github.com/OWNER/REPO.git $INSTALL_DIR
  sudo bash $INSTALL_DIR/install.sh"
  fi
fi
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"

# ---------- install deps ----------
step "Running npm install (this may take a minute)"
sudo -u "$SERVICE_USER" -H bash -lc "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund"

# ---------- create .env if missing ----------
ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  step "Generating .env with a random admin token"
  ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
ADMIN_TOKEN=$ADMIN_TOKEN
DB_PATH=$INSTALL_DIR/data/adtrack.db
TRUST_PROXY=1
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  warn ".env already exists, keeping it"
  ADMIN_TOKEN=$(grep -E '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
fi

# ---------- seed demo data (only on first install) ----------
if [ ! -f "$INSTALL_DIR/data/adtrack.db" ]; then
  step "Seeding demo campaign"
  sudo -u "$SERVICE_USER" -H bash -lc "cd '$INSTALL_DIR' && npm run seed" || true
fi

# ---------- allow binding to port 80 without root ----------
if [ "$PORT" -lt 1024 ]; then
  step "Granting Node.js permission to bind to port $PORT"
  NODE_BIN=$(readlink -f "$(command -v node)")
  setcap 'cap_net_bind_service=+ep' "$NODE_BIN" || warn "setcap failed, will fallback to root"
fi

# ---------- firewall ----------
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  step "Opening firewall port $PORT"
  ufw allow "$PORT/tcp" >/dev/null || true
fi

# ---------- PM2 service ----------
step "Starting AdTrack via PM2"
sudo -u "$SERVICE_USER" -H bash -lc "cd '$INSTALL_DIR' && pm2 delete adtrack >/dev/null 2>&1; pm2 start src/server.js --name adtrack --update-env"
sudo -u "$SERVICE_USER" -H bash -lc "pm2 save"

# systemd unit so it survives reboot
step "Installing systemd service for autostart"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$SERVICE_USER" --hp "/home/$SERVICE_USER" >/tmp/pm2_startup 2>&1 || true
# the command above prints a setup command already run by root; re-run just in case
tail -1 /tmp/pm2_startup | grep -E '^(sudo\s+)?env' | bash || true

# ---------- done ----------
IP=$(curl -fsSL --max-time 3 https://api.ipify.org || hostname -I | awk '{print $1}')
sleep 1

echo
echo -e "${C_GREEN}======================================================${C_RESET}"
echo -e "${C_GREEN}  AdTrack installed successfully${C_RESET}"
echo -e "${C_GREEN}======================================================${C_RESET}"
echo
echo -e "  Public landing : http://$IP/"
echo -e "  Dashboard      : http://$IP/admin"
echo -e "  Demo tracker   : http://$IP/t/demo"
echo
echo -e "  Admin token    : ${C_YELLOW}$ADMIN_TOKEN${C_RESET}"
echo -e "  (also stored in $ENV_FILE)"
echo
echo -e "  Logs           : sudo -u $SERVICE_USER pm2 logs adtrack"
echo -e "  Restart        : sudo -u $SERVICE_USER pm2 restart adtrack"
echo -e "  Update         : sudo bash $INSTALL_DIR/install.sh"
echo
echo -e "  To point a domain here:"
echo -e "    1) set an A-record  your-domain.com -> $IP"
echo -e "    2) it will just work on http://your-domain.com"
echo -e "    3) for HTTPS:  sudo bash $INSTALL_DIR/install-https.sh your-domain.com"
echo
