#!/bin/bash
# 每日采集脚本
# 用法: bash scripts/collect.sh
# Cron: 0 8 * * * cd /mnt/f/detect && bash scripts/collect.sh >> /tmp/collect.log 2>&1

cd "$(dirname "$0")/.."
export PATH="$HOME/bin:$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"

echo "$(date): Starting collection..."
python3 scripts/collect.py
echo "$(date): Done."
