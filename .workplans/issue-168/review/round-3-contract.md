# PR #170 Round 3 parser/contract review

Reviewed head: `17f89edd0eecfdd71834e6ee77ba5d5716d1f7d1`
Verdict: clean.

Malformed/duplicate/depth, item/node, and nonfinite semantic precedence were
checked with finite and nonfinite boundary probes. Byte/depth/node/item exact and
plus-one behavior, 38+2n capacity, normalized result binding, four-SHA equality,
canonical bytes and exact receipts were clean. Darwin focused was 25/532. No
candidate finding was returned; this leaf did not independently repeat Linux.
