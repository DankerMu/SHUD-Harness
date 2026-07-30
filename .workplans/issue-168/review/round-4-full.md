# PR #170 Round 4 full-scope review

Reviewed head: `cc89c89da7af3d68e0004766b495e5e72988036e`
Verdict: not clean; one P1 candidate.

## P1 test-evidence — computed module loading bypasses the closed surface

A production mutation can compute the `node:fs` specifier and load it through a
normal runtime entrypoint, then call an unwrapped API such as
`createReadStream(fileURL)`. The current static regex sees no literal module and
the preload's spread exposes the original API. Darwin and Linux both read the
ambient file with no event while the focused suite remained green.

The registered invariant requires an OS-level interposer or a non-bypassable
structured module/authority boundary, not another API-name patch. Add a
compiling computed-loader plus unenumerated-API mutation on both platforms and
prove zero read before declaring closure. Blocking: yes.

All non-authority contract/resource/scope surfaces were clean.
