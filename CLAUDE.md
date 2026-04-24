# SHUD-Harness

## Project Identity

SHUD-Harness is a **PI-led scientific research engineering assistant** for the SHUD hydrological modeling system.
It orchestrates SHUD (C++ solver), rSHUD (R toolbox), and AutoSHUD (R automation pipeline)
through a Coordinator Agent with CLI-first interaction, bash sandbox execution, lightweight memory, and PI-gated governance.

**v0.6 Lite 核心定位**: 不是自治科研平台，而是帮 PI 和工程师节省重复劳动时间的工具。
成功标准 = 时间节省，不是自治程度。

## Repository Layout

```
SHUD-Harness/                    ← you are here
├── SHUD/                        ← C++ 数值模型 (只读参考)
├── rSHUD/                       ← R 工具包 (只读参考)
├── AutoSHUD/                    ← R 自动化流水线 (只读参考)
├── zero/                        ← Agent Runtime 参考实现 (MVP 不 fork, 仅参考)
├── CLAUDE.md                    ← 本文件
├── SHUD_Harness_Lite_Modular_Plan_v0.6_zh/  ← v0.6 方案原始包
└── docs/                        ← 正式文档体系 (canonical)
    ├── 00_INDEX/                ← 主索引 + 差距分析
    ├── 01_CODEBASE/             ← 四个 repo 代码现实报告
    ├── 02_ARCHITECTURE/         ← 架构决策 + 角色 + 交互模型 + 状态机
    ├── 03_SPEC/                 ← 8 个核心对象 + 沙箱 + 记忆 + 成本 + Schema
    ├── 04_IMPLEMENTATION/       ← 目录树 + CLI + 8 周计划 + DoD + Playbook
    └── 99_ARCHIVE/              ← v0.1–v0.5 旧文档 + 图片
```

## Key Design Decisions (v0.6)

1. **Coordinator, not Commander**: Agent 是执行协调员，不是科学决策者。PI 做科学判断。
2. **8 objects, not 20**: TaskCard, StackLock, DataProvenance, RunJob, RunRecord, AnalysisPlan, EvidenceReport, ChangeRequest.
3. **CLI-first, Report-first**: 交互入口是命令行，产出是 Markdown 报告，Web 最小化。
4. **Park/Resume for long tasks**: SHUD 运行可能几小时，Agent 提交 job 后退出，结果回来再恢复。
5. **MVP 不 fork Zero**: 团队太小不能同时维护 fork + 领域逻辑，Zero 仅作模式参考。
6. **Inference budget per task**: cheap/normal/deep 三档，仅作状态栏软监控，PI 决定是否中止。
7. **Memory 两级**: 普通笔记直接写 draft; 证据类笔记需 PI review。不搞 4 级审批。
8. **Skill 三阶段**: draft → active → retired。不搞 6 级生命周期。
9. **Sensitivity analysis 一等公民**: AnalysisPlan.mode=sensitivity，不是实验规范的子字段。
10. **Python CLI**: 技术栈 Python (typer/pydantic), 非 TypeScript monorepo。

## The Three Repos

### SHUD (C++14, ~7K lines)
- FVM 求解器: 地表/非饱和/地下水/河道/湖泊耦合水文过程
- SUNDIALS/CVODE 6.0+ ODE; OpenMP 并行
- 构建: `./configure && make shud` → `./shud <project>`
- 输入: `.mesh .riv .att .para.* .cfg.* .tsd.*`
- 输出: 二进制 `.dat` (~50 变量)
- 示例: ccw, heihe, qhh

### rSHUD (R, v2.2.0, 154 函数)
- 前处理: DEM→网格→属性→SHUD 输入
- 后处理: `read_output()` 读二进制, `wb.all()` 水量平衡
- terra/sf 现代栈; 10 个测试文件

### AutoSHUD (R 脚本, V3.x)
- 7 步流水线; `.autoshud.txt` 配置驱动
- 多源数据整合; 依赖 rSHUD

## Agent Roles (v0.6)

| 角色 | 职责 | 科学决策权 |
|------|------|-----------|
| PI/研究者 | 提问、定方向、判断证据、批准高风险变更 | ✅ |
| Coordinator | 建 TaskCard、执行计划、监控消耗、生成报告 | ❌ |
| Worker | 跑模型、解析日志、写脚本、生成图表 | ❌ |
| Reviewer | 检查工程完整性和兼容性 (不判断科学结论) | ❌ |

## Governance Rules

- 改物理方程 / 默认参数 / benchmark baseline → PI 审批
- 改输出格式 (breaking) → PI 审批
- 删除原始数据 → 禁止或 PI 审批
- 单流域指标提升 ≠ 模型改进 → Agent 不允许这样表述
- 校准结果 ≠ 结构验证 → Agent 必须标注为 calibration

## Current State (2026-04-24)

- **方案**: v0.6 Lite 完成, 已吸收到 `docs/`; v0.1–v0.5 已归档
- **代码**: 零。Zero 未 fork, 无 Harness 运行时代码
- **下一步**: Week 1 — CLI 骨架 + workspace 初始化 + TaskCard schema
