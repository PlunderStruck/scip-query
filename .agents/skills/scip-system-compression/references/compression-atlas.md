# Compression Atlas

Use this reference when the compression scope is broad enough that local refactors may interact. The atlas is a planning artifact: it should exist before implementation, and it should be updated after each cluster if code changes reveal new facts.

## Atlas Template

```text
Scope
- Target:
- Assumed boundaries:
- Explicit non-goals:
- Public surfaces to preserve:

System Map
- Entry points:
- Major subsystems:
- Tests/docs/generated artifacts:
- Current ownership boundaries:

Role Inventory
- Role:
  Referents:
  Execution shape:
  Evidence:
  Pressure:

Opportunity Ledger
- ID:
  Opportunity:
  Evidence:
  Root cause:
  Proposed disposition: merge | delete | inline | extract | generate | enforce | supersede | defer | skip
  Disposition reason:
  Cluster:
  Public behavior constraints:

Compression Clusters
- Name:
  Thesis:
  Opportunities:
  Old mechanisms:
  New mechanism:
  What disappears:
  Touch map:
  Depends on:
  Validation:
  Risk:

Dependency Order
1. Cluster:
   Enables:
   Must precede:
   Validation after cluster:

Sense-Check
- Content check:
- Structure check:
- Value check:
- Rework check:
- Public-surface check:

Final Audit
- Concepts removed:
- Concepts added:
- Net concept count:
- Largest remaining pressure point:
- Deferred opportunities:
```

## Ledger Rules

Every discovered opportunity gets exactly one disposition. If an opportunity is too small, speculative, risky, or outside the current scope, mark it `defer` or `skip` with a reason instead of dropping it.

Use `supersede` when a local opportunity will be absorbed by a larger mechanism. For example, a wrapper-candidate finding may be superseded by a broader adapter-core split if the wrapper disappears as part of moving behavior into the core.

Use `enforce` when the goal is to make drift impossible. The real referents are repeated predicates, option defaults, SQL fragments, lint rules, typed descriptors, tests, or generated surfaces. The narrower policy should become easier to use than the scattered alternatives.

## Ordering Rules

Order by enabling power, not by apparent size.

Prefer this order when the evidence supports it:

1. Public behavior characterization: tests, snapshots, help output, or documented API constraints.
2. Shared policy or descriptor center: one place to name the rule or execution shape.
3. Adapters and callers: migrate concrete units onto the new center.
4. Compatibility shells: keep thin aliases only when needed for public stability.
5. Deletions and inlining: remove old mechanisms after references prove they are replaced.
6. Docs and generated surfaces: update or derive them once runtime behavior is settled.

Reject an order when it causes a file to be rewritten by multiple clusters without a stated reason. Merge those clusters or introduce the enabling mechanism first.

## Sense-Check Questions

- Does each cluster remove a concept, policy branch, lifecycle, or hand-maintained surface?
- Does the new mechanism have one clear role, or is it a false center?
- Are skipped opportunities skipped because of verified facts, not convenience?
- Are deferred opportunities still visible with a reason and revisit condition?
- Would an executor know exactly which files and symbols to change?
- Can focused validation prove behavior stayed stable after each cluster?
