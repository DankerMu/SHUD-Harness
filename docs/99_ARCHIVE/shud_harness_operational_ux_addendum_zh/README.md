# SHUD-Harness v0.8.1 Operational UX 设计补充包

本压缩包用于补充 SHUD-Harness v0.8 的四个“真实使用断点”设计：

1. 浏览器关闭后 PI 无法获知长任务完成：增加轻量 out-of-band 通知。
2. EvidenceReport 只能在浏览器内阅读：增加 standalone HTML 导出。
3. Sensitivity / calibration 批运行缺少中间进度视图：增加 BatchProgressGrid。
4. PI 审批只有按钮没有科学批注：增加 PI decision comments，并写入审计与 MemoryNote。

本包采用 **英文文件名 + 中文正文**。文件分为两类：

- `docs/`：建议作为新增文档直接加入仓库。
- `patches/`：逐个现有文档的补充片段，明确“补到哪个文件、哪个部分、插入什么内容”。

## 推荐合并顺序

1. 先加入 `docs/03_SPEC/Operational_UX_Addendum.md`，作为 v0.8.1 总补充。
2. 再加入四个专题规范：
   - `Notification_Design.md`
   - `Report_Export_Spec.md`
   - `Batch_Progress_View_Spec.md`
   - `PI_Decision_Comments_Spec.md`
3. 将 `patches/` 目录中的补充片段按目标文件合并到现有文档。
4. 最后更新 `MASTER_INDEX.md`，把新增文档加入索引。

## 设计原则

- 不新增复杂平台级系统；只补齐 PI 实际工作流需要的最小能力。
- 通知不替代 WebSocket，只补浏览器关闭后的提醒。
- 报告导出是静态证据包，不是完整数据包。
- 批进度视图从 AnalysisPlan + RunJob + RunRecord 派生，不引入新 workflow engine。
- PI comment 是决策记录，不得自动泛化为跨流域科学事实。
