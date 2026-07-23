# 跨运行问责 — logEntry Schema、Kill 标准与 Ratchet

> 从 SKILL.md 跨运行问责节下推的细节。编排器每次运行必须执行的四步日志流程仍在 SKILL.md，缺一即视为漏记。

脚本返回的 `logEntry` schema（未含 date，编排器写入前补上）：

```json
{"change":"<name>","grill_gate":"passed:branches=<n>,open=<n>|skipped:<reason>","rounds":<n>,"gate_net_catch":<n>,"p0":{"in":<n>,"resolved":<n>,"residual":<n>},"p1":{"resolved":<n>,"carried":<n>},"regressions":<n>,"approx_subagent_calls":<n>,"verdict":"clean|residual"}
```

（`grill_gate` 仅 `full-pipeline` 返回；`review-loop` 独立运行时作用于已存在的 change，门禁决策在其上游，无此字段。）

编排器补 date 后写入文件的完整一行：

```json
{"date":"<run-date>","change":"<name>","grill_gate":"passed:branches=<n>,open=<n>|skipped:<reason>","rounds":<n>,"gate_net_catch":<n>,"p0":{"in":<n>,"resolved":<n>,"residual":<n>},"p1":{"resolved":<n>,"carried":<n>},"regressions":<n>,"approx_subagent_calls":<n>,"verdict":"clean|residual"}
```

- `gate_net_catch`：**本节核心指标**——验证门独有的价值。统计"修复者声称已解决但独立验证者判为 unresolved 或 regressed 的数量——即没有这道门就会被漏过的量"。Stage 3 审核和 `openspec status` 已经抓到的不计入。
- `p1.carried`：仅在触顶（`verdict=residual`）时出现；clean 时该字段省略。
- `approx_subagent_calls`：脚本本次实际发起的 subagent 调用计数（review + fix/verify/完成自审 + issue 创建 + 对齐审核，逐次累加）。
- 其余字段供横向看趋势（轮次、残留、回归、成本）。

**2. kill 标准**

验证门要持续证明自己值得那份成本。判定（最小样本 = 5 次运行，不足不下结论）：

- 若连续 **≥5 次** 运行 `gate_net_catch` 都 ≈ 0（验证者从不推翻修复者、也不抓回归），说明它在橡皮图章 → **收窄**（改成只在修复触及实体名、表/ENUM 计数等全局扩散项时才跑）或**退役**。
- 收窄/退役的决定连同日志证据记入 change 或 `docs/adr/`，不悄悄关掉。

**3. ratchet（把复发问题棘轮成永久校验）**

当同一 finding 类（如"表/ENUM 计数不一致"、"OpenAPI schema 缺字段"）跨 **≥2 次** 运行复发，就把它从"每次靠人审抓"提升为**永久自动校验**——加一条 openspec validation / lint / CI 检查。已解决的问题从此变成不变量，不再消耗回环预算，也顺带降低 dim 9 成本。

**非目标**：不做 Reflexion 式跨 change 学习（不把历史 change 的 finding 模式注入新 change 的审核）。catch-rate 日志是**组织级问责**，不是循环内记忆。
