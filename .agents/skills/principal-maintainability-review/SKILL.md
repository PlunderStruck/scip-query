---
name: principal-maintainability-review
description: Review maintainability like a principal engineer. Use when the user asks what a senior/staff/principal maintainer would notice, whether code looks vibe-coded, what is gross, what should be fundamentally different, or which architecture smells matter beyond ordinary deduplication.
---

# Principal Maintainability Review

Use this skill as a tone and judgment wrapper around the maintainability
scenario in [`scip-audit`](../../../skills/scip-audit/SKILL.md). The owning
workflow remains read-only: it gathers SCIP evidence and ranks maintainability
pressure. Hand confirmed implementation work to
[`scip-improve`](../../../skills/scip-improve/SKILL.md).

Load shared scip-query mechanics from [`../../../skills/_shared/SKILL.md`](../../../skills/_shared/SKILL.md) when the target repo has a SCIP index.

## Unique Lens

Translate persona prompts into technical prompts:

- "What would a principal engineer notice?" means "Which concepts are scattered, undernamed, or locally reimplemented?"
- "Would this look vibe-coded?" means "Where does the structure fail to communicate the domain model or maintenance contract?"
- "What is gross here?" means "Which code shapes create avoidable future mistakes?"
- "What would be fundamentally better?" means "Which smaller mechanism would preserve behavior while reducing concept count?"

Be direct without mocking the code. Taste is allowed only when it is tied to concrete files, symbols, tests, public surfaces, callers, or maintenance failure modes.

## Report Add-On

After the `scip-audit` maintainability scenario has evidence, add:

```markdown
Principal read:
- What future mistake this invites:
- The smaller named mechanism:
- Essential variation to preserve:
- First slice:
```

Do not run an independent closeout. A read-only review ends with the audit
verdict; any implemented slice uses `scip-improve` and closes through
`scip-verify`.
