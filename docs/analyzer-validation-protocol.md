# Analyzer validation protocol

This protocol tests whether scip-query reports useful repository evidence on
arbitrary projects. It does not use a hidden exact implementation as the only
oracle, and it does not treat a command firing as proof that the product helped.

An oracle is an independent way to determine what is true in the fixture. A
fixture is a disposable repository state with known relationships or defects.
A true positive is a reported item whose claimed relationship or defect exists
at its cited source. A false positive is a reported item whose claim does not
hold when the source and relevant consumers are inspected.

## Required evidence

For each detector family, use at least:

1. a small synthetic fixture that isolates the claimed behavior;
2. a real repository example with normal framework and build conventions;
3. one negative example that looks similar but should not be reported;
4. direct source, compiler, test, or version-history evidence for the verdict.

Do not score a detector by output volume. Count correct findings, incorrect
findings, missed known cases, time, and output size separately.

## Mapping commands

Validate `context`, graph queries, and `diff-impact` against relationships that
can be independently checked through compiler references, source imports,
tests, or a second language-aware tool. Judge:

- whether the named entry-to-effect path is real;
- whether material consumers are present;
- whether bounded coverage is disclosed;
- whether the output helps form a correct plan without unnecessary commands.

## Cleanup commands

For dead code, duplication, drift, extraction, wrappers, migration residue, and
documentation findings, record:

- the exact claim the command made;
- the source location and evidence class;
- the repair that would follow if the claim is correct;
- intentional variation or framework behavior that defeats the claim;
- whether rerunning after the repair removes the finding.

## React and Vue

Test both frameworks. Each corpus must include components, hooks or composables,
large views, intentional variants, framework entrypoints, and generated or test
files. Vue source augmentation must be enabled before judging Vue recall.

## Architecture

Define boundary rules before creating the violating edge. Confirm that
`architecture` reports the forbidden dependency with both endpoints and does
not invent violations outside the declared rules. Then remove the edge and
confirm the finding disappears.

## Health

Judge each underlying finding before judging the aggregate report. A health
score is a summary of detector output, not an independent oracle. Baseline mode
is valid only for the narrower question: did a new stable finding identity
appear relative to the recorded baseline?

## Agent-effectiveness trials

To test whether the product helps an agent, run matched control and treatment
tasks in separate disposable copies of the same fixture:

- use the same provider, model, reasoning level, task prompt, starting commit,
  dependency state, and hidden time limit;
- prepare and index the treatment before measured work begins;
- give the control ordinary repository tools and the treatment the reduced
  scip-query exploration surface;
- do not reveal hidden scoring facts or the time limit;
- keep full transcripts;
- score plan accuracy, implementation correctness, completeness, architecture,
  residue, elapsed time, and tokens separately.

The treatment succeeds only when it improves task outcomes or reaches the same
outcome with a meaningful efficiency gain. A detector warning counts as value
only if it identifies a real issue and changes the agent's work for the better.
