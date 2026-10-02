#!/usr/bin/env bash
# 冒烟测试：不依赖浏览器，用 tsc 把数据层编译到临时目录后在 node 里跑。
# 覆盖：异常值改判链路、版本留痕、关注事项同步、并发只落一次、失败回退、旧版存储迁移。
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=node_modules/.cache/smoke

./node_modules/.bin/tsc -p tsconfig.smoke.json

# tsc 不会重写 @ 别名，输出目录里把指向 src/data 的引用改成相对路径
node -e 'const fs=require("fs");const p=process.argv[1];fs.writeFileSync(p,fs.readFileSync(p,"utf8").split("require(\"@/data/").join("require(\"../data/"))' "$OUT/src/api/local-service.js"

node "$OUT/scripts/smoke-weather.js"
node "$OUT/scripts/smoke-migrate.js"
