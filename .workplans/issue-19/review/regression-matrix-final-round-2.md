# Issue #19 Regression Matrix

Writer denial:
- `printf x > data/raw/input.csv` -> deny before execute.
- `printf x >& data/raw/input.csv` -> deny before execute.
- raw `workDir` + `printf x > input.csv` -> deny before execute.
- data `workDir` + `touch raw/input.csv` -> deny before execute.
- `cd data && rm raw/input.csv` -> deny before execute.
- `env -C data rm raw/input.csv` -> deny before execute.
- `env --chdir=data bash -c 'rm raw/input.csv'` -> deny before execute.
- `(cd data && rm raw/input.csv)` -> deny before execute.
- `{ cd data; rm raw/input.csv; }` -> deny before execute.

Variable/env denial:
- `RAW=data/raw bash -c 'rm "$RAW/input.csv"'` -> deny before execute.
- `env RAW=data/raw sh -c 'printf x > "$RAW/out.csv"'` -> deny before execute.
- `env KIND=raw sh -c 'rm data/$KIND/input.csv'` -> deny before execute.
- composed variables -> deny before execute.

Expansion/path alias denial:
- `rm data/ra$(printf w)/input.csv` -> deny before execute.
- `rm ${UNSET:-data/raw/input.csv}` -> deny before execute.
- `rm data/ra[w]/input.csv` -> deny before execute.
- `rm data/ra[[:lower:]]/input.csv` -> deny before execute.
- `printf x > DATA/RAW/input.csv` -> deny before execute.

Implicit cwd output denial:
- raw `workDir` + `curl -O URL` -> deny before execute.
- raw `workDir` + `wget URL` -> deny before execute.
- raw `workDir` + `git clone URL` -> deny before execute.
- raw `workDir` + `tar -xf archive.tar` -> deny before execute.

Executable code:
- Python open write -> deny.
- Python/R heredoc write -> deny.
- R `writeLines`, `write.csv`, `saveRDS` raw target -> deny.
- Python/R raw read snippet -> allow.

Read-only allow:
- `cat data/raw/input.csv` -> allow.
- `cd data/raw && cat input.csv` -> allow.
- `stat data/raw/input.csv` -> allow.
- `sha256sum data/raw/input.csv` -> allow.
- read-only `curl`/`wget` URL containing `/data/raw/` -> allow.
- non-in-place `sed`, read-only `find`, `awk` raw input -> allow where intent is constructibly read-only.

Governed workspace allow:
- `touch workspace/tasks/TASK-001/scratch/data/raw/out.csv` -> allow.
- task scratch `workDir` + `touch data/raw/out.csv` -> allow.

Audit safety:
- ordinary append -> creates one NDJSON row.
- traversal task/file names -> reject.
- audit dir/file symlink -> reject.
- parent directory swap -> reject before writing.
- preexisting FIFO/special audit path -> reject quickly.

Bounds:
- large executable code string with many raw literals -> bounded decision, preferably conservative deny when scan budget is exceeded.
