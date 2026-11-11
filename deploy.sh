#!/usr/bin/env bash
# Safe first-install script for the legacy shared-database runtime.
set -Eeuo pipefail
umask 077
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SERVICE=house-sys
ENV_FILE=/etc/house-sys.env
PORT=16088
DB_HOST=127.0.0.1
DB_PORT=3306
DRY_RUN=0
NON_INTERACTIVE=0
SKIP_FIREWALL=0
usage(){ echo "Usage: sudo bash deploy.sh [--port N] [--db-host HOST] [--db-port N] [--non-interactive] [--skip-firewall] [--dry-run]"; }
die(){ echo "ERROR: $*" >&2; exit 1; }
while [ "$#" -gt 0 ]; do
 case "$1" in
  --port) [ "$#" -ge 2 ] || die "--port needs a value"; PORT="$2"; shift 2;;
  --db-host) [ "$#" -ge 2 ] || die "--db-host needs a value"; DB_HOST="$2"; shift 2;;
  --db-port) [ "$#" -ge 2 ] || die "--db-port needs a value"; DB_PORT="$2"; shift 2;;
  --non-interactive) NON_INTERACTIVE=1; shift;;
  --skip-firewall) SKIP_FIREWALL=1; shift;;
  --dry-run) DRY_RUN=1; shift;;
  -h|--help) usage; exit 0;;
  *) die "Unknown option: $1";;
 esac
done
case "$PORT" in ''|*[!0-9]*) die "Invalid port";; esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || die "Port out of range"
case "$DB_PORT" in ''|*[!0-9]*) die "Invalid DB port";; esac
[ "$DB_PORT" -ge 1 ] && [ "$DB_PORT" -le 65535 ] || die "DB port out of range"
case "$DB_HOST" in *[!A-Za-z0-9._:-]*|'') die "Invalid DB host";; esac
[ -f "$APP_DIR/package-lock.json" ] && [ -f "$APP_DIR/db/schema.sql" ] && [ -f "$APP_DIR/server/seed.js" ] || die "Incomplete checkout"
[ "$EUID" -eq 0 ] || die "Run with sudo"
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) die "Ubuntu/Debian only";; esac
if [ "$DRY_RUN" -eq 1 ]; then
 echo "Dry-run OK: app=$APP_DIR port=$PORT database=$DB_HOST:$DB_PORT"
 echo "No files, services or databases changed."
 exit 0
fi
mkdir -p /run/lock
exec 9>/run/lock/house-sys-deploy.lock
flock -n 9 || die "Another deployment is running"
if [ "$NON_INTERACTIVE" -eq 0 ]; then
 echo "WARNING: first install only. This initializes legacy shared databases."
 echo "Existing databases are never overwritten. This is NOT database-per-tenant."
 read -r -p "Continue? [y/N] " answer
 [ "$answer" = y ] || [ "$answer" = Y ] || die "Cancelled"
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl gnupg mariadb-server ufw
if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 20 ]; then
 curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
 apt-get install -y nodejs
fi
systemctl enable --now mariadb
MYSQL="mariadb --protocol=socket --user=root"
$MYSQL -Nse 'SELECT VERSION()' >/dev/null || die "MariaDB root socket login failed"
for database in house_sys house_sys_rental house_sys_hotel house_sys_property; do
 exists=$($MYSQL -Nse "SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name='$database'")
 [ "$exists" = 0 ] || die "Database $database already exists; refusing destructive db/schema.sql import"
