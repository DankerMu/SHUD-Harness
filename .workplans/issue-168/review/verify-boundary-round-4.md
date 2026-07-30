# Round 4 verifier — task boundary

Reviewed head: `cc89c89da7af3d68e0004766b495e5e72988036e`

Candidate: `boundary-02`
Verdict: CONFIRMED
Disposition: FIX_NOW

The active #168.A `In` list omits the newly added `lib/capabilities.ts`, although
that file is imported by ingress and owns descriptor/openat/read/stat/close and
forbidden-authority behavior. The umbrella task does not replace the split
fixture's explicit ownership rule. Add the owner to the #168.A path list and
align the boundary evidence; no excluded-scope expansion is required.
