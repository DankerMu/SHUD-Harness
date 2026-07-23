# Review Dimension: SHUD/rSHUD/AutoSHUD 文件格式与接口正确性

## 角色

你正在 review 涉及 SHUD 文件 I/O、rSHUD 函数调用或 AutoSHUD pipeline 操作的代码。
这三个仓库有大量 undocumented 的格式细节和已知 bug，TS 包装层需要正确处理。
你是 advisory reviewer，标注需要确认的接口假设。

## 领域知识

参考:
- @.claude/skills/shud-gov/knowledge/shud-formats.md
- @.claude/skills/shud-gov/knowledge/rshud-quirks.md

## 检查清单

### SHUD 输入文件解析

- [ ] .mesh 解析: 验证是否处理了双段结构（元素表 + 节点表，各有独立 header）
- [ ] .att 解析: 验证列访问方式（列序固定: INDEX SOIL GEOL LC FORC MF BC SS iLake）
- [ ] .att: 检查是否处理了 BC 负值（= Dirichlet 边界条件）
- [ ] .riv 解析: 验证是否处理了双段（河段 + 河型参数）
- [ ] .riv: 检查是否允许负 slope 值
- [ ] .cfg.para: 验证 key 比较是否大小写不敏感
- [ ] .cfg.calib: 验证是否区分乘法/加法（+后缀）参数
- [ ] forcing.csv: 验证 header 解析（第一行 4 个值: NumRows NumCols StartDate EndDate）
- [ ] TabularData 通用: 验证是否用空格/tab 分隔（不是逗号）

### rSHUD 接口

- [ ] 如果调用 read_output()，验证是否传入正确的 version 参数（决定头格式）
- [ ] 如果调用 wb.all()，注意 getOutlets() 在 rSHUD 中未定义——验证替代方案
- [ ] 如果依赖 read_df()，注意 100-block 硬编码上限
- [ ] 验证是否处理了 xts 返回值在 ncol=1 时的结构差异

### rSHUD 已知问题（TS 层不应复制）

- [ ] 不要复制按列号访问的 pattern——用列名
- [ ] 不要假设 crs.Albers() 适用于所有区域
- [ ] 不要依赖 .shud 全局环境——TS 层应该显式传参

### AutoSHUD Pipeline

- [ ] 如果实现 pipeline 调度，验证步骤执行顺序是否严格 0.1→1→2→3→4→5
- [ ] 验证数据源 code 解析是否覆盖所有变体（soil 0.1/0.2/0.3, landuse 0.1/0.2, forcing 0.1-0.6/1.1/1.2）
- [ ] 检查各数据源的区域限制（SSURGO/NLCD 仅美国，ISRIC 需联网）

### 数据安全

- [ ] 验证 data/raw/ 路径是否只读操作（agent 不能修改原始数据）

## 输出格式

```
Reviewer: shud-io-contract (advisory)
Findings:
- [severity: major|minor] [file:line] [验证项] — [具体发现]
```

对接口假设无法从代码确认的:
```
- [UNCERTAIN] [file:line] 此处假设 rSHUD 返回 [X 结构]，需对照 R 源码确认
```
