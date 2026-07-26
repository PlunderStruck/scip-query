# Public TypeScript API evolution

The public TypeScript API is the compiler-visible declaration surface
reachable through `scip-query` package export paths. Its essential property is
that downstream programs can depend on it without importing this repository's
internal files.

Every built declaration path is recorded in
`docs/api/scip-query.api.json`. The report includes exported names, declaration
kinds and signatures, generic and parameter syntax, return types, and the
shared declaration chunks that carry referenced public types. Generation
normalizes formatting, comments, named import/export order, path separators,
and tsup chunk hashes so the review shows semantic declaration changes rather
than build noise.

## Contributor workflow

Build and compare the current declarations:

```bash
npm run api:check
```

The check fails closed when a declaration target is absent, the committed
manifest is malformed, its acceptance record is missing, or any declaration
changes. Review every reported path and downstream use. Then accept the change
with one classification:

```bash
npm run api:update -- \
  --classification additive \
  --reason "Add an optional result field for evidence provenance."
```

The classifications are:

- `additive`: an old consumer remains valid, such as a new export or an
  optional result field;
- `compatible-correction`: the declaration report changes to correct a
  contract that did not describe usable runtime behavior, with the reasoning
  recorded for review;
- `breaking`: an old consumer may stop compiling or acquire a different
  meaning.

The checker automatically identifies additions and removals. It treats changed
signatures and referenced shared declarations conservatively. A human may
classify uncertain drift as a compatible correction or breaking change, but
cannot accept a known or uncertain change as additive without resolving the
evidence.

`api:update` writes a content-addressed record under
`docs/api/changes/`. The record binds the old and new manifest digests, package
version, automatic result, chosen classification, reason, and exact change
list. Do not edit the generated manifest or an acceptance record by hand.

## Compatibility policy

- Keep a deprecated export or adapter for at least one minor release before
  removal when a feasible compatibility path exists.
- Add optional fields instead of making old consumers construct new required
  state.
- Treat parameter optionality, union membership, generic constraints, and
  discriminated-union members as contract changes even when runtime tests pass.
- Preserve the compile fixture in
  `tests/fixtures/public-api-consumer/`. It represents a previously written
  downstream program and must compile against the newly built package.
- The two-package release coordinator runs lint, whose gate includes
  `api:check`, before packing either artifact or reading registry state. Direct
  `npm publish` is refused by `prepublishOnly`; it is not an alternate API
  compatibility path. A declaration change is not accepted merely because
  its implementation tests pass.
