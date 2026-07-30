# Round 4 verifier — test evidence / authority

Reviewed head: `cc89c89da7af3d68e0004766b495e5e72988036e`

Candidate: `ev-09`
Verdict: CONFIRMED
Disposition: FIX_NOW

Ordinary import mocking denied the expected path, but computed
`process.getBuiltinModule`, `import.meta.require`, and `createRequire` returned
the real builtin object. `readFileSync` and `createReadStream(fileURL)` read the
ambient file with no events while focused tests stayed green. The static regex
misses computed loader/specifier forms; `import.meta.require` itself is caught by
the broad `require(` pattern, but still bypasses runtime interception. Closure
requires a non-bypassable authority boundary or OS-level interception rather
than more API-name enumeration.
