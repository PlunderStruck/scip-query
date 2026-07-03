import { existsSync } from 'node:fs';
import type { ScipDatabase } from '../../storage/db.js';
import type { CommandDescriptor } from '../commands/command-descriptor-types.js';
import type { CommandHandler } from '../commands/command-descriptor-types.js';
import {
  collectValues,
  doc,
  option,
  parseInteger,
  parsePositiveInteger,
  withJsonOption,
} from '../commands/command-spec-builders.js';
import {
  booleanOptionValue,
  definedNumberOption,
  numberOptionValue,
  optionalStringArg,
  printJsonEnvelope,
  splitCommanderActionArgs,
  stringArg,
  stringArrayOptionValue,
  stringOptionValue,
  type CommandOptions,
} from '../commands/command-execution.js';
import { withDb } from '../cli-context.js';
import { displayPathRange } from '../render.js';
import {
  dedupeTracePaths,
  defaultMapPathForSpec,
  discoverMapPathByModule,
  isTlaCheckerMode,
  loadTlaModelContract,
  loadTraceSteps,
  readTlaConfigInvariants,
  readTlaModuleFacts,
  readTlaModuleFactsFromSanyXml,
  resolveContractPath,
  resolveProjectPath,
  type TlaCheckerMode,
} from '../../tla/model-contract.js';
import { exportSanyXml } from '../../tla/sany-facts.js';
import { fetchTlaToolsJar, resolveTlaToolsJar, runTlaTool, type TlaToolResult } from '../../tla/tool-runner.js';
import { verifyTlaConformance, type TlaConformanceFinding, type TlaConformanceResult } from '../../tla/conformance.js';
import { scaffoldTlaModel } from '../../tla/scaffold.js';
import { buildInstrumentation } from '../../tla/instrument.js';
import { runTraceCheck, traceHarnessBaseName, type TraceActionCoverage } from '../../tla/trace-spec.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

interface TlaVerifyResult {
  operation: 'verify';
  specPath: string;
  mapPath: string;
  /**
   * I5 / auto-discovery: set when `mapPath` was not the default
   * filename-matched mapping but was instead found by scanning sibling
   * `*.scip-tla.json` files for one whose `module` field names this spec.
   */
  mappingDiscoveredBy?: 'module-field';
  configPath?: string;
  checker: TlaToolResult;
  conformance: TlaConformanceResult;
  exitCode: number;
}

const handleTla: CommandHandler = async (...rawArgs: unknown[]) => {
  const { args, opts } = splitCommanderActionArgs(rawArgs);
  const operation = stringArg(args, 0);
  if (operation === 'fetch-tools') {
    const result = await fetchTlaToolsJar();
    if (booleanOptionValue(opts, 'json')) {
      printJsonEnvelope('tla', args, opts, result);
      return;
    }
    console.log(`tla2tools.jar ${result.status}: ${result.path}`);
    console.log(`Version: ${result.version}`);
    console.log(`SHA-256: ${result.sha256}`);
    return;
  }
  if (operation === 'scaffold') {
    const target = optionalStringArg(args, 1);
    if (!target) throw new Error('tla scaffold requires a target source file');
    withDb((db) => runTlaScaffold(db, args, opts, target));
    return;
  }
  if (operation === 'instrument') {
    const specArg = optionalStringArg(args, 1);
    withDb((db) => runTlaInstrument(db, args, opts, specArg));
    return;
  }
  if (operation === 'trace-check') {
    const specArg = optionalStringArg(args, 1);
    if (!specArg) throw new Error('tla trace-check requires a spec path');
    withDb((db) => runTlaTraceCheck(db, args, opts, specArg));
    return;
  }
  if (operation !== 'verify') {
    throw new Error(
      `unknown tla operation: ${operation}. Supported operations: verify, scaffold, instrument, trace-check, fetch-tools`,
    );
  }

  const specArg = optionalStringArg(args, 1);
  if (!specArg) throw new Error('tla verify requires a spec path');

  withDb((db) => runTlaVerify(db, args, opts, specArg));
};

