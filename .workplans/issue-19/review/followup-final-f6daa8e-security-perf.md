# Final follow-up review -- security/performance

Reviewed head SHA: `f6daa8ee6af061097a2407c35593def8a873f600`
PR: `#48`
Issue: `#19`

## Summary

Security/performance review is not clean.

## Candidate findings

- C5 / P1: relative `protectedRawPaths: ["data/raw"]` are canonicalized against the Node process cwd, while sandboxed bash runs in `ctx.workDir`, so the seatbelt profile can protect the wrong raw root when those directories differ.
- C6 / P2: profile/temp cleanup runs uncaught from `finally`; if the sandboxed command mutates a writable profile/temp root, cleanup failure can mask the real tool result.

## Gate recommendation

Blocked pending verifier gate.
