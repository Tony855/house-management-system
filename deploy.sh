#!/usr/bin/env bash
# ==================================================================
# 房屋管理系统 · Ubuntu 一键全自动部署脚本
# 适用：Ubuntu 20.04 / 22.04 / 24.04（apt 系）
# 功能：自动安装 Node.js LTS + MariaDB → 建库建表 → 写入账号体系
#       → 创建专用数据库账号（随机密码）→ 注册 systemd 服务 → 放行防火墙
# 用法：
#   sudo bash deploy.sh              # 默认端口 16088
#   sudo bash deploy.sh --port 8080  # 自定义端口
#   sudo bash deploy.sh --force      # 库中已有数据时仍强制重建（危险！会清空业务数据）
# ==================================================================
set -euo pipefail

PORT=16088
FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)  PORT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "未知参数: $1（仅支持 --port <端口> 与 --force）"; exit 1 ;;
  esac
done

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE=house-sys
ENV_FILE=/etc/house-sys.env
DB_USER=house
DB_PASS="$(openssl rand -hex 16)"

# ---------- 0. root 权限检查 ----------
if [[ $EUID -ne 0 ]]; then
  echo "✗ 需要 root 权限，请执行：sudo bash deploy.sh"
  exit 1
fi

echo "========== 房屋管理系统 · Ubuntu 一键部署 =========="
echo "项目目录: $APP_DIR    端口: $PORT"

# ---------- 1. 安装 Node.js（NodeSource 官方源 LTS 20） ----------
echo "== [1/8] 检查/安装 Node.js =="
if ! command -v node >/dev/null 2>&1; then
  apt-get update -y
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
echo "Node: $(node -v)   npm: $(npm -v)"

# ---------- 2. 安装并启动 MariaDB ----------
echo "== [2/8] 检查/安装 MariaDB =="
if ! command -v mariadb >/dev/null 2>&1 && ! command -v mysql >/dev/null 2>&1; then
  apt-get update -y
  apt-get install -y mariadb-server
fi
systemctl enable --now mariadb >/dev/null 2>&1 || service mariadb start

# ---------- 3. 安装项目依赖 ----------
echo "== [3/8] 安装项目依赖 =="
cd "$APP_DIR"
npm install --no-audit --no-fund

# ---------- 4. 初始化数据库 ----------
echo "== [4/8] 初始化数据库（建库建表） =="
# 安全保护：库中已有数据时中止（除非 --force）
EXISTING=$(mysql -uroot -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='house_sys' AND table_name='users'" 2>/dev/null || echo 0)
if [[ "$EXISTING" != "0" ]]; then
  USERS=$(mysql -uroot -N -e "SELECT COUNT(*) FROM house_sys.users" 2>/dev/null || echo 0)
  if [[ "$USERS" != "0" && "$FORCE" != "1" ]]; then
    echo "✗ 检测到 house_sys.users 已有 $USERS 条数据，为避免误清业务数据已中止。"
    echo "  确认要重建请执行：sudo bash deploy.sh --force"
    exit 1
  fi
fi
mysql -uroot < db/schema.sql
echo "数据库表结构已重建（house_sys + rental/hotel/property）"

# ---------- 5. 创建专用数据库账号（随机密码，仅本机访问） ----------
echo "== [5/8] 创建数据库专用账号 =="
mysql -uroot <<SQL
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON house_sys.*           TO '${DB_USER}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON house_sys_rental.*    TO '${DB_USER}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON house_sys_hotel.*     TO '${DB_USER}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON house_sys_property.*  TO '${DB_USER}'@'127.0.0.1';
GRANT ALL PRIVILEGES ON house_sys.*           TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON house_sys_rental.*    TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON house_sys_hotel.*     TO '${DB_USER}'@'localhost';
GRANT ALL PRIVILEGES ON house_sys_property.*  TO '${DB_USER}'@'localhost';
FLUSH PRIVILEGES;
SQL
echo "数据库账号 ${DB_USER} 已创建（随机密码已生成）"

# ---------- 6. 写入账号体系（超管 superadmin/super123） ----------
echo "== [6/8] 写入账号体系 =="
DB_HOST=127.0.0.1 DB_USER=$DB_USER DB_PASSWORD=$DB_PASS node server/seed.js core

# ---------- 7. 写入服务配置并注册 systemd ----------
echo "== [7/8] 写入服务配置并注册 systemd 服务 =="
cat > "$ENV_FILE" <<EOF
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASS
PORT=$PORT
EOF
chmod 600 "$ENV_FILE"

cat > /etc/systemd/system/${SERVICE}.service <<EOF
[Unit]
Description=House Management System
After=network.target mariadb.service

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server/app.js
EnvironmentFile=$ENV_FILE
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ${SERVICE} >/dev/null 2>&1 || service ${SERVICE} start
sleep 2

# ---------- 8. 防火墙放行 ----------
echo "== [8/8] 防火墙放行 =="
if command -v ufw >/dev/null 2>&1; then
  ufw allow ${PORT}/tcp >/dev/null 2>&1 || true
  ufw reload >/dev/null 2>&1 || true
fi

# ---------- 完成 ----------
echo ""
echo "========== 部署完成 ✓ =========="
echo "访问地址 : http://<服务器IP>:${PORT}"
echo "超级管理员 : superadmin / super123"
echo "数据库账号 : ${DB_USER}（密码已写入 ${ENV_FILE}，权限 600）"
echo "服务管理 : systemctl {status|restart|stop} house-sys"
echo "日志查看 : journalctl -u house-sys -f"
