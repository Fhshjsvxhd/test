#!/usr/bin/env bash
# Add HTTPS + domain for an existing Cloakly install
# Usage:  sudo bash install-https.sh your-domain.com [email]
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-admin@$DOMAIN}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cloakly}"
APP_PORT="${APP_PORT:-3000}"

[ -z "$DOMAIN" ] && { echo "Usage: sudo bash install-https.sh your-domain.com [email]"; exit 1; }
[ "$EUID" -eq 0 ] || { echo "Run as root"; exit 1; }

GRN="\033[32m"; BLU="\033[34m"; RST="\033[0m"
step() { echo -e "\n${BLU}==>${RST} $*"; }

step "Reconfiguring Cloakly to port $APP_PORT"
ENV_FILE="$INSTALL_DIR/.env"
if grep -q '^PORT=' "$ENV_FILE"; then
  sed -i "s/^PORT=.*/PORT=$APP_PORT/" "$ENV_FILE"
else
  echo "PORT=$APP_PORT" >> "$ENV_FILE"
fi
SERVICE_USER=$(stat -c '%U' "$INSTALL_DIR")
sudo -u "$SERVICE_USER" -H bash -lc "pm2 restart cloakly --update-env"

step "Installing nginx and certbot"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y nginx certbot python3-certbot-nginx
else
  dnf install -y nginx certbot python3-certbot-nginx || yum install -y nginx certbot python3-certbot-nginx
fi

step "Writing nginx vhost for $DOMAIN"
cat >/etc/nginx/conf.d/cloakly.conf <<NGX
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGX

rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true
nginx -t
systemctl enable nginx
systemctl restart nginx

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full' >/dev/null || true
fi

step "Requesting Let's Encrypt certificate"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo
echo -e "${GRN}Done! https://$DOMAIN/${RST}"
