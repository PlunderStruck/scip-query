import { existsSync } from 'node:fs';
import type { CommandDescriptor } from '../commands/command-descriptor-types.js';
import { doc, option, parseInteger, withJsonOption } from '../commands/command-spec-builders.js';
import {
  booleanOptionValue,
  dbCommand,
  definedNumberOption,
  printJsonEnvelope,
  stringArg,
  stringOptionValue,
} from '../commands/command-execution.js';
import { displayPathRange, render } from '../render.js';
import {
  defaultMapPathForSpec,
  isTlaCheckerMode,
  loadTlaModelContract,
  loadTraceSteps,
  readTlaModuleFacts,
  resolveContractPath,
  resolveProjectPath,
  type TlaCheckerMode,
} from '../../tla/model-contract.js';
import { runTlaTool, type TlaToolResult } from '../../tla/tool-runner.js';
import { verifyTlaConformance, type TlaConformanceFinding, type TlaConformanceResult } from '../../tla/conformance.js';

interface TlaVerifyResult {
  operation: 'verify';
  specPath: string;
  mapPath: string;
  configPath?: string;
  checker: TlaToolResult;
  conformance: TlaConformanceResult;
  exitCode: number;
}

const handleTla = dbCommand(({ db, args, opts }) => {
  const operation = stringArg(args, 0);
  if (operation !== 'verify') {
    throw new Error(`unknown tla operation: ${operation}. Supported operation: verify`);
  }
  const specArg = stringArg(args, 1);
  const projectRoot = db.config.projectRoot;
  const specPath = resolveProjectPath(projectRoot, specArg);
  if (!specPath || !existsSync(specPath)) throw new Error(`TLA+ spec not found: ${specArg}`);

  const mapArg = stringOptionValue(opts, 'map') ?? defaultMapPathForSpec(specArg);
  const loaded = loadTlaModelContract(projectRoot, mapArg);
  if (!loaded.loaded) throw new Error(loaded.errors.join('\n'));
  const { contract, mapPath, mapDir } = loaded.loaded;
  const configArg = stringOptionValue(opts, 'config') ?? contract.config;
  const configPath = resolveContractPath(projectRoot, mapDir, configArg);
  const checker = parseChecker(stringOptionValue(opts, 'checker') ?? 'auto');
  const moduleFacts = readTlaModuleFacts(projectRoot, specArg);
  const traceArg = stringOptionValue(opts, 'trace');
  const configuredTraceSteps = contract.traces.flatMap((tracePath) => loadTraceSteps(projectRoot, tracePath).steps);
  const requestedTrace = traceArg ? loadTraceSteps(projectRoot, traceArg) : { steps: [], errors: [] };
  const traceErrors = traceArg ? requestedTrace.errors : [];
  const conformance = verifyTlaConformance(db, contract, moduleFacts, [
    ...configuredTraceSteps,
    ...requestedTrace.steps,
  ]);
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
    tlaToolsJar: stringOptionValue(opts, 'tlaTools'),
    apalacheBin: stringOptionValue(opts, 'apalache'),
    length: definedNumberOption(opts, 'length', 10),
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
        'Install the requested checker, pass --tla-tools or --apalache, or rerun with --checker none intentionally.',
    });
  }

  const result: TlaVerifyResult = {
    operation: 'verify',
    specPath,
    mapPath,
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

  renderTlaVerify(result);
  process.exitCode = result.exitCode;
});

export const tlaQueryCommandDescriptors: CommandDescriptor[] = [
  {
    id: 'tla',
    command: 'tla <operation> <spec>',
    description: 'Verify a TLA+ model and its TypeScript mapping contract',
    options: withJsonOption([
      option('--map <file>', 'scip-query TLA mapping JSON file'),
      option('--config <file>', 'TLA+ checker config file'),
      option('--checker <mode>', 'Checker mode: auto, sany, tlc, apalache, none', undefined, 'auto'),
      option('--tla-tools <jar>', 'Path to tla2tools.jar'),
      option('--apalache <binary>', 'Path to apalache-mc binary'),
      option('--length <n>', 'Bounded checker length for Apalache', parseInteger, 10),
      option('--trace <file>', 'Runtime trace JSON file to check against the mapping'),
      option('--allow-unknown', 'Exit zero when only unknown findings remain'),
    ]),
    renderShape: 'custom',
    docs: doc('Formal Models', ['scip-query tla verify specs/Queue.tla --map specs/Queue.scip-tla.json']),
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

function renderTlaVerify(result: TlaVerifyResult): void {
  console.log(`TLA+ verify: ${result.specPath}`);
  console.log(`Mapping: ${result.mapPath}`);
  if (result.configPath) console.log(`Config:  ${result.configPath}`);
  console.log(
    `Checker: ${result.checker.checker} ${result.checker.status} (${result.checker.durationMs}ms, exit ${result.checker.exitCode ?? result.checker.signal ?? 'n/a'})`,
  );
  for (const diagnostic of result.checker.diagnostics) {
    console.log(`  [${diagnostic.severity}] ${diagnostic.message}`);
  }

  const errors = result.conformance.findings.filter((finding) => finding.severity === 'error');
  const unknowns = result.conformance.findings.filter((finding) => finding.evidence === 'unknown');
  console.log(
    `\nConformance: ${result.conformance.mappedVariables} variable(s), ${result.conformance.mappedActions} action(s), ${result.conformance.resolvedReferents} resolved referent(s), ${result.conformance.staticWrites.length} modeled write(s), ${result.conformance.traceStepsChecked} trace step(s).`,
  );
  if (result.conformance.findings.length === 0) {
    console.log('PASS: model, mapping, and checked code evidence agree.');
    return;
  }

  console.log(
    `Findings: ${errors.length} error(s), ${unknowns.length} unknown(s), ${result.conformance.findings.length} total.`,
  );
  for (const finding of result.conformance.findings) {
    renderFinding(finding);
  }
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
