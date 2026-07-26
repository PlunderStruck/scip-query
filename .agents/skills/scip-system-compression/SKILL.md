---
name: scip-system-compression
description: Compress systems with SCIP evidence. Use to zoom out, simplify architecture, eliminate layers, consolidate commands/scripts/helpers, find deeper roles, reason about same-in-principle repetition, build a compression atlas, or execute ordered simplification.
---

# SCIP System Compression

Use this skill as an architecture-compression wrapper around the
maintainability scenario in
[`scip-audit`](../../../skills/scip-audit/SKILL.md) and the confirmed-finding
implementation path in
[`scip-improve`](../../../skills/scip-improve/SKILL.md). Audit gathers and
ranks the evidence; improve plans and verifies one compression slice at a
time.

Load shared scip-query mechanics from [`../../../skills/_shared/SKILL.md`](../../../skills/_shared/SKILL.md). Load [`references/compression-atlas.md`](references/compression-atlas.md) for the full atlas template and [`references/compression-patterns.md`](references/compression-patterns.md) for pattern ideas.

## Unique Lens

System compression asks:

```text
What recurring roles or policies are expressed by too many mechanisms, and what smaller mechanism could produce the same behavior without hiding real variation?
```

Use the compression references only after `scip-audit` has identified a broad
enough scope to justify an atlas.

## Add-On Workflow

1. Run the `scip-audit` maintainability scenario for the selected scope.
2. Classify opportunities with dispositions: `merge`, `delete`, `inline`, `extract`, `generate`, `enforce`, `supersede`, `defer`, `skip`.
3. Build a compression atlas only when several mechanisms share a role, policy, lifecycle, or execution shape.
4. Execute slices through `scip-improve` and close each one with `scip-verify`.

Report what disappeared, what new mechanism replaced it, what essential variation stayed separate, and the next pressure point.
