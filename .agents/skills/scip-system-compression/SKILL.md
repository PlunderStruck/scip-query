---
name: scip-system-compression
description: Compress systems with SCIP evidence. Use to zoom out, simplify architecture, eliminate layers, consolidate commands/scripts/helpers, find deeper roles, reason about same-in-principle repetition, build a compression atlas, or execute ordered simplification.
---

# SCIP System Compression

Use this skill as an architecture-compression wrapper around the mapping and
maintainability detectors exposed through the primary
[`scip-query`](../../../skills/scip-query/SKILL.md) skill. Gather and rank the
evidence first, then implement one authorized compression slice at a time.

Load the primary scip-query mapping rules from [`../../../skills/scip-query/SKILL.md`](../../../skills/scip-query/SKILL.md). Load [`references/compression-atlas.md`](references/compression-atlas.md) for the full atlas template and [`references/compression-patterns.md`](references/compression-patterns.md) for pattern ideas.

## Unique Lens

System compression asks:

```text
What recurring roles or policies are expressed by too many mechanisms, and what smaller mechanism could produce the same behavior without hiding real variation?
```

Use the compression references only after the primary `scip-query` workflow has
identified a broad enough scope to justify an atlas.

## Add-On Workflow

1. Map the selected scope with the primary `scip-query` workflow and relevant maintainability detectors.
2. Classify opportunities with dispositions: `merge`, `delete`, `inline`, `extract`, `generate`, `enforce`, `supersede`, `defer`, `skip`.
3. Build a compression atlas only when several mechanisms share a role, policy, lifecycle, or execution shape.
4. Execute one coherent slice at a time, then use native checks plus one final `scip-query diff-impact` and `scip-query architecture` pass.

Report what disappeared, what new mechanism replaced it, what essential variation stayed separate, and the next pressure point.
