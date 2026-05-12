#!/usr/bin/env bash
# Cloakly one-line installer
# Usage:  curl -fsSL https://raw.githubusercontent.com/Fhshjsvxhd/test/main/install.sh | sudo bash
# or:     sudo bash install.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Fhshjsvxhd/test.git}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cloakly}"
SERVICE_USER="${SERVICE_USER:-cloakly}"
PORT="${PORT:-80}"
BRANCH="${BRANCH:-main}"

GRN="\033[32m"; BLU="\033[34m"; YLW="\033[33m"; RED="\033[31m"; RST="\033[0m"
step()  { echo -e "\n${BLU}==>${RST} $*"; }
ok()    { echo -e "${GRN}[OK]${RST} $*"; }
warn()  { echo -e "${YLW}[!!]${RST} $*"; }
die()   { echo -e "${RED}[XX]${RST} $*" >&2; exit 1; }

[ "$EUID" -eq 0 ] || die "Run as root:  sudo bash install.sh"

# detect package manager
if   command -v apt-get >/dev/null; then PM=apt
elif command -v dnf     >/dev/null; then PM=dnf
elif command -v yum     >/dev/null; then PM=yum
else die "Unsupported distro (need apt/dnf/yum)"
fi
ok "Package manager: $PM"

step "Installing prerequisites"
if [ "$PM" = "apt" ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y curl git ca-certificates build-essential python3 ufw sqlite3 libcap2-bin
else
  $PM install -y curl git ca-certificates gcc-c++ make python3 sqlite libcap
fi

step "Ensuring Node.js 20+"
NODE_OK=0
if command -v node >/dev/null; then
  NV=$(node -v | sed -E 's/v([0-9]+).*/\1/')
  [ "$NV" -ge 18 ] && NODE_OK=1
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

step "Installing PM2"
npm install -g pm2 --silent

if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  step "Creating user '$SERVICE_USER'"
  useradd --system --create-home --shell /bin/bash "$SERVICE_USER"
fi

step "Installing Cloakly into $INSTALL_DIR"
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

step "Running npm install"
sudo -u "$SERVICE_USER" -H bash -lc "cd '$INSTALL_DIR' && npm install --omit=dev --no-audit --no-fund"

ENV_FILE="$INSTALL_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  step "Generating .env with a random admin token"
  ADMIN_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")
  cat > "$ENV_FILE" <<EOF
PORT=$PORT
ADMIN_TOKEN=$ADMIN_TOKEN
DB_PATH=$INSTALL_DIR/data/cloakly.db
TRUST_PROXY=1
EOF
  chown "$SERVICE_USER:$SERVICE_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
else
  warn ".env already exists, keeping it"
  ADMIN_TOKEN=$(grep -E '^ADMIN_TOKEN=' "$ENV_FILE" | cut -d= -f2-)
fi

if [ "$PORT" -lt 1024 ]; then
  step "Granting Node.js permission to bind to port $PORT"
  NODE_BIN=$(readlink -f "$(command -v node)")
  setcap 'cap_net_bind_service=+ep' "$NODE_BIN" || warn "setcap failed (not critical on some systems)"
fi

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  step "Opening firewall port $PORT"
  ufw allow "$PORT/tcp" >/dev/null || true
fi

step "Starting Cloakly via PM2"
sudo -u "$SERVICE_USER" -H bash -lc "cd '$INSTALL_DIR' && pm2 delete cloakly >/dev/null 2>&1; pm2 start src/server.js --name cloakly --update-env"
sudo -u "$SERVICE_USER" -H bash -lc "pm2 save"

step "Installing systemd service for autostart"
env PATH="$PATH:/usr/bin" pm2 startup systemd -u "$SERVICE_USER" --hp "/home/$SERVICE_USER" >/tmp/pm2_startup 2>&1 || true
tail -1 /tmp/pm2_startup | grep -E '^(sudo\s+)?env' | bash || true

IP=$(curl -fsSL --max-time 3 https://api.ipify.org || hostname -I | awk '{print $1}')
sleep 1

echo
echo -e "${GRN}========================================================${RST}"
echo -e "${GRN}  Cloakly installed successfully${RST}"
echo -e "${GRN}========================================================${RST}"
echo
echo -e "  Public landing : http://$IP/"
echo -e "  Dashboard      : http://$IP/admin"
echo
echo -e "  Admin token    : ${YLW}$ADMIN_TOKEN${RST}"
echo -e "  (also stored in $ENV_FILE)"
echo
echo -e "  Logs           : sudo -u $SERVICE_USER pm2 logs cloakly"
echo -e "  Restart        : sudo -u $SERVICE_USER pm2 restart cloakly"
echo -e "  Update         : sudo bash $INSTALL_DIR/install.sh"
echo
echo -e "  To attach a domain:"
echo -e "    1) A-record  your-domain.com -> $IP"
echo -e "    2) In dashboard: edit your flow -> set Custom domain"
echo
