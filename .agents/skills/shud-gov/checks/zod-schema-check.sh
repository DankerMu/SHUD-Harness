#!/usr/bin/env bash
# zod-schema-check.sh — 检查 Zero tool 层是否直接使用 Zod 而未转 JSON Schema
# 输出 [WARNING] 行，永远 exit 0（advisory only）

set -euo pipefail

PROJECT_ROOT="${1:-.}"
FOUND=0

# 检查 tool 文件中是否直接 import zod（不含转换层）
while IFS= read -r file; do
  if grep -qn "from ['\"]zod['\"]" "$file" 2>/dev/null; then
    # 检查同文件是否有 zodToJsonSchema 或类似转换
    if ! grep -q "zodToJsonSchema\|toJsonSchema\|jsonSchema" "$file" 2>/dev/null; then
      line=$(grep -n "from ['\"]zod['\"]" "$file" | head -1 | cut -d: -f1)
      echo "[WARNING] $file:$line — import zod 但未发现 JSON Schema 转换。Zero Tool parameters 需要 JSON Schema 格式，不是 Zod schema。"
      FOUND=$((FOUND + 1))
    fi
  fi
done < <(find "$PROJECT_ROOT/packages" "$PROJECT_ROOT/apps" -name "*.ts" -path "*/tool*" 2>/dev/null || true)

# 检查 tool execute() 中是否有 .parse() 调用（Zod pattern）
while IFS= read -r file; do
  if grep -qn "\.parse(" "$file" 2>/dev/null; then
    if grep -q "from ['\"]zod['\"]" "$file" 2>/dev/null; then
      line=$(grep -n "\.parse(" "$file" | head -1 | cut -d: -f1)
      echo "[WARNING] $file:$line — 在 tool 文件中使用 .parse()（Zod pattern）。验证这是否在 execute() 内部做输入校验（可以），还是在 parameters 定义中（不行）。"
      FOUND=$((FOUND + 1))
    fi
  fi
done < <(find "$PROJECT_ROOT/packages" "$PROJECT_ROOT/apps" -name "*.ts" -path "*/tool*" 2>/dev/null || true)

if [ "$FOUND" -eq 0 ]; then
  echo "[OK] zero-imports: 未发现 Zod/JSON Schema 混用问题"
fi

exit 0
