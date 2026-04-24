# SHUD-Harness Lite 模块化详细方案 v0.6

本包是对 v0.5 的收敛重构版。它接受以下前提：

- 团队规模按 **1 名 PI + 1 名工程师 + 0.5 名数据支持** 设计；
- SHUD-Harness 不是“全自动科研系统”，而是 **PI 主导的科研工程助手**；
- 主 agent 不是科学决策者，而是 **执行协调员 / research engineering coordinator**；
- 第一阶段不 fork ZeRo，不做大平台，先从 **独立极简 runtime** 落地；
- ZeRo 作为参考实现，用于借鉴 agent loop、bash tool、trace、skills loader、spawn/wait 等工程模式；
- 目标是无需 ZeRo 也能实现，但有 ZeRo 源码时可以更快、更稳地实现同类模块。

## 推荐阅读顺序

1. `00_MAIN_INDEX.md`
2. `01_POSITIONING/01_Project_Positioning_MVP.md`
3. `01_POSITIONING/02_Roles_PI_Coordinator_Worker.md`
4. `02_ARCHITECTURE/01_Minimal_Runtime_Kernel.md`
5. `03_DOMAIN/01_Lightweight_Object_Model.md`
6. `05_IMPLEMENTATION/03_8_Week_Implementation_Plan.md`

## 标注约定

本文档继续使用三类实现标记，但含义已收敛：

- **[R] Reference implemented in ZeRo**：ZeRo 中已有可参考的实现模式，可读源码借鉴，但本项目不强依赖。
- **[M] Modify if adopting ZeRo later**：如果未来选择接入或 fork ZeRo，需要修改或替换的部分。
- **[N] New in SHUD-Harness Lite**：SHUD-Harness Lite 必须自己实现的领域逻辑或轻量组件。

## v0.6 的总体判断

v0.4/v0.5 的方向有价值，但对象建模、治理流程和 Web Console 明显过重。v0.6 不再追求“科研 Agent Runtime 平台”，而是先建设一个可用、可控、低成本、能复盘的 **SHUD research engineering assistant**。
