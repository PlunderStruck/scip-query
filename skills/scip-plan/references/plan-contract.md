# Plan contract reference

Use this reference when `scip-query plan example` is not enough, when a plan
must express retirement, a justified survivor, a shared owner, or ordered
slices, or when validation reports a relationship error.

## Compact authoring form

The compact form is accepted only inside one `scip-query-plan` JSON fence. It
is expanded into the strict v1 input before validation and storage.

```json
{
  "schemaVersion": 1,
  "form": "compact",
  "goal": {
    "feature": "The requested change reaches coherent completion",
    "invariants": ["Unrelated behavior remains true"],
    "scenario": {
      "name": "The outcome is complete",
      "given": "The repository has its current behavior",
      "when": "The authorized change completes",
      "then": "The outcome and preservation rules hold"
    }
  },
  "change": {
    "key": "stable-task-key",
    "outcome": "The observable repository outcome"
  },
  "class": "relational",
  "seeds": [
    { "id": "entry", "kind": "symbol", "referent": "handleRequest", "role": "entry point" }
  ],
  "preserve": [
    { "condition": "Existing error behavior remains true", "evidence": ["tests"] }
  ],
  "retire": [
    {
      "kind": "identity",
      "referent": "legacyHandler",
      "responsibility": "old dispatch",
      "condition": "The old identity is unreachable and no longer communicates current design",
      "evidence": ["closure"]
    }
  ],
  "architecture": [
    { "condition": "Configured architecture rules remain clean", "evidence": ["gate"] }
  ],
  "evidence": {
    "tests": { "description": "Run focused behavior tests" },
    "closure": { "description": "Inspect the retirement closure" },
    "gate": { "description": "Run the configured diff gate", "command": "scip-query diff-gate" }
  }
}
```

Omitted `retire`, `survivors`, `reuse`, `architecture`, and `slices` arrays are
empty. Item IDs are generated in stable list order when omitted. Give a seed an
explicit ID when another item must refer to it.

If a hook restores active work, replace the inline `goal` and `change` objects
with the restored identities:

```json
{
  "schemaVersion": 1,
  "form": "compact",
  "goalId": "SQG-...",
  "changeId": "SQC-..."
}
```

Keep the other compact fields. This form continues the current records and
does not create another goal or change. Do not mix identities with inline
objects.

## Fields that need judgment

- `preserve` names behavior that must remain true and the evidence that can
  fail if it changes.
- `retire` names an old identity, responsibility, configuration, test, doc, or
  architecture concept that must stop being reachable or communicating the
  current design.
- `survivors` names residue that may remain only because the goal, repository
  policy, or a separately delegated decision still authorizes its current
  role. A plan cannot authorize its own exception.
- `reuse` is for one existing symbol that must remain the single owner of a
  responsibility used by at least two named affected seeds. Use `consumers` to
  name those seed IDs. Leave it empty when no concrete shared owner exists.
  Resolve every direct reuse option from `plan-context` by comparing its
  responsibility and observable behavior with the changed path. Existing
  wiring or reachability is not a semantic difference. Separate ownership
  needs a concrete behavior, lifecycle, or architecture-boundary difference.
- `architecture` uses the repository's configured policy. A clean generic gate
  cannot prove an ownership rule that is not encoded in that policy.
- `evidence` maps short IDs to checks that could expose a false condition. A
  command is optional; do not invent one merely to fill the field.
- `slices` is empty for relational work. Sustained work uses ordered items with
  `outcome`, `evidence`, and optional `dependsOn`; give slice IDs explicitly
  when another slice depends on them.

## Applying and resuming

Run `scip-query plan apply <path>` once before source edits only when work must
survive several phases or a context reset. Bounded relational work uses its
readable plan without durable records. Existing relational contracts remain
valid for compatibility. An applied contract fixes the pre-edit observation
and creates or continues the work, plan, and derived obligations in one
idempotent action.

Supported hooks restore bounded active state after session start and
compaction. Use `attempt status`, `decision status`, `obligation status`, or
`completion status` only when the restored summary says that named state was
omitted or conflicted. Ordinary commands and Stop evaluation write attempts
and decisions automatically; manual create operations are for unsupported
adapters or explicit ledger repair.

Only a controller-derived complete evaluation produces a completion
transition. A passing test, gate, or agent statement alone does not.