function runTlaScaffold(db: ScipDatabase, args: readonly unknown[], opts: CommandOptions, target: string): void {
  const projectRoot = db.config.projectRoot;
  const result = scaffoldTlaModel(db, target, {
    moduleName: stringOptionValue(opts, 'moduleName'),
    specDir: stringOptionValue(opts, 'out'),
  });
  const outDirArg = stringOptionValue(opts, 'out') ?? join('specs', result.moduleName);
  const outDir = resolveProjectPath(projectRoot, outDirArg);
  if (!outDir) throw new Error(`scaffold output dir escapes the project root: ${outDirArg}`);

  const force = booleanOptionValue(opts, 'force');
  const files = [
    { path: join(outDir, `${result.moduleName}.tla`), body: result.spec },
    { path: join(outDir, `${result.moduleName}.cfg`), body: result.cfg },
    { path: join(outDir, `${result.moduleName}.scip-tla.json`), body: result.map },
  ];
  for (const file of files) {
    if (!force && existsSync(file.path)) {
      throw new Error(`refusing to overwrite ${file.path} (pass --force to replace scaffold output)`);
    }
  }
  mkdirSync(outDir, { recursive: true });
  for (const file of files) writeFileSync(file.path, file.body);

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('tla', args, opts, {
      operation: 'scaffold',
      moduleName: result.moduleName,
      target,
      written: files.map((file) => file.path),
      variables: result.variables,
      actions: result.actions,
      warnings: result.warnings,
    });
    return;
  }

  console.log(`Scaffolded ${result.moduleName} from ${target} (draft — review every TODO):`);
  for (const file of files) console.log(`  wrote ${file.path}`);
  console.log(
    `Variables (${result.variables.length}): ${result.variables
      .map((variable) => `${variable.name}${variable.domainTla ? '' : ' [TODO domain]'}`)
      .join(', ')}`,
  );
  console.log(
    `Actions (${result.actions.length}): ${result.actions
      .map((action) => `${action.name}(writes: ${action.writes.join(',') || '-'})`)
      .join('; ')}`,
  );
  for (const warning of result.warnings) console.log(`WARNING: ${warning}`);
  console.log(
    `Next: fill the TODO guards/domains, then run 'scip-query tla verify ${join(outDirArg, `${result.moduleName}.tla`)}'.`,
  );
}

function runTlaInstrument(
  db: ScipDatabase,
  args: readonly unknown[],
  opts: CommandOptions,
  specArg: string | undefined,
): void {
  const projectRoot = db.config.projectRoot;
  const mapArg = stringOptionValue(opts, 'map') ?? (specArg ? defaultMapPathForSpec(specArg) : undefined);
  if (!mapArg) throw new Error('tla instrument requires --map <mapping.json> (or a spec path to derive it from)');
  const loaded = loadTlaModelContract(projectRoot, mapArg);
  if (!loaded.loaded) throw new Error(loaded.errors.join('\n'));
  const { contract, mapDir } = loaded.loaded;

  const instrumentation = buildInstrumentation(db, contract);
  const outArg = stringOptionValue(opts, 'out') ?? join(mapDir, 'scip-tla-recorder.ts');
  const outPath = resolveProjectPath(projectRoot, outArg);
  if (!outPath) throw new Error(`instrument output escapes the project root: ${outArg}`);
  if (!booleanOptionValue(opts, 'force') && existsSync(outPath)) {
    throw new Error(`refusing to overwrite ${outPath} (pass --force to replace the recorder)`);
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, instrumentation.recorderSource);

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('tla', args, opts, {
      operation: 'instrument',
      recorder: outPath,
      variables: instrumentation.variables,
      wiring: instrumentation.wiring,
    });
    return;
  }

  console.log(`Wrote trace recorder: ${outPath}`);
  console.log('Wire tlaRecord(...) into each mapped action (1 line per action), then run your tests with');
  console.log("SCIP_TLA_TRACE=<trace.json> set, and check the result with 'scip-query tla trace-check'.");
  console.log('Wiring sites:');
  for (const site of instrumentation.wiring) {
    const where = site.file ? `${site.file}:${site.line}` : `UNRESOLVED (${site.codeRef})`;
    console.log(`  - ${site.action} -> ${where}  writes: ${site.writes.join(', ') || '-'}`);
  }
}

