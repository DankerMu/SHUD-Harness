#!/usr/bin/env bash
# tool-throw-guard.sh — 检查 tool execute() 中是否有未捕获的 throw
# 输出 [WARNING] 行，永远 exit 0（advisory only）

set -euo pipefail

PROJECT_ROOT="${1:-.}"
FOUND=0

# 检查 tool 文件中 execute() 方法内是否有裸 throw
# Zero 的 BaseTool.run() 会 catch，但 execute() 内部 throw 被鼓励转为 ToolResult
while IFS= read -r file; do
  # 查找 throw 语句（排除 catch 块中的 rethrow 和注释）
  if grep -qn "^\s*throw " "$file" 2>/dev/null; then
    while IFS=: read -r line_num content; do
      # 跳过注释行
      if echo "$content" | grep -q "^\s*//"; then
        continue
      fi
      echo "[WARNING] $file:$line_num — throw 语句: ${content}。Zero Tool 中建议将错误转为 ToolResult { success: false }，而非 throw。BaseTool.run() 虽有 catch，但显式转换更可控。"
      FOUND=$((FOUND + 1))
    done < <(grep -n "^\s*throw " "$file" 2>/dev/null || true)
  fi
done < <(find "$PROJECT_ROOT/packages" "$PROJECT_ROOT/apps" -name "*.ts" -path "*/tool*" 2>/dev/null || true)

# 检查新创建的 tool 文件是否 extends BaseTool
while IFS= read -r file; do
  if grep -q "class.*Tool" "$file" 2>/dev/null; then
    if ! grep -q "extends BaseTool\|extends.*Tool" "$file" 2>/dev/null; then
      echo "[WARNING] $file — 定义了 Tool 类但未继承 BaseTool。Zero 的 tool 注册要求继承 BaseTool。"
      FOUND=$((FOUND + 1))
    fi
  fi
done < <(find "$PROJECT_ROOT/packages" "$PROJECT_ROOT/apps" -name "*.ts" -path "*/tool*" 2>/dev/null || true)

if [ "$FOUND" -eq 0 ]; then
  echo "[OK] zod-in-tools: 未发现 tool 层问题"
fi

exit 0
