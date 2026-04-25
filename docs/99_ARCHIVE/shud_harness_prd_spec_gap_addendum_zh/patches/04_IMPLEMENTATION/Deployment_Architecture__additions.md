# Patch: Deployment_Architecture additions

**目标文档**：`docs/04_IMPLEMENTATION/Deployment_Architecture.md`  
**插入位置**：服务组成、单机部署、数据持久化、验收标准之后。

## 新增服务组成

```text
health service        # live/ready/deep
metrics collector     # API/WS/job/report/storage metrics
alert evaluator       # threshold + dedupe
ops dashboard API     # dashboard aggregation
log aggregator        # NDJSON + optional DuckDB ingest
dependency checker    # lockfile/submodule/core version summary
```

## 单机部署补充

- workspace 分区必须配置 disk warning/critical 阈值；
- systemd/Docker health probe 使用 `/api/health/live` 和 `/api/health/ready`；
- logs 写入 `workspace/logs/` 或配置目录；
- DuckDB warehouse 损坏时可从 filesystem/NDJSON 重建；
- ops dashboard 可以与 Web workbench 共用 auth。

## 验收标准补充

- [ ] live/ready endpoints 可用于 process manager。
- [ ] disk critical 时新 job 被阻止。
- [ ] ops dashboard 能显示 Dependencies 和 Storage。
- [ ] log aggregation 不依赖第三方 SaaS。
