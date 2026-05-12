#!/usr/bin/env bash
# Add HTTPS + domain to an existing AdTrack install.
# Usage:  sudo bash install-https.sh your-domain.com [your-email@example.com]
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-admin@$DOMAIN}"
INSTALL_DIR="${INSTALL_DIR:-/opt/adtrack}"
APP_PORT="${APP_PORT:-3000}"

[ -z "$DOMAIN" ] && { echo "Usage: sudo bash install-https.sh your-domain.com [email]"; exit 1; }
[ "$EUID" -eq 0 ] || { echo "Run as root: sudo bash install-https.sh ..."; exit 1; }

C_GREEN="\033[32m"; C_BLUE="\033[34m"; C_RESET="\033[0m"
step() { echo -e "\n${C_BLUE}==>${C_RESET} $*"; }

# 1. move AdTrack off port 80 to 3000 (nginx will take 80/443)
step "Reconfiguring AdTrack to listen on 127.0.0.1:$APP_PORT"
ENV_FILE="$INSTALL_DIR/.env"
if grep -q '^PORT=' "$ENV_FILE"; then
  sed -i "s/^PORT=.*/PORT=$APP_PORT/" "$ENV_FILE"
else
  echo "PORT=$APP_PORT" >> "$ENV_FILE"
fi

SERVICE_USER=$(stat -c '%U' "$INSTALL_DIR")
sudo -u "$SERVICE_USER" -H bash -lc "pm2 restart adtrack --update-env"

# 2. install nginx + certbot
step "Installing nginx and certbot"
if command -v apt-get >/dev/null; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y nginx certbot python3-certbot-nginx
else
  dnf install -y nginx certbot python3-certbot-nginx || yum install -y nginx certbot python3-certbot-nginx
fi

# 3. nginx vhost
step "Writing nginx vhost for $DOMAIN"
cat >/etc/nginx/conf.d/adtrack.conf <<NGX
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

# disable default site if present
rm -f /etc/nginx/sites-enabled/default 2>/dev/null || true

nginx -t
systemctl enable nginx
systemctl restart nginx

# 4. firewall
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 'Nginx Full' >/dev/null || true
  ufw delete allow 80/tcp >/dev/null 2>&1 || true
fi

# 5. certbot
step "Requesting Let's Encrypt certificate"
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect

echo
echo -e "${C_GREEN}Done!${C_RESET}"
echo -e "  https://$DOMAIN/"
echo -e "  https://$DOMAIN/admin"
echo -e "  https://$DOMAIN/t/demo"
