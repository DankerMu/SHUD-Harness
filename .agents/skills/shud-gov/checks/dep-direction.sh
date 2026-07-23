#!/usr/bin/env bash
# dep-direction.sh — 检查包依赖方向是否正确（SHUD domain → zero core 单向）
# 输出 [WARNING] 行，永远 exit 0（advisory only）

set -euo pipefail

PROJECT_ROOT="${1:-.}"
FOUND=0

# 检查 zero/packages/ 下是否反向引用 SHUD domain 包
# SHUD domain 包的识别: packages/ 下非 zero/ 的包，或包含 shud/domain 关键词的路径
while IFS= read -r file; do
  # 检查是否 import 了 SHUD domain 的模块（排除 @zero-os/ 自身的包）
  if grep -qn "from ['\"].*shud\|from ['\"].*domain\|from ['\"].*harness" "$file" 2>/dev/null; then
    line=$(grep -n "from ['\"].*shud\|from ['\"].*domain\|from ['\"].*harness" "$file" | head -1 | cut -d: -f1)
    echo "[WARNING] $file:$line — zero 核心包中发现对 SHUD domain 的引用。依赖方向应为 SHUD → zero，不能反向。"
    FOUND=$((FOUND + 1))
  fi
done < <(find "$PROJECT_ROOT/zero/packages" -name "*.ts" 2>/dev/null || true)

# 检查是否有循环 import（简单检测: A import B 且 B import A）
# 此为启发式检查，不保证覆盖所有情况
if command -v madge &>/dev/null; then
  CYCLES=$(madge --circular --extensions ts "$PROJECT_ROOT/packages" 2>/dev/null | head -20 || true)
  if [ -n "$CYCLES" ]; then
    echo "[WARNING] 发现潜在循环依赖:"
    echo "$CYCLES" | while IFS= read -r line; do
      echo "  $line"
    done
    FOUND=$((FOUND + 1))
  fi
else
  echo "[INFO] madge 未安装，跳过循环依赖检测（可选: bun add -g madge）"
fi

if [ "$FOUND" -eq 0 ]; then
  echo "[OK] dep-direction: 未发现反向依赖问题"
fi

exit 0