function runTlaTraceCheck(db: ScipDatabase, args: readonly unknown[], opts: CommandOptions, specArg: string): void {
  const projectRoot = db.config.projectRoot;
  const specPath = resolveProjectPath(projectRoot, specArg);
  if (!specPath || !existsSync(specPath)) throw new Error(`TLA+ spec not found: ${specArg}`);
  const mapArg = stringOptionValue(opts, 'map') ?? defaultMapPathForSpec(specArg);
  const loaded = loadTlaModelContract(projectRoot, mapArg);
  if (!loaded.loaded) throw new Error(loaded.errors.join('\n'));
  const { contract } = loaded.loaded;

  const traceArgs = stringArrayOptionValue(opts, 'trace');
  const tracePaths = dedupeTracePaths(projectRoot, [...contract.traces, ...traceArgs]);
  const steps = tracePaths.flatMap((tracePath) => loadTraceSteps(projectRoot, tracePath).steps);
  if (steps.length === 0) {
    throw new Error('no trace steps found: pass --trace <file> (repeatable) or list traces in the mapping contract');
  }

  const verdict = runTraceCheck({
    specPath,
    baseModuleName: traceHarnessBaseName(specPath),
    mappedVariables: Object.keys(contract.variables),
    mappedActions: Object.keys(contract.actions),
    steps,
    nextOperator: stringOptionValue(opts, 'next'),
    toolOptions: {
      projectRoot,
      tlaToolsJar: stringOptionValue(opts, 'tlaTools'),
      timeoutMs: numberOptionValue(opts, 'timeoutMs'),
    },
  });

  const exitCode =
    verdict.status === 'accepted'
      ? 0
      : verdict.status === 'unavailable' && booleanOptionValue(opts, 'allowUnknown')
        ? 0
        : 1;

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('tla', args, opts, { operation: 'trace-check', ...verdict, exitCode });
    process.exitCode = exitCode;
    return;
  }

  console.log(`TLA+ trace-check: ${specPath}`);
  console.log(`Trace: ${steps.length} step(s) -> ${verdict.states} pinned state(s)`);
  if (verdict.generation) {
    console.log(`Pinned variables: ${verdict.generation.variables.join(', ')}`);
    for (const warning of verdict.generation.warnings) console.log(`WARNING: ${warning}`);
  }
  console.log(`${verdict.status.toUpperCase()}: ${verdict.detail}`);
  if (booleanOptionValue(opts, 'coverage')) renderTraceActionCoverage(verdict.actionCoverage);
  process.exitCode = exitCode;
}

function renderTraceActionCoverage(coverage: readonly TraceActionCoverage[]): void {
  if (coverage.length === 0) return;
  const exercised = coverage.filter((entry) => entry.stepsObserved > 0);
  const unexercised = coverage.filter((entry) => entry.stepsObserved === 0);
  console.log(`Action coverage: ${exercised.length}/${coverage.length} mapped action(s) exercised by this trace.`);
  for (const entry of exercised) console.log(`  - ${entry.action}: ${entry.stepsObserved} step(s)`);
  if (unexercised.length > 0) {
    console.log(
      `  Unexercised: ${unexercised.map((entry) => entry.action).join(', ')} — classify each as a pure modeling abstraction (no code twin, expected) or a real coverage gap (record another trace).`,
    );
  }
}

