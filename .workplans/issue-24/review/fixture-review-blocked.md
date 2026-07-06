Reviewer agent: fixture-review
Issue: #24
Verdict: BLOCKED

Findings:
- Blocking ambiguity: the fixture required concrete `tool_id` values but mixed concrete ids with capability labels such as `spawn/wait`, `file_read`, `search/glob/grep`, `git 只读诊断`, `artifact 写`, `patch 工具`, and `memory(draft)`.

Resolution:
- OpenSpec fixture updated to separate exact comparable `toolIds` from explanatory `permissionNotes`.
- Issue body update prepared at `.workplans/issue-24/issue-body-with-toolids.md`.
