#!/bin/bash
# 每日采集脚本
# 用法: bash scripts/collect.sh
# Cron: 30 8 * * * bash /mnt/f/detect/scripts/collect.sh >> /tmp/collect.log 2>&1

cd "$(dirname "$0")/.."
export PATH="$HOME/bin:$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"

echo "$(date): Starting collection..."
python3 -u scripts/collect.py

# 多源交叉验证聚类 (为 latest.json 每条 item 注入 cluster_id/size/bias_count)
python3 -u scripts/cluster_corroboration.py || echo "  cluster_corroboration 跳过"

# Pull DeepStateMap Ukraine frontline (独立步骤,失败不影响主流程)
python3 -u scripts/deepstate_pull.py || echo "  deepstate_pull 跳过"

# I&W 预警指标 (#3: event_frequency / critical_count / escalation_trend 异常检测)
python3 -u scripts/indicators.py || echo "  indicators 跳过"

# 管道健康报告 + orphan 自动修复 (T4/T9/T21: 清除悬空+空 local_file, 刷新 pipeline_health.json)
python3 -u scripts/health_report.py --fix || echo "  health_report 跳过"

# T5: 条目老化 (清理 >30 天 item, 防 latest.json 无限膨胀)
python3 -u scripts/prune_old.py || echo "  prune_old 跳过"

echo "$(date): Done."
