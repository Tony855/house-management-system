#!/bin/bash
# 一键初始化：安装依赖 -> 建库建表 -> 写种子数据
# 用法：
#   bash db/init.sh          # 默认 core：仅账号体系，业务数据为空（生产/正式使用）
#   bash db/init.sh demo     # 演示：额外写入三系统演示业务数据
#
# 注意：重建库前请先停止正在运行的服务（npm start 的 node 进程），
#       否则其数据库连接池会阻塞 DROP DATABASE。
set -e
cd "$(dirname "$0")/.."

echo "== 1/3 安装依赖 =="
npm install --no-audit --no-fund

echo "== 2/3 创建数据库表结构（先 DROP 再 CREATE）=="
mysql -uroot < db/schema.sql

echo "== 3/3 写入种子数据 =="
if [ "${1:-}" = "demo" ]; then
  node server/seed.js
  echo "已写入三系统演示业务数据。"
else
  node server/seed.js core
  echo "仅写入账号体系（业务数据为空），请用超管登录后开通经营主体。"
fi

echo "== 完成。启动服务: npm start（端口 16088）=="
