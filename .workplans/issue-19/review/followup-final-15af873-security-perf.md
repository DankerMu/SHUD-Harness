Reviewer agent: review-security-perf
Review round: final comprehensive follow-up 15af873
Reviewed head SHA: 15af873cf0eb54b6510257b126d55250a071df7f
Last clean reviewed SHA: 15af873cf0eb54b6510257b126d55250a071df7f

Summary: Clean security/performance follow-up. The fix fails closed for malformed evaluator output without exposing trusted raw-denial evidence or executing the inner tool, and it adds no new hot-path I/O or broader parsing surface.

Findings:
- None.

Resolution:
- Malformed raw-rule ownership attempts now fail as invalid policy gate decisions instead of fabricating a raw-denial payload; malformed generic denies fail without policy-gate-denied metadata.
