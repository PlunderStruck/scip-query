# TypeScript breadth and public-command audit — 2026-09-09

Status: discovery findings remain open. No production code, build, installation, or historical results were changed by this pass. The [work plan](../plans/2026-09-09-typescript-breadth-audit.md), [machine report and command ledger](typescript-accuracy-audit/2026-09-09-breadth-results.json), and new recorders preserve the next work across sessions.

## What was actually audited

An accuracy check compares a reported repository fact with an independently established fact about the same source and configuration. Executing a command successfully checks its invocation path; it does not establish that its answer is right. Comparing incremental indexing with a clean rebuild checks consistency; both can share the same wrong answer.

The older command audit exercised every then-retained command and checked selected facts. The recent 686-program audit checked compiler-valid programs, runtime outcomes, qualified calls, values, selected HTTP consumers and indexing histories. These are complementary finite experiments, not exhaustive TypeScript or command verification. This discovery pass deliberately leaves production frozen while broadening the experiments.

- Current built inventory: **86 controls — 81 public and five compatibility/internal controls**, unchanged from the retained historical inventory. The per-command ledger distinguishes invocation checks, independent assertions and unsupported coverage.
- Replayed all **71 general command invocations** against the saved 13-file compiler fixture: all expected exits/payloads passed; **41 of 42 independent fact checks passed**. The failed constructor assertion is assessed below rather than silently updated.
- Replayed **48 operational**, **58 transport/session**, and **eight architecture/hook** checks successfully in disposable repositories. Vue augmentation's missing-provider rejection was exercised; this does not validate positive Volar integration.
- The first positive frontend replay failed because its rebuilt database was corrupt. Repeating the frontend phase recovered it and passed **34 checks**. Two additional fresh lifecycle sequences reproduced the corruption; the diagnostic run observed corruption immediately after `reindex` returned success. Those failures remain failures.
- Added **109 compiler-valid value/call programs**, including shared-object escape paths, getters/setters, mutation primitives, numeric/string expressions, property construction and positive controls. All independent execution expectations match, with zero invalid programs in the final recording.
- Added **51 independently executed HTTP consumers**, five public runtime projections, **34 independently executed slice programs** with three input combinations each, and five public slice projections. HTTP is replaced only by a recorder of the actual argument; there are no network requests.
- **35 additional call-graph consumers** and raw-SCIP constructor diagnosis are recorded in the machine report. One getter-related qualification difference was observed; a getter executes during property access, so that difference alone is not classified as a false executed-body claim. Comparing consumers is not by itself independent correctness evidence.

The audit recorders deliberately finish successfully after recording product failures. The summarizer's `--check` gate rejects the measured failures. A green recorder result must never be reported as a passing accuracy audit.

## Findings

### TS-B01 — shared object escapes still produce false constants

**Confirmed: 16 wrong literal values in the 109-program corpus.** Eight remain false literal HTTP paths in the public-consumer corpus; direct imported-reader variants become unknown when passed to `fetch`, which is useful counterevidence against claiming every consumer always reproduces the error.

```ts
// owner.ts
export const box = { path: '/wrong' };
export function access() {
  return box;
}
export function read() {
  return box.path;
}

// writer.ts
import { access } from './owner.js';
export function change() {
  access().path = '/right';
}

// client.ts
import { read } from './owner.js';
import { change } from './writer.js';
export function entry() {
  change();
  return fetch(read()); // actual argument: /right; extracted literal: /wrong
}
```

Equivalent exposures through closures, getters, arrays, objects, destructuring, default exports and re-exported factories reproduce the problem. Map/Set cases correctly become unknown in this experiment.

The object exists once at runtime even when several expressions refer to it. Compiler references identify declarations; a writer referencing `access` need not mention `box`. `sharedMemberWriteIsUnproved` checks files referring directly to the original compiler symbol and skips its owning file. That cannot establish that an escaped object's contents stayed unchanged. The previous report documented general heap-alias limits, but a limit should prevent an unsupported literal claim, not merely appear in prose elsewhere.

Repair direction: qualify escaping mutable values at the shared proof boundary. Preserve supported immutable/primitive and unchanged-property controls. Runtime caching must track any newly consulted escape/writer evidence.

### TS-B02 — expression uncertainty becomes a literal runtime address

**Confirmed: 24 additional wrong literal HTTP paths**, separate from the eight shared-object HTTP failures. These are two cooperating defects in different layers:

1. `evaluateStaticConcatenation` joins display text for every parsed `+`, without establishing JavaScript string addition. For `'/item/' + (1 + 2)`, execution yields `/item/3`, while the evaluator produces `/item/12` with `constrained-pattern` precision and `constant` evidence. Other arithmetic is inserted as source text; template expressions can become `/item/{}`.
2. `BoundaryKeyPart` drops the value's precision. `observation` reconstructs it from `evidence` and treats `constant` as `literal`, even when its retained term contains unknown operands or a pattern. It therefore strengthens an unproved address.

These failures would evade a verifier that checked only `evaluateStaticValue.precision === 'literal'`. The consumer must be checked too. Runtime joins in the measured CLI packet remain **candidate** edges; this audit does not claim they were exact handoffs. One CLI projection prints the wrong `/wrong` rendezvous key. Missing edges in other bounded projections are not proof that the false observation was harmless or absent.

