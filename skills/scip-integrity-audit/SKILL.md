---
name: scip-integrity-audit
description: Investigate whether a feature fulfills its promised behavior through live consumers. Find partial implementations, decorative checks, ineffective parser migrations, competing implementations, misleading results, and tests validating their own assumptions.
---

# SCIP Integrity Audit

Load `$scip-query` for mechanics and `$scip-explore` when the live path is unknown. Ask “is this real?”: does the implementation produce the outcome its user or consumer relies on?

Use the [implementation-integrity command guide](../scip-query/references/command-guide.md#implementation-integrity) to select a detector for a named concern. Its rows describe what each pattern can miss or misclassify; no detector replaces the live-path investigation below.

An integrity defect is a mismatch between promised behavior and the behavior the live implementation provides. Establish the promise from the task, public contract, consumers, and relevant tests—not a function name alone. A fallback is an alternative selected when another implementation fails or is unavailable; its use cannot support a stronger guarantee than it provides.

Do not attribute intentions such as cheating to an agent or author. Report the concrete shortcut, missing operation, unsupported claim, and consequence.

## Establish promise and live path

State which input should produce which result, rejection, or durable effect. Record uncertainty when requirements are unclear; do not invent a stronger feature and call its absence a defect.

Trace the actual command/API/worker through selected implementations, configuration, effects, fallbacks, and consumers. Inventory plausible parallel implementations even with different names. An installed parser, new class, or unit test calling a helper does not prove production consumers use it.

Choose investigations below for actual evidence gaps. There is no mandatory all-detector battery or requirement to manufacture a finding.

## Investigate the mechanism

| Concern | Investigation |
| --- | --- |
| Success without checking | Run valid and deliberately invalid cases through the public path with independent expected results. Inspect delegated/asynchronous failure before declaring a decorative checker. |
| Feature works only through fallback | Observe primary success and induced failure. Establish the selected path, result/effects, and whether degraded behavior is disclosed. |
| Parser assumes an imagined format | Feed the actual parser/version representative captured input or valid language examples. Verify the consuming traversal and output, not a node merely appearing somewhere. |
| Replacement beside old mechanisms | Trace relevant ingress/configuration variants. Compare cases distinguishing their guarantees; account for consumers and retirement. |
| Status or metric overstates evidence | Trace inputs and coverage to the supporting operation. Independently calculate distinguishing examples; test omissions, errors, and partial results. |
| Tests share implementation mistakes | Exercise a real consumer with independent expected results. Checking only a mocked value does not verify the feature. |

A literal “pass” in a correctly checked branch can be justified; a computed status can be wrong. A failed branch probe is not proof of unreachability. A clean detector result establishes only that supported patterns were not found within coverage.

`decorative-checkers`, `not-implemented`, `test-quality`, `incomplete-migration`, and `twin-drift` shortlist candidates. Check help and limits; run only for a relevant gap. `health` does not run every integrity detector.

## Parser migration example

A syntax tree represents grammatical structure; name resolution connects references to declarations; executing a test observes exercised behavior. Parsing alone cannot fulfill a promise of compiler-backed identity.

For a regex-to-parser migration, exercise the live route with relevant multiline constructs, comments/strings containing code-like text, nested expressions, aliases, or shadowed names. Establish expected output independently.

Look for parser wrappers still delegating to regex, copied extraction rules, unsupported syntax silently returning success, and tests bypassing the live consumer. Regex is appropriate for literal search or a deliberately bounded text format. The defect is claiming guarantees the mechanism cannot establish.

Read [integrity probes](references/integrity-probes.md) when parser, fallback, or comparison details matter.

## Record a justified verdict

For each promise record expected behavior and its source, live producer/consumer, executed input/path, expected versus actual results/effects, verdict, limits, and regression check.

Test the strongest explanation that would make suspected behavior correct: distinct contract, delegated check, compatibility path, or explicitly weaker guarantee. Preserve counterevidence. Names or different outputs alone do not establish a defect.

For authorized substantial fixes use `$scip-plan`. Add a regression check distinguishing old from required behavior, fix the live owner, migrate consumers, and retire obsolete mechanisms where justified. Run behavioral tests, review actual changes, and fresh impact.

Report inventory coverage separately from executed behavior. List unexercised paths and consequences. One favorable example does not verify a whole feature, and a candidate scan does not audit a whole repository.
