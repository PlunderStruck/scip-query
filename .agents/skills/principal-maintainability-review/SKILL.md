---
name: principal-maintainability-review
description: Review maintainability like a principal engineer. Use when the user asks what a senior/staff/principal maintainer would notice, whether code looks vibe-coded, what is gross, what should be fundamentally different, or which architecture smells matter beyond ordinary deduplication.
---

# Principal Maintainability Review

Use this skill as a tone and judgment wrapper around the maintainability
detectors exposed through the primary
[`scip-query`](../../../skills/scip-query/SKILL.md) skill. Keep a review
read-only unless the user separately authorizes edits.

Load the primary scip-query mapping rules from [`../../../skills/scip-query/SKILL.md`](../../../skills/scip-query/SKILL.md) when the target repo has a SCIP index.

## Unique Lens

Translate persona prompts into technical prompts:

- "What would a principal engineer notice?" means "Which concepts are scattered, undernamed, or locally reimplemented?"
- "Would this look vibe-coded?" means "Where does the structure fail to communicate the domain model or maintenance contract?"
- "What is gross here?" means "Which code shapes create avoidable future mistakes?"
- "What would be fundamentally better?" means "Which smaller mechanism would preserve behavior while reducing concept count?"

Be direct without mocking the code. Taste is allowed only when it is tied to concrete files, symbols, tests, public surfaces, callers, or maintenance failure modes.

## Report Add-On

After the primary `scip-query` workflow has gathered maintainability evidence,
add:

```markdown
Principal read:
- What future mistake this invites:
- The smaller named mechanism:
- Essential variation to preserve:
- First slice:
```

A read-only review ends with an evidence-backed verdict. If the user authorizes
edits, implement one coherent slice and verify it with the repository's native
checks plus one final `scip-query diff-impact` and `scip-query architecture`
pass.