Repair direction: model supported JavaScript operand types/coercion or return unknown, and preserve precision through every value consumer instead of recreating it from provenance labels. Test literal paths, genuine parameterized patterns, unknown operands and mixed expressions separately.

### TS-B03 — slices report complete coverage while missing exercised writes

**Confirmed: 12 of 34 examples omit an input that changes the returned value and still report complete model and slice coverage, with an empty unsupported list.**

```ts
export function entry(input = 2, other = 11) {
  let value = other;
  class C {
    static {
      value = input;
    }
  }
  return value;
}
```

Executing this with `input=2` and `input=5` returns 2 and 5. Its backward slice — the modeled definitions and decisions contributing to the selected `value` occurrence — includes `other` and omits `input`. It reports `typescript-compiler-cfg-reaching-definitions`, `complete`, no omissions and no unsupported operations. Public `dependence-slice` reproduces this for a static block, a getter and direct `eval`.

Other failures involve called closures/arrows, setters, instance/static initializers, tagged templates, object conversion, iterators and `Reflect.apply`. Straight assignments, branches, ordinary loops, finalization and destructuring controls retain observed inputs. Switch/iteration/default/postfix limitations are disclosed in the corresponding controls.

`collectNodeAccesses` skips function/class bodies. `addCrossCallableCandidates` skips uses that already have a local reaching definition and handles ancestor-to-inner capture, leaving writes from nested execution back into an outer binding unqualified. Class static initialization and direct eval require further effect handling. Using the TypeScript parser does not mean these custom dependence algorithms inherit the compiler's semantic correctness.

Repair direction: model or invalidate every potentially affected definition at the relevant operation. Unsupported effects must prevent a complete-slice claim. Check `slice-cohesion` and every dataflow/cleanup consumer of this model after fixing its owner.

### TS-B04 — constructor evidence disappears from the legacy call graph

**Confirmed omission; the old assertion's demand for an exact constructor body is too strong under the newer implementation-proof policy.** Both facts matter.

The saved fixture calls `new Store()`, `sum(...)`, and `store.write(...)`. Raw SCIP retains three Store-related references, and the shared unfiltered callee rows include Store from declaration, semantic and chunk evidence. Its implementation proof is `constructor-source-unproved`, so retaining a qualified declaration candidate is appropriate.

`getCalleeRowsForSymbol(..., { callableOnly: true })` then removes the class identity: it accepts function-like symbols or selected evidence-source names, and a class represented by `scip-declaration` fails that filter. Public `call-graph` loses the constructor entirely, while `complexity` still reports three targets. The fix is not to restore an unjustified exact label. Preserve the observed construction as qualified evidence and disclose unresolved implementations consistently across views.

### TS-B05 — a successful rebuild can publish a corrupt SQLite index

**Confirmed in three fresh disposable lifecycle sequences.** The sequence is operational setup/index/watch/uninstall checks, transport/session checks, then a TypeScript configuration/source expansion adding TSX and auxiliary Vue files. The frontend phase calls `reindex --language typescript --force --trust-project-tools`, which returns zero and prints successful indexing. Immediately afterward, SQLite's own `PRAGMA integrity_check` raises `database disk image is malformed`. `augment-sources` and all six frontend analysis controls subsequently fail.

Repeating the frontend rebuild recovered the first repository and all 34 frontend assertions passed. This separates the detectors' exercised results from the corrupt-index failure. The cause inside rebuild publication is **not yet isolated**; an SQLite error does not by itself identify a particular writer or rename race. Raw logs, three disposable roots and a corrupt database/sidecar snapshot remain under `/tmp/scip-query-breadth-audit/` for repair investigation. No existing project watcher was restarted or stopped.

Repair direction: reproduce the publication transition with integrity checks and identify the writer/state transition before changing it. Require a readable accepted database after a reported successful rebuild, and preserve the previous accepted generation when publication fails.

## Remaining coverage and audit limits

- Twelve of the new programs have projected compiler-target/range gaps. They are recorded separately from wrong literal claims, and are not twelve proven compiler-index bugs. The previous corpus's nine target omissions and fifteen imprecise ranges remain historical coverage gaps.
- Positive command examples do not cover every flag, language, framework, tsconfig combination, deployment or process interruption. Many smell commands have an invocation replay and linked historical tests but no new independent positive fixture here. The ledger says so.
- New slice execution establishes **presence** of an influence when changing one input changes the output. Equal outputs in three executions do not establish independence or an exhaustive slice.
- Intermediate invalid fixtures were rejected and corrected before final measurements. Runtime-transpiled files were moved outside indexed fixture roots after an intermediate run showed they were being augmented as additional JS source. Final counts use the isolated run, not the contaminated one.
- No fresh full ordinary test-suite run or new indexing-history matrix is claimed. Production stayed frozen; the last turn's suite/history results remain separate. New audit tooling is typechecked. No coding-agent benchmarks were run.

The central architectural issue is repeated loss of proof limits between producers and consumers, alongside incomplete effect models. A parser can correctly identify syntax while a later algorithm infers the wrong value, misses a write, strengthens a label or filters out a relationship. Repairs should establish one tested contract for each shared fact and carry its limitations through every public consumer. Finite passing fixtures cannot establish universal TypeScript accuracy.