/**
 * I5 / usability: `--map` wins outright when passed. Otherwise, the
 * default filename-matched mapping (`Spec.scip-tla.json`) wins when it
 * exists — auto-discovery-by-module only runs as a fallback when that
 * default is absent, and only picks a mapping when exactly one sibling
 * `*.scip-tla.json` names this spec's module; an ambiguous match is a hard
 * error (never a silent pick), and no match at all falls through to
 * `loadTlaModelContract`'s ordinary "map file not found" error against the
 * default path, unchanged from before this fallback existed.
 */
function resolveMapArgForVerify(
  projectRoot: string,
  specArg: string,
  specPath: string,
  opts: CommandOptions,
): { mapArg: string; mappingDiscoveredBy?: 'module-field' } {
  const explicitMap = stringOptionValue(opts, 'map');
  if (explicitMap) return { mapArg: explicitMap };

  const defaultMapArg = defaultMapPathForSpec(specArg);
  const defaultMapPath = resolveProjectPath(projectRoot, defaultMapArg);
  if (defaultMapPath && existsSync(defaultMapPath)) return { mapArg: defaultMapArg };

  const discovered = discoverMapPathByModule(projectRoot, specPath);
  if (discovered.status === 'ambiguous') {
    throw new Error(
      `multiple *.scip-tla.json files declare module "${discovered.moduleName}": ${discovered.candidates.join(', ')} — pass --map to disambiguate`,
    );
  }
  if (discovered.status === 'found') {
    return { mapArg: discovered.mapPath, mappingDiscoveredBy: 'module-field' };
  }
  return { mapArg: defaultMapArg };
}

function runTlaVerify(db: ScipDatabase, args: readonly unknown[], opts: CommandOptions, specArg: string): void {
  const projectRoot = db.config.projectRoot;
  const specPath = resolveProjectPath(projectRoot, specArg);
  if (!specPath || !existsSync(specPath)) throw new Error(`TLA+ spec not found: ${specArg}`);

  const { mapArg, mappingDiscoveredBy } = resolveMapArgForVerify(projectRoot, specArg, specPath, opts);
  const loaded = loadTlaModelContract(projectRoot, mapArg);
  if (!loaded.loaded) throw new Error(loaded.errors.join('\n'));
  const { contract, mapPath, mapDir } = loaded.loaded;
  const configArg = stringOptionValue(opts, 'config') ?? contract.config;
  const configPath = resolveContractPath(projectRoot, mapDir, configArg);
  const checker = parseChecker(stringOptionValue(opts, 'checker') ?? 'auto');
  const tlaToolsJar = stringOptionValue(opts, 'tlaTools');
  const moduleFacts =
    readSanyModuleFactsForVerify(projectRoot, specArg, specPath, tlaToolsJar) ??
    readTlaModuleFacts(projectRoot, specArg);
  const checkedInvariants = readTlaConfigInvariants(configPath);
  const traceArgs = stringArrayOptionValue(opts, 'trace');
  // Dedupe by resolved path first (P5.5 / followup #20): --trace naming the
  // same file as an entry already in contract.traces (or repeated across
  // multiple --trace flags, C2) must not double-count that file's steps.
  const tracePaths = dedupeTracePaths(projectRoot, [...contract.traces, ...traceArgs]);
  const traceLoads = tracePaths.map((tracePath) => ({ tracePath, ...loadTraceSteps(projectRoot, tracePath) }));
  const traceSteps = traceLoads.flatMap((load) => load.steps);
  // Preserve pre-existing behavior: only the explicitly requested --trace
  // file(s)' load errors surface here (contract.traces load errors are a
  // pre-existing silent gap, unrelated to this step).
  const explicitTraceArgs = new Set(traceArgs);
  const traceErrors = traceLoads.filter((load) => explicitTraceArgs.has(load.tracePath)).flatMap((load) => load.errors);
  const conformance = verifyTlaConformance(db, contract, moduleFacts, traceSteps, checkedInvariants);
  for (const error of [...loaded.errors, ...traceErrors]) {
    conformance.findings.push({
      id: `TLA-CONTRACT-${conformance.findings.length + 1}`,
      severity: 'error',
      evidence: 'contract',
      category: 'contract',
      message: error,
      why: ['The verifier can only make accurate claims after the mapping and trace inputs are valid.'],
      remediation: 'Fix the mapping or trace input and rerun scip-query tla verify.',
    });
  }

  const toolResult = runTlaTool({
    projectRoot,
    specPath,
    configPath: configPath ?? undefined,
    checker,
    tlaToolsJar,
    apalacheBin: stringOptionValue(opts, 'apalache'),
    length: definedNumberOption(opts, 'length', 10),
    timeoutMs: numberOptionValue(opts, 'timeoutMs'),
  });
  if (toolResult.status === 'skipped' && checker !== 'none') {
    conformance.findings.push({
      id: 'TLA-MODEL-CHECKER-UNAVAILABLE',
      severity: 'warning',
      evidence: 'unknown',
      category: 'contract',
      message: toolResult.diagnostics.map((diagnostic) => diagnostic.message).join('; '),
      why: ['The TLA+ model was not checked by SANY, TLC, or Apalache in this run.'],
      remediation:
        "Install the requested checker, run 'scip-query tla fetch-tools', set TLA_TOOLS_JAR, pass --apalache, or rerun with --checker none intentionally.",
    });
  }

  const result: TlaVerifyResult = {
    operation: 'verify',
    specPath,
    mapPath,
    ...(mappingDiscoveredBy ? { mappingDiscoveredBy } : {}),
    ...(configPath ? { configPath } : {}),
    checker: toolResult,
    conformance,
    exitCode: exitCodeFor(toolResult, conformance, booleanOptionValue(opts, 'allowUnknown')),
  };

  if (booleanOptionValue(opts, 'json')) {
    printJsonEnvelope('tla', args, opts, result);
    process.exitCode = result.exitCode;
    return;
  }

  renderTlaVerify(result, booleanOptionValue(opts, 'full'));
  process.exitCode = result.exitCode;
}

