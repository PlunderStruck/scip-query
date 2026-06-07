# Compression Atlas

Use this reference when the compression scope is broad enough that local refactors may interact. The atlas is a written planning artifact: save it before implementation when filesystem edits are allowed, and update it after each cluster if code changes reveal new facts.

Preferred paths are `docs/plans/YYYY-MM-DD-<scope>-compression-atlas.md` or `reports/compression/YYYY-MM-DD-<scope>-atlas.md`. If neither directory exists, create the one that best matches the repository's existing planning/reporting conventions.

## Atlas Template

```text
Scope
- Target:
- Assumed boundaries:
- Explicit non-goals, including health-score or detector-count optimization:
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

Deferred Register
- Opportunity ID:
  Evidence:
  Blocking fact:
  Dependency or owner:
  Revisit condition:
  Next-pass priority:

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
- Ambition check:

Final Audit
- Concepts removed:
- Concepts added:
- Net concept count:
- Largest remaining pressure point:
- Deferred opportunities:
```

## Ledger Rules

Every discovered opportunity gets exactly one disposition. Do not use `defer` just because the change is large or cross-cutting. If an opportunity is false, net-negative, or too speculative, mark it `skip`. If it is valid but blocked, mark it `defer` and add it to the deferred register.

Every deferred entry must name a verified blocking fact and a revisit condition. Acceptable blockers include an explicit scope limit, missing evidence that would make implementation unsafe, dependency on an earlier cluster, conflict with unrelated user changes, unavailable runtime/generated artifacts, or user-imposed time/slice limits.

Major cleanup is in scope when it is the right compression. Prefer ordered clusters, public-behavior validation, and implementation over deferral.

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
- Are deferred opportunities still visible with a blocking fact and revisit condition?
- Is any major but correct compression being deferred merely because it is large?
- Would an executor know exactly which files and symbols to change?
- Can focused validation prove behavior stayed stable after each cluster?
