## Claude Code Notes

- 知识域类 skill（如调试方法论）自动触发率低，优先显式 `/skill-name` 调用。
- 安装重叠 skill 时剪枝旧/被取代项，保持技能列表清晰。
- Claude runtime 安装：skills -> `.claude/skills/`，agents -> `.claude/agents/`；改 canonical 后重装，勿编辑投影副本。
