# Finding Verification: cand-7b410d1-01-profile-file-helper-relative-root

Reviewed head SHA: 7b410d1745ba82657ac66a5175c568d32d875abc
Verdict: CONFIRMED

Evidence: `writeRawDataSeatbeltProfileFile(profile, profileRoot?)` is exported and forwards the optional `profileRoot`; profile file creation selects that override before metadata roots and passes it to helper code that resolves with `resolve(path)`, then creates/writes under that root. The raw-data sandbox module is publicly re-exported.

Note: Existing absolute-root checks covered profile builder/audit/hardlink surfaces, not this profile-file override.
