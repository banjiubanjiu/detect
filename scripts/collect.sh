#!/bin/bash
# 每日采集脚本
# 用法: bash scripts/collect.sh
# Cron: 30 8 * * * bash /mnt/f/detect/scripts/collect.sh >> /tmp/collect.log 2>&1

cd "$(dirname "$0")/.."
export PATH="$HOME/bin:$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"

echo "$(date): Starting collection..."
python3 -u scripts/collect.py

# Pull DeepStateMap Ukraine frontline (独立步骤,失败不影响主流程)
python3 -u scripts/deepstate_pull.py || echo "  deepstate_pull 跳过"

echo "$(date): Done."
