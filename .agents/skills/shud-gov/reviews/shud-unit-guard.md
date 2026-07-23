# Review Dimension: SHUD 时间单位 / 参数语义 / 二进制格式一致性

## 角色

你正在 review 涉及 SHUD 数据解析、时间处理或参数配置的代码。
SHUD 生态中时间单位混乱（天/分钟/秒混用）是最常见的隐蔽 bug 来源。
你是 advisory reviewer，只标注需要人工确认的位置。

## 领域知识

参考 @.claude/skills/shud-gov/knowledge/shud-formats.md

## 检查清单

### 时间单位

- [ ] 对代码中每个涉及时间值的位置，标注该位置实际使用的单位（天/分钟/秒）
- [ ] 验证 forcing CSV 读取是否有 `* 1440`（天 → 分钟）转换
- [ ] 验证 LAI/MF 时序读取是否有同样的 `* 1440` 转换
- [ ] 验证 .cfg.para 中的时间参数是否直接作为分钟使用（不再转换）
- [ ] 验证 rSHUD read_output() 的时间是否做了 `* 60`（分钟 → 秒）再加到 POSIXct
- [ ] 如果代码向前端输出时间，标注最终单位是什么

### 校准参数语义

- [ ] 验证代码是否区分乘法参数和加法参数（+后缀）
- [ ] 检查参数名解析是否处理了尾部 `+` 字符
- [ ] 验证 KsatV / macKsatV 是否除以 1440（m/day → m/min）

### 二进制输出解析

- [ ] 验证是否处理了两种头格式（version > 1.0 的 1024 字节头 vs version 1.0 的简单头）
- [ ] 验证 endian 假设是否与目标平台一致
- [ ] 检查是否有 NaN 检测（SHUD 不做 NaN 检查，输出可能含 NaN）
- [ ] 验证 flux vs storage 变量的平均方式是否不同（tau=1440 vs tau=1）

### 输出变量

- [ ] 如果代码引用 SHUD 输出变量名，验证拼写与 SHUD 源码一致
  （如 `eleysurf`, `eleygw`, `rivqdown` — 不是 `ele_y_surf` 或 `river_q_down`）

## 输出格式

```
Reviewer: shud-unit-guard (advisory)
Findings:
- [severity: major|minor] [file:line] [验证项] — [具体发现]
```

对每个时间值操作，如果无法确定单位，标注:
```
- [UNCERTAIN] [file:line] 此处时间值单位不明确，需人工确认
```