function readSanyModuleFactsForVerify(
  projectRoot: string,
  specArg: string,
  specPath: string,
  tlaToolsJar: string | undefined,
) {
  const jar = resolveTlaToolsJar({ projectRoot, specPath, tlaToolsJar, checker: 'sany' });
  if (!jar) return null;
  const xml = exportSanyXml({ specPath, jarPath: jar });
  return xml ? readTlaModuleFactsFromSanyXml(projectRoot, specArg, xml) : null;
}

export const tlaQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'tla',
    command: 'tla <operation> [spec]',
    description:
      'TLA+ model workflow: verify a model and mapping contract, scaffold a draft model from indexed code, generate a trace recorder, or check a recorded trace against the next-state relation',
    options: withJsonOption([
      option('--map <file>', 'scip-query TLA mapping JSON file'),
      option('--config <file>', 'TLA+ checker config file'),
      option('--checker <mode>', 'Checker mode: auto, sany, tlc, apalache, none', undefined, 'auto'),
      option('--tla-tools <jar>', 'Path to tla2tools.jar'),
      option('--apalache <binary>', 'Path to apalache-mc binary'),
      option('--length <n>', 'Bounded checker length for Apalache', parseInteger, 10),
      option(
        '--timeout-ms <n>',
        'Model checker subprocess timeout in milliseconds (verify and trace-check; default 120000)',
        parsePositiveInteger,
      ),
      option(
        '--trace <file>',
        'Runtime trace JSON file to check against the mapping (repeatable; verify and trace-check both merge and dedupe with contract.traces)',
        collectValues,
        [],
      ),
      option(
        '--next <operator>',
        'trace-check: next-state operator the harness requires between states (default Next; use for dual-spec models, e.g. NextCurrent)',
        undefined,
        'Next',
      ),
      option(
        '--coverage',
        'trace-check: print the per-action coverage table (steps exercised per mapped action, counted from accepted trace steps only); --json always includes it',
      ),
      option('--allow-unknown', 'Exit zero when only unknown findings remain'),
      option('--out <path>', 'Output directory (scaffold) or file (instrument)'),
      option('--module-name <name>', 'Module name for scaffolded specs'),
      option('--force', 'Overwrite existing scaffold/instrument output'),
      option(
        '--full',
        'verify: print every finding ungrouped instead of (category, modelElement) groups with 3 exemplars each',
      ),
    ]),
    renderShape: 'custom',
    docs: doc('Formal Models', [
      'scip-query tla verify specs/Queue.tla --map specs/Queue.scip-tla.json',
      'scip-query tla scaffold src/queue/store.ts',
      'scip-query tla trace-check specs/Queue.tla --trace traces/run1.json --coverage',
      'scip-query tla trace-check specs/Queue.tla --trace traces/run1.json --trace traces/run2.json --coverage',
      'scip-query tla trace-check specs/DualSpec.tla --trace traces/run1.json --next NextCurrent',
      'scip-query tla verify specs/Queue.tla --timeout-ms 300000',
      'scip-query tla verify specs/Queue.tla --full',
      'scip-query tla fetch-tools',
    ]),
    handler: handleTla,
  },
];

