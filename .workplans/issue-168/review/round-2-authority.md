# PR #170 Round 2 authority/resource/path review

Reviewed head: `f49ac2704619bafa31504691daee2a2360ce3452`
Verdict: not clean; one P1 candidate, deduplicated with the full-scope review.

## P1 test-evidence — wrapper controls are not an independent interposer

The preload creates wrappers and stores them on global symbols, but it does not
replace normal module resolution. The control program explicitly reads and
calls those wrappers, while production uses the original `node:fs`/`bun:ffi`
imports. Targeted reproduction under the preload performed normal Node and FFI
absolute opens successfully with an empty event list. The eight controls and
red mutation consequently prove wrapper behavior, not interception of the
production call path.

Install real module or OS-boundary interposition, make controls use normal
imports, and demonstrate a compiling production-path ambient open/read/write/
spawn mutation turns red without side effects on both platforms. Blocking: yes.

Retained-descriptor cleanup, primary-error precedence, descriptor baselines,
symlink and ancestor/final replacement paths were clean. No separate resource
or path-safety candidate was found.
