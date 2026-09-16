#!/bin/bash
# 多租户健康检查：服务首页 + 五类账号登录 + 三系统隔离 + 酒店能力裁剪 + 超管职责边界
# 用法：bash db/verify.sh   （需先启动服务：npm start，默认端口 16088）
BASE=http://localhost:16088
API=$BASE/api

echo "首页: HTTP $(curl -s -o /dev/null -w '%{http_code}' $BASE/)"

login() { # $1 账号 $2 密码 $3 入口mode
  curl -s -X POST -H 'Content-Type: application/json' \
    -d "{\"username\":\"$1\",\"password\":\"$2\"${3:+,\"mode\":\"$3\"}}" $API/login
}
token_of() { echo "$1" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).token||"")}catch{console.log("")}})'; }
get() { curl -s -H "Authorization: Bearer $2" "$API$1"; }

echo "--- 登录 ---"
SUP=$(login superadmin super123 super); SUT=$(token_of "$SUP")
RL=$(login admin_r admin_r123 rental); RT=$(token_of "$RL")
HL=$(login admin_h admin_h123 hotel); HT=$(token_of "$HL")
PL=$(login admin_p admin_p123 property); PT=$(token_of "$PL")
SL=$(login staff staff123); ST=$(token_of "$SL")
for t in "超管:$SUT" "租房:$RT" "酒店:$HT" "物业:$PT" "员工:$ST"; do
  echo "  $t 登录: $([ -n "${t#*:}" ] && echo OK || echo FAIL)"
done

echo "--- 超管：监控 + 主体管理（不含业务）---"
get /monitor "$SUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("  监控系统数:",Object.keys(j.systems).length,"租房主体数:",j.orgs.rental.length,"酒店主体数:",j.orgs.hotel.length,"物业主体数:",j.orgs.property.length)})'
echo "  超管访问业务 /rooms: HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $SUT" $API/rooms)（应为 403）"
get /orgs "$SUT" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);console.log("  经营主体数:",j.length, j.map(o=>o.mode+":"+o.name).join(" / "))})'

echo "--- 三系统数据隔离（各主体独立房间表）---"
for M in rental hotel property; do
  case $M in rental) T=$RT;; hotel) T=$HT;; property) T=$PT;; esac
  N=$(get /rooms "$T" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{console.log(JSON.parse(s).length)})')
  echo "  $M 主体房间数: $N"
done

echo "--- 酒店能力裁剪（水电/网费/合同/投诉应 404，订单保留）---"
for P in contracts meters netChanges complaints; do
  echo "  酒店 /$P: HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $HT" $API/$P)（应 404）"
done
echo "  酒店 /orders: HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $HT" $API/orders)（应 200）"

echo "--- 租房/物业保留水电网能力 ---"
for pair in "rental:$RT:meters" "rental:$RT:netChanges" "property:$PT:meters" "property:$PT:complaints"; do
  M=${pair%%:*}; rest=${pair#*:}; T=${rest%%:*}; P=${rest#*:}
  echo "  $M /$P: HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $T" $API/$P)（应 200）"
done

echo "--- 员工权限边界 ---"
echo "  员工 /rooms(授权): HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ST" $API/rooms)（应 200）"
echo "  员工 /users(越权): HTTP $(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $ST" $API/users)（应 403）"