function parseChecker(value: string): TlaCheckerMode {
  if (!isTlaCheckerMode(value)) throw new Error(`unknown checker mode: ${value}`);
  return value;
}

function exitCodeFor(checker: TlaToolResult, conformance: TlaConformanceResult, allowUnknown: boolean): number {
  if (checker.status === 'failed' || checker.status === 'timed-out') return 1;
  if (conformance.findings.some((finding) => finding.severity === 'error')) return 1;
  if (!allowUnknown && conformance.findings.some((finding) => finding.evidence === 'unknown')) return 1;
  return 0;
}

const MAX_GROUP_EXEMPLARS = 3;

function renderTlaVerify(result: TlaVerifyResult, full: boolean): void {
  console.log(`TLA+ verify: ${result.specPath}`);
  console.log(
    `Mapping: ${result.mapPath}${result.mappingDiscoveredBy === 'module-field' ? ' (matched by module field)' : ''}`,
  );
  if (result.configPath) console.log(`Config:  ${result.configPath}`);
  console.log(
    `Checker: ${result.checker.checker} ${result.checker.status} (${result.checker.durationMs}ms, exit ${result.checker.exitCode ?? result.checker.signal ?? 'n/a'})`,
  );
  for (const diagnostic of result.checker.diagnostics) {
    console.log(`  [${diagnostic.severity}] ${diagnostic.message}`);
  }

  const errors = result.conformance.findings.filter((finding) => finding.severity === 'error');
  const unknowns = result.conformance.findings.filter((finding) => finding.evidence === 'unknown');
  const proof = proofSummary(result);
  console.log(
    `\nConformance: ${result.conformance.mappedVariables} variable(s), ${result.conformance.mappedActions} action(s), ${result.conformance.resolvedReferents} resolved referent(s).`,
  );
  console.log(`Proof: ${proof}`);
  for (const warning of proofWarnings(result)) console.log(`WARNING: ${warning}`);
  if (result.conformance.waivers.length > 0) {
    console.log('Waivers:');
    for (const waiver of result.conformance.waivers) {
      const legacy = waiver.legacy ? ' legacy' : '';
      const scope = waiver.action ? `${waiver.action} ${waiver.kind}` : `variable ${waiver.kind}`;
      console.log(`  - ${scope} ${waiver.variable}:${legacy} ${waiver.reason}`);
    }
  }
  if (result.conformance.findings.length === 0) {
    console.log(
      result.conformance.waivers.length === 0
        ? `PASS: model, mapping, and checked code evidence agree (model parsed by: ${result.conformance.modelParse}).`
        : `PASS: model checker and unwaived conformance checks passed (model parsed by: ${result.conformance.modelParse}); see waived facts above.`,
    );
    return;
  }

  console.log(
    `Findings: ${errors.length} error(s), ${unknowns.length} unknown(s), ${result.conformance.findings.length} total.`,
  );
  if (full) {
    for (const finding of result.conformance.findings) {
      renderFinding(finding);
    }
    return;
  }
  renderTlaFindingGroups(result.conformance);
}

