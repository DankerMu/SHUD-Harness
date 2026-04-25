# 部署架构

**状态：** P2 实施规范  
**适用范围：** 本地开发、单机服务、Docker、远程 HPC/SLURM  
**目标：** 明确 v0.8 MVP 到小团队部署的运行形态。

## 1. 部署模式

| 模式 | 场景 | 特点 |
|---|---|---|
| local dev | 开发和演示 | Bun server + React + 本地 workspace |
| local PI workstation | PI 本机使用 | 单用户认证，本地 SHUD/rSHUD 运行 |
| lab server | 小团队共享 | 多用户、workspace 权限、持久化事件 |
| docker | 可复现环境 | 容器化 server 和 runner |
| HPC bridge | 大流域或 batch | Harness 提交 SLURM job，Park/Resume |

## 2. 服务组成

```text
web app          # React scientific workbench
api server       # Bun/Hono REST + WebSocket
agent runtime    # Zero adapter + Coordinator
job runner       # local/docker/slurm runner
workspace store  # filesystem + DuckDB/Parquet
secret store     # env/keyring/vault
```

## 3. 本地开发

```text
bun install
bun run dev
```

开发环境可以使用 dummy runner 和 fixture，不要求真实 HPC。

## 4. 单机部署

单机部署建议：

- workspace 放在大容量磁盘；
- SHUD/rSHUD/AutoSHUD/Zero 作为 submodule 或 runtime repos；
- server 进程由 systemd 或 process manager 管理；
- 日志和 artifact 分区保存；
- secrets 不进入 workspace Git。

## 5. Docker 部署

Docker 模式需要处理：

- R 环境；
- SUNDIALS/GDAL 等依赖；
- SHUD 编译工具链；
- workspace volume；
- host 用户权限；
- 大文件 artifact 挂载。

## 6. HPC/SLURM 接入

Harness 不应把 HPC 当普通本地命令。推荐 runner adapter：

```text
slurm.submit
slurm.status
slurm.cancel
slurm.collect_logs
```

SLURM job 完成后由 watcher 触发 collect，再 resume Coordinator。

## 7. 数据持久化

MVP 可以使用 filesystem + DuckDB：

```text
workspace/tasks/*.yaml
workspace/runs/*.yaml
workspace/warehouse/*.parquet
```

后续需要多用户协作时再引入数据库。

## 8. 验收标准

- [ ] local dev 可启动 Web UI 和 API。
- [ ] workspace 路径可配置。
- [ ] server 重启后能恢复 parked jobs。
- [ ] Docker 模式能运行 tiny fixture 或 dummy run。
- [ ] HPC 模式不会阻塞 LLM loop。
