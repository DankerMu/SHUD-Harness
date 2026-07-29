# Phase 6.2 semantic identity source-only red proof

> Historical proof only. The user-approved Round 4 breadth split removed the
> pathname-generation authority exercised here from PR #167 and routed it to
> #166. Current retained-slice behavior is proved by
> `red-proof-final-retained-slice.md`.

PR: #167
Issue: #164
Pre-repair source baseline: `4d7fa1664d2fcf718daaa800d8a5d13878a65912`
Baseline `current-source.ts` blob: `2e9bd81b965996e636d128f5227a8937ca2c1d2b`
Restored fixed working blob: `64fa1cbed3d06fbabd8bf61ee14ca25f802efc14`

The new late-replacement tests remained in place while only
`spikes/git-status-capability/contracts/lib/current-source.ts` was replaced by
the pre-repair blob.

Exact command:

```sh
bun test ./spikes/git-status-capability/contracts/tests/current-source-authority.test.ts -t 'semantic source .* retains verified bytes and fails closed when a later admission replaces its inode'
```

Observed pre-repair result:

```text
red_exit=1
0 pass, 3 fail
contract-v1.json late inode replacement unexpectedly succeeded
source-input-v1.synthetic.frame late inode replacement unexpectedly succeeded
source-input-v1.synthetic.sha256 late inode replacement unexpectedly succeeded
```

After restoring the fixed source blob, the exact same command produced:

```text
green_exit=0
3 pass, 0 fail
```

The full focused suite then produced `53 pass, 0 fail, 768 assertions`; no
`red-proof` stash remained and `git diff --check` passed.