function renderTlaFindingGroups(conformance: TlaConformanceResult): void {
  const findingsById = new Map(conformance.findings.map((finding) => [finding.id, finding]));
  console.log(`\nFinding groups (${conformance.findingGroups.length}) — pass --full for every finding ungrouped:`);
  for (const group of conformance.findingGroups) {
    console.log(
      `\n[${group.severity}] ${group.category}${group.modelElement ? ` (${group.modelElement})` : ''} — ${group.count} finding(s)`,
    );
    for (const findingId of group.findingIds.slice(0, MAX_GROUP_EXEMPLARS)) {
      const exemplar = findingsById.get(findingId);
      if (exemplar) renderFinding(exemplar);
    }
    const remaining = group.count - MAX_GROUP_EXEMPLARS;
    if (remaining > 0) console.log(`  ... and ${remaining} more in this group (use --full to show all)`);
  }
}

function proofSummary(result: TlaVerifyResult): string {
  const checker = `${result.checker.checker} ${result.checker.status === 'passed' ? 'PASS' : result.checker.status.toUpperCase()}`;
  const writeWaivers = result.conformance.waivers.filter((waiver) => waiver.kind === 'write').length;
  const readWaivers = result.conformance.waivers.filter((waiver) => waiver.kind === 'read').length;
  const referentWaivers = result.conformance.waivers.filter((waiver) => waiver.kind === 'referent').length;
  const callChecks = result.conformance.findings.filter((finding) => finding.category === 'missing-call').length;
  return [
    `checker: ${checker}`,
    `model parsed by: ${result.conformance.modelParse}`,
    `writes: ${result.conformance.staticWrites.length} verified, ${writeWaivers} waived`,
    `reads: ${result.conformance.staticReads.length} verified, ${readWaivers} waived`,
    `calls: ${callChecks === 0 ? 'checked' : `${callChecks} missing`}`,
    `traces: ${result.conformance.traceStepsChecked} steps (key-diff; 'tla trace-check' proves acceptance)`,
    ...(referentWaivers > 0 ? [`referents: ${referentWaivers} waived`] : []),
  ].join(' | ');
}

function proofWarnings(result: TlaVerifyResult): string[] {
  const warnings: string[] = [];
  const writeWaivers = result.conformance.waivers.filter((waiver) => waiver.kind === 'write').length;
  const readWaivers = result.conformance.waivers.filter((waiver) => waiver.kind === 'read').length;
  if (writeWaivers > 0 && result.conformance.staticWrites.length === 0) {
    warnings.push('NOTHING PROVEN ABOUT WRITES: every write fact found in this run was waived or unobserved.');
  }
  if (readWaivers > 0 && result.conformance.staticReads.length === 0) {
    warnings.push('NOTHING PROVEN ABOUT READS: every read fact found in this run was waived or unobserved.');
  }
  return warnings;
}

function renderFinding(finding: TlaConformanceFinding): void {
  const location =
    finding.file && finding.startLine !== undefined && finding.endLine !== undefined
      ? ` ${displayPathRange(finding.file, finding.startLine, finding.endLine)}`
      : finding.file
        ? ` ${finding.file}`
        : '';
  console.log(`\n[${finding.severity}] ${finding.category} (${finding.evidence})${location}`);
  console.log(`  ${finding.message}`);
  for (const why of finding.why) console.log(`  why: ${why}`);
  console.log(`  fix: ${finding.remediation}`);
}