done
cd "$APP_DIR"
npm ci --omit=dev --no-audit --no-fund
$MYSQL < db/schema.sql
DB_USER=house_sys_app
DB_PASS="$(openssl rand -hex 32)"
BOOTSTRAP_SUPER="$(openssl rand -hex 24)"
BOOTSTRAP_RENTAL="$(openssl rand -hex 24)"
BOOTSTRAP_HOTEL="$(openssl rand -hex 24)"
BOOTSTRAP_PROPERTY="$(openssl rand -hex 24)"
BOOTSTRAP_STAFF="$(openssl rand -hex 24)"
BOOTSTRAP_PROPERTY_STAFF="$(openssl rand -hex 24)"
$MYSQL <<SQL
CREATE USER '$DB_USER'@'127.0.0.1' IDENTIFIED BY '$DB_PASS';
GRANT SELECT, INSERT, UPDATE, DELETE ON house_sys.* TO '$DB_USER'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON house_sys_rental.* TO '$DB_USER'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON house_sys_hotel.* TO '$DB_USER'@'127.0.0.1';
GRANT SELECT, INSERT, UPDATE, DELETE ON house_sys_property.* TO '$DB_USER'@'127.0.0.1';
FLUSH PRIVILEGES;
SQL
HOUSE_SYS_SUPERADMIN_PASSWORD="$BOOTSTRAP_SUPER" HOUSE_SYS_RENTAL_ADMIN_PASSWORD="$BOOTSTRAP_RENTAL" HOUSE_SYS_HOTEL_ADMIN_PASSWORD="$BOOTSTRAP_HOTEL" HOUSE_SYS_PROPERTY_ADMIN_PASSWORD="$BOOTSTRAP_PROPERTY" HOUSE_SYS_RENTAL_STAFF_PASSWORD="$BOOTSTRAP_STAFF" HOUSE_SYS_PROPERTY_STAFF_PASSWORD="$BOOTSTRAP_PROPERTY_STAFF" DB_HOST="$DB_HOST" DB_PORT="$DB_PORT" DB_USER="$DB_USER" DB_PASSWORD="$DB_PASS" node server/seed.js core
if ! id house-sys >/dev/null 2>&1; then useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin house-sys; fi
install -d -o house-sys -g house-sys -m 0750 "$APP_DIR/uploads"
TMP_ENV="$(mktemp /etc/house-sys.env.XXXXXX)"
cat > "$TMP_ENV" <<EOF
NODE_ENV=production
DB_HOST=$DB_HOST
DB_PORT=$DB_PORT
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
PORT=$PORT
EOF
chown root:root "$TMP_ENV"; chmod 0600 "$TMP_ENV"; mv "$TMP_ENV" "$ENV_FILE"
NODE_BIN="$(command -v node)"
cat > "/etc/systemd/system/$SERVICE.service" <<EOF
[Unit]
Description=House Management System (legacy shared DB)
After=network-online.target mariadb.service
Requires=mariadb.service
[Service]
Type=simple
User=house-sys
Group=house-sys
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $APP_DIR/server/app.js
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$APP_DIR/uploads
LockPersonality=true
RestrictSUIDSGID=true
CapabilityBoundingSet=
AmbientCapabilities=
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now "$SERVICE"
systemctl restart "$SERVICE"
if [ "$SKIP_FIREWALL" -eq 0 ] && command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q '^Status: active'; then ufw allow "$PORT/tcp"; fi
ready=0
for attempt in $(seq 1 20); do
 if timeout 1 bash -c ":</dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then ready=1; break; fi
 sleep 1
done
[ "$ready" -eq 1 ] || { journalctl -u "$SERVICE" -n 60 --no-pager >&2 || true; die "Service failed to listen"; }
CREDENTIAL_FILE=/root/house-sys-bootstrap-credentials.txt
cat > "$CREDENTIAL_FILE" <<EOF
Super Admin: superadmin
Super Admin password: $BOOTSTRAP_SUPER
Rental Admin: admin_r
Rental Admin password: $BOOTSTRAP_RENTAL
Hotel Admin: admin_h
Hotel Admin password: $BOOTSTRAP_HOTEL
Property Admin: admin_p
Property Admin password: $BOOTSTRAP_PROPERTY
Rental Staff: staff
Rental Staff password: $BOOTSTRAP_STAFF
Property Staff: wy
Property Staff password: $BOOTSTRAP_PROPERTY_STAFF
Change passwords after first login. Store securely, then delete this file.
EOF
chmod 0600 "$CREDENTIAL_FILE"
unset DB_PASS BOOTSTRAP_SUPER BOOTSTRAP_RENTAL BOOTSTRAP_HOTEL BOOTSTRAP_PROPERTY BOOTSTRAP_STAFF BOOTSTRAP_PROPERTY_STAFF
echo "Install complete: http://<server-ip>:$PORT"
echo "Bootstrap credentials stored in $CREDENTIAL_FILE (root-only)."
echo "This remains the legacy shared-database runtime, not database-per-tenant."
