#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  byKind,
  coChange,
  complexity,
  cycleSummary,
  decorativeCheckers,
  docDrift,
  drift,
  duplicateBodies,
  isolated,
  notImplemented,
  passthroughCandidates,
  recentDuplicates,
  redundantReexports,
  similarAll,
  similarChains,
  similarFiles,
  similarSignatures,
  testQuality,
  twinDrift,
  unusedImports,
  unusedParams,
  staleAbstractions,
  wrapperCandidates,
} from '../dist/queries/index.js';
import { ScipDatabase } from '../dist/index.js';
import {
  CALIBRATION_SCHEMA_VERSION,
  applyUtilityGroups,
  applyVerdictGroups,
  deterministicSample,
  deterministicStratifiedSample,
  normalizeDeadCandidate,
  normalizeFactualCandidate,
  normalizeSimilarityCandidate,
  parseArchitectureCalibrationOptions,
  parseDeadCalibrationOptions,
  parseFactualCalibrationOptions,
  parseSimilarityCalibrationOptions,
  summarizeCalibration,
  summarizeCalibrationByDetector,
  summarizeUtilityByDetector,
} from './accuracy-calibration-core.mjs';

const repoRoot = resolve(new URL('..', import.meta.url).pathname);
const cliPath = join(repoRoot, 'dist', 'cli.js');
const outDir = join(repoRoot, 'reports', 'accuracy');
const stamp = new Date().toISOString().slice(0, 10);
const runId = new Date().toISOString().replace(/[:.]/g, '-');

const navigationCases = [
  {
    projectRoot: '/Users/aydansalois/Documents/GitHub/on_main_mvp',
    language: 'typescript',
    symbol: 'confirmBooking',
    file: 'src/domain/booking/booking.ts',
    sourceIncludes: ['export async function confirmBooking', 'ConfirmBookingInput'],
    expectedRefs: ['src/domain/agent/tools/confirm-booking.ts'],
    expectedCallGraph: ['maybeSetConfirmedAtAndReturn', 'ensureBookingStatus', 'loadBookingRowOrThrow'],
    expectedDataflow: ['═══ PRODUCERS', 'maybeSetConfirmedAtAndReturn', 'confirmBookingForCustomer'],
    sliceArgs: ['--forward'],
    expectedSlice: ['forward slice', 'confirmBookingForCustomer', 'confirmWebhookBooking'],
  },
  {
    projectRoot: '/Users/aydansalois/Documents/GitHub/qwen3-tts-apple-silicon',
    language: 'python',
    symbol: 'main_menu',
    file: 'main.py',
    sourceIncludes: ['def main_menu():', 'Voice Cloning'],
    expectedRefs: [],
    expectedCallGraph: ['run_clone_manager', 'run_custom_session'],
    expectedDataflow: ['═══ PRODUCERS', 'run_clone_manager', 'run_custom_session'],
    sliceArgs: [],
    expectedSlice: ['backward slice', 'run_clone_manager', 'run_custom_session'],
  },
  {
    projectRoot: '/Users/aydansalois/Documents/GitHub/SynthRunnerRust',
    language: 'rust',
    symbol: 'main',
    file: 'src/main.rs',
    sourceIncludes: ['fn main()', 'synth_runner_rust::run'],
    expectedRefs: [],
    expectedCallGraph: ['app:run()'],
    expectedDataflow: ['═══ DEFINED AT ═══', 'src/main.rs'],
    sliceArgs: [],
    expectedSlice: ['backward slice of main()', 'No connected symbols found.'],
  },
];

const defaultDeadReposByLanguage = {
  typescript: [
    '/Users/aydansalois/Documents/GitHub/Vega_2.0',
    '/Users/aydansalois/Documents/GitHub/openwork',
    '/Users/aydansalois/Documents/GitHub/Stable_Management',
    '/Users/aydansalois/Documents/GitHub/traceroot',
  ],
  rust: [
    '/Users/aydansalois/Documents/GitHub/codex',
    '/Users/aydansalois/Documents/GitHub/SynthRunnerRust',
    '/Users/aydansalois/Documents/GitHub/VegaAssistant',
  ],
};

const deadTruthRules = {
  typescript:
    'No production, public API, framework, generated, reflective, configured, or test-required consumer exists; certified deletion additionally requires an applicable checker.',
  rust: 'No source, test, trait-contract, macro/derive, ABI/registration, Cargo-target, configured-feature, public-library, generated, or reflective consumer exists; certified deletion additionally requires an applicable checker.',
};

const factualTruthRules = {
  'unused-imports':
    'The named binding is imported into the reported file and has no executable, type, decorator, JSX, namespace, re-export, or other language-valid use there.',
  'unused-params':
    'Every reported trailing simple parameter is absent from the callable body, and the callable is a production implementation rather than a required interface or framework signature.',
  cycles:
    'Every adjacent pair in the closed path is a real dependency edge in the accepted index; architectural harm is not part of this fact.',
  'duplicate-bodies':
    'Every grouped callable has the same normalized implementation body and is in a different file; consolidation is not part of this fact.',
  complexity:
    'The source span and LOC match the definition, branches match the disclosed AST or fallback basis, and cyclomatic estimate equals branches plus one.',
  isolated:
    'The production callable has neither a non-self caller nor a non-self callee after compiler, source, framework, test, and configured-root evidence is considered.',
  'redundant-reexports':
    'No repository consumer imports the named export through the reported barrel; public package surfaces are signals, not direct removal claims.',
  'not-implemented':
    'The callable is a placeholder implementation and a production entry, export, override, or caller can reach it.',
  'decorative-checkers':
    'The callable promises validation or a predicate but has no reachable throw, rejecting result, false result, diagnostic sink, assertion, or failing delegate.',
  'test-quality':
    'The cited test is genuinely assertion-free, intentionally skipped, or asserts the same simple literal supplied by its mock, according to the reported subtype.',
};

const similarityTruthRules = {
  'recent-duplicates':
    'The echo side is newer within the declared Git window, the established side predates it, and the reported domain-specific similarity evidence exists; consolidation remains a separate recommendation.',
  similar:
    'The two callables have the disclosed shared callee or source-token evidence and score; generic scaffolding alone is not direct consolidation evidence.',
  'similar-files':
    'The two files have the disclosed distinctive dependency overlap and score; matching framework infrastructure alone is support rather than consolidation evidence.',
  'similar-chains':
    'Both sequences are real dependency paths and the reported edit distance, divergence, prefix, suffix, and similarity agree.',
  'similar-signatures':
    'Every grouped callable has the same normalized parameter and return shape plus compatible LOC band; equal shape alone does not imply duplicate behavior.',
  'twin-drift':
    'Group members represent the same or credibly near concept by name and context, have materially divergent bodies, and are not homonyms, generated leaves, tests, or intentional delegation layers.',
};

const architectureTruthRules = {
  'co-change':
    'Both current files occurred together in the reported number of accepted commits, the individual change counts and confidence agree with the declared full-history filters, and the structural-link and classification fields match repository evidence; hidden coupling is a separate recommendation.',
  'doc-drift':
    'The doc currently cites or historically co-changed with the reported subject, the subject changed after the doc update, any broken reference is genuinely unresolved, and the staleness arithmetic agrees; updating prose is a separate recommendation.',
  drift:
    'The reported dependency edge exists and the stated subtype is true: no accepted import use survived, a declared or inferred layer rule rejects the edge, or exactly one accepted sibling has the dependency; architectural harm is separate.',
  'wrapper-candidates':
    'The short production callable has exactly one external caller file and its enclosing caller or file has the reported fan-in after semantic and source fallback; removing the layer is separate.',
  'passthrough-candidates':
    'The callable has one unique callee and its body literally forwards its parameters through a return expression; public or boundary value is separate.',
  'stale-abstractions':
    'The reported type or class has the disclosed real, transitive, barrel, singleton, and defining-file use evidence and therefore matches the stated low-consumer class; folding or deleting it is separate.',
};

mkdirSync(outDir, { recursive: true });

const args = process.argv.slice(2);
if (args[0] === 'health-dead') {
  runHealthDeadMode(args.slice(1));
} else if (args[0] === 'health-factual') {
  runHealthFactualMode(args.slice(1));
} else if (args[0] === 'health-similarity') {
  runHealthSimilarityMode(args.slice(1));
} else if (args[0] === 'health-architecture') {
  runHealthArchitectureMode(args.slice(1));
} else if (args[0] === 'summarize') {
  runSummarizeMode(args.slice(1));
} else if (args[0] === 'resample') {
  runResampleMode(args.slice(1));
} else {
  runNavigationMode(args);
}

function runResampleMode(rawArgs) {
  const [packetArg, sampleSizeArg = '25'] = rawArgs;
  if (!packetArg) throw new Error('resample requires <packet.json> [sample-size]');
  const sampleSize = Number(sampleSizeArg);
  if (!Number.isInteger(sampleSize) || sampleSize < 1) throw new Error('sample-size must be a positive integer');
  const packet = JSON.parse(readFileSync(resolve(packetArg), 'utf8'));
  if (packet.schemaVersion !== CALIBRATION_SCHEMA_VERSION) {
    throw new Error(`unsupported calibration packet schema: ${packet.schemaVersion}`);
  }

  const rows = [];
  for (const repository of packet.repositories) {
    const detectors = packet.detectors ?? [packet.detector];
    for (const detector of detectors) {
      const candidates = packet.rows.filter(
        (row) => row.repository === repository.repository && row.detector === detector,
      );
      const count = Math.min(sampleSize, candidates.length);
      rows.push(
        ...(packet.detector === 'typescript-architecture'
          ? deterministicStratifiedSample(
              candidates,
              count,
              `${packet.seed}:${repository.repository}:${detector}`,
              (row) => row.findingKind,
            )
          : deterministicSample(candidates, count, `${packet.seed}:${repository.repository}:${detector}`)),
      );
    }
  }
  const resampled = {
    ...packet,
    generatedAt: new Date().toISOString(),
    ...(packet.detectors
      ? { sampleSizePerRepositoryAndDetector: sampleSize }
      : { sampleSizePerRepository: sampleSize }),
    repositories: packet.repositories.map((repository) => ({
      ...repository,
      ...(packet.detectors
        ? {
            sampledCounts: Object.fromEntries(
              packet.detectors.map((detector) => [
                detector,
                Math.min(
                  sampleSize,
                  packet.rows.filter((row) => row.repository === repository.repository && row.detector === detector)
                    .length,
                ),
              ]),
            ),
          }
        : {
            sampled: Math.min(sampleSize, packet.rows.filter((row) => row.repository === repository.repository).length),
          }),
    })),
    rows,
    summary: isRelationshipPacket(packet)
      ? similarityPacketSummary(rows, packet.detectors ?? [], {})
      : packet.detector === 'typescript-factual'
        ? summarizeCalibrationByDetector(rows, { detectors: packet.detectors ?? [] })
        : summarizeCalibration(rows),
  };
  const baseName = `${runId}-${packet.language}-${packet.detector}-resampled`;
  const jsonPath = join(outDir, `${baseName}.json`);
  const markdownPath = join(outDir, `${baseName}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(resampled, null, 2)}\n`);
  writeFileSync(
    markdownPath,
    isRelationshipPacket(packet)
      ? renderRelationshipPacketForType(resampled)
      : packet.detector === 'typescript-factual'
        ? renderFactualPacket(resampled)
        : renderDeadPacket(resampled),
  );
  console.log(jsonPath);
  console.log(markdownPath);
}

function runSummarizeMode(rawArgs) {
  const [packetArg, verdictArg] = rawArgs;
  if (!packetArg || !verdictArg) throw new Error('summarize requires <packet.json> <verdicts.json>');
  const packet = JSON.parse(readFileSync(resolve(packetArg), 'utf8'));
  const verdicts = JSON.parse(readFileSync(resolve(verdictArg), 'utf8'));
  if (packet.schemaVersion !== CALIBRATION_SCHEMA_VERSION) {
    throw new Error(`unsupported calibration packet schema: ${packet.schemaVersion}`);
  }
  let rows = applyVerdictGroups(packet.rows, verdicts.groups ?? []);
  if (isRelationshipPacket(packet)) {
    rows = applyUtilityGroups(rows, verdicts.utilityGroups ?? []);
  }
  const knownPositiveRecallCases = verdicts.knownPositiveRecallCases ?? 0;
  const reviewed = {
    ...packet,
    reviewedAt: new Date().toISOString(),
    verdictSource: resolve(verdictArg),
    rows,
    summary: isRelationshipPacket(packet)
      ? similarityPacketSummary(rows, packet.detectors ?? [], verdicts)
      : packet.detector === 'typescript-factual'
        ? summarizeCalibrationByDetector(rows, {
            detectors: packet.detectors ?? [],
            knownPositiveRecallCases: typeof knownPositiveRecallCases === 'object' ? knownPositiveRecallCases : {},
          })
        : summarizeCalibration(rows, {
            knownPositiveRecallCases: typeof knownPositiveRecallCases === 'number' ? knownPositiveRecallCases : 0,
          }),
  };
  const baseName = `${runId}-${packet.language}-${packet.detector}-reviewed`;
  const jsonPath = join(outDir, `${baseName}.json`);
  const markdownPath = join(outDir, `${baseName}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(reviewed, null, 2)}\n`);
  writeFileSync(
    markdownPath,
    isRelationshipPacket(packet)
      ? renderRelationshipPacketForType(reviewed)
      : packet.detector === 'typescript-factual'
        ? renderFactualPacket(reviewed)
        : renderDeadPacket(reviewed),
  );
  console.log(jsonPath);
  console.log(markdownPath);
}

function runHealthFactualMode(rawArgs) {
  const options = parseFactualCalibrationOptions(rawArgs, defaultDeadReposByLanguage.typescript, resolve);
  runTypeScriptDetectorMode(options, {
    detector: 'typescript-factual',
    cachePrefix: 'scip-query-factual-calibrate-',
    truthRules: factualTruthRules,
    collectCandidates: collectFactualCandidates,
    summarize: (rows, detectors) => summarizeCalibrationByDetector(rows, { detectors }),
    render: renderFactualPacket,
  });
}

function runHealthSimilarityMode(rawArgs) {
  const options = parseSimilarityCalibrationOptions(rawArgs, defaultDeadReposByLanguage.typescript, resolve);
  runTypeScriptDetectorMode(options, {
    detector: 'typescript-similarity',
    cachePrefix: 'scip-query-similarity-calibrate-',
    truthRules: similarityTruthRules,
    collectCandidates: collectSimilarityCandidates,
    summarize: (rows, detectors) => similarityPacketSummary(rows, detectors, {}),
    render: renderSimilarityPacket,
  });
}

function runHealthArchitectureMode(rawArgs) {
  const options = parseArchitectureCalibrationOptions(rawArgs, defaultDeadReposByLanguage.typescript, resolve);
  runTypeScriptDetectorMode(options, {
    detector: 'typescript-architecture',
    cachePrefix: 'scip-query-architecture-calibrate-',
    truthRules: architectureTruthRules,
    collectCandidates: collectArchitectureCandidates,
    summarize: (rows, detectors) => similarityPacketSummary(rows, detectors, {}),
    render: renderArchitecturePacket,
  });
}

function runTypeScriptDetectorMode(options, config) {
  const rows = [];
  const repositories = [];
  let failures = 0;

  for (const sourceRoot of options.roots) {
    const repository = basename(sourceRoot);
    if (!existsSync(join(sourceRoot, '.git'))) {
      failures += 1;
      repositories.push({ repository, sourceRoot, error: 'repository is missing or is not a Git checkout' });
      continue;
    }

    const isolated = createDetachedWorktree(sourceRoot);
    const cacheDir = mkdtempSync(join(tmpdir(), config.cachePrefix));
    let db = null;
    try {
      const env = {
        ...process.env,
        SCIP_QUERY_PROJECT_ROOT: isolated.root,
        SCIP_QUERY_CACHE_DIR: cacheDir,
        SCIP_QUERY_SKIP_WATCH_SERVICE: '1',
      };
      const reindex = runCli(['reindex', '--force', '--language', 'typescript'], isolated.root, env, 600_000);
      if (reindex.status !== 0) {
        failures += 1;
        repositories.push({
          repository,
          sourceRoot,
          commit: isolated.commit,
          error: commandError('reindex', reindex),
        });
        continue;
      }

      const status = runCli(['status', '--capabilities', '--json'], isolated.root, env, 60_000);
      if (status.status !== 0) {
        failures += 1;
        repositories.push({
          repository,
          sourceRoot,
          commit: isolated.commit,
          error: commandError('status', status),
        });
        continue;
      }
      const statusEnvelope = parseEnvelope(status.stdout, 'status');
      const capability = statusEnvelope.result.capabilities?.matrix?.find((entry) => entry.language === 'typescript');
      db = new ScipDatabase({
        projectRoot: isolated.root,
        dbPath: join(cacheDir, 'index.db'),
        indexPath: join(cacheDir, 'index.scip'),
      });

      const candidateCounts = {};
      const sampledCounts = {};
      const detectorMetadata = {};
      for (const detector of options.detectors) {
        const startedAt = Date.now();
        const collection = config.collectCandidates(db, detector, {
          root: isolated.root,
          repository,
          commit: isolated.commit,
          capabilityStatus: capability ?? null,
          sampleSize: options.sampleSize,
          seed: `${options.seed}:${repository}:${detector}`,
        });
        candidateCounts[detector] = collection.total;
        sampledCounts[detector] = collection.rows.length;
        detectorMetadata[detector] = {
          durationMs: Date.now() - startedAt,
          ...(collection.metadata ?? {}),
        };
        rows.push(...collection.rows);
      }

      repositories.push({
        repository,
        sourceRoot,
        commit: isolated.commit,
        language: 'typescript',
        capability: capability ?? null,
        reindexDurationMs: reindex.durationMs,
        candidateCounts,
        sampledCounts,
        detectorMetadata,
      });
    } catch (error) {
      failures += 1;
      repositories.push({ repository, sourceRoot, commit: isolated.commit, error: errorMessage(error) });
    } finally {
      db?.close();
      isolated.remove();
      rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  const packet = {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    detector: config.detector,
    language: 'typescript',
    detectors: options.detectors,
    truthRules: Object.fromEntries(options.detectors.map((detector) => [detector, config.truthRules[detector]])),
    seed: options.seed,
    sampleSizePerRepositoryAndDetector: options.sampleSize,
    repositories,
    rows,
    summary: config.summarize(rows, options.detectors),
  };
  const baseName = `${runId}-${config.detector}-calibration`;
  const jsonPath = join(outDir, `${baseName}.json`);
  const markdownPath = join(outDir, `${baseName}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(packet, null, 2)}\n`);
  writeFileSync(markdownPath, config.render(packet));
  console.log(jsonPath);
  console.log(markdownPath);
  if (failures > 0) process.exitCode = 1;
}

function similarityPacketSummary(rows, detectors, options = {}) {
  const knownPositiveRecallCases = options.knownPositiveRecallCases ?? {};
  const relationships = summarizeCalibrationByDetector(rows, {
    detectors,
    knownPositiveRecallCases:
      typeof knownPositiveRecallCases === 'object' && knownPositiveRecallCases !== null ? knownPositiveRecallCases : {},
  });
  const certificationLimits = { ...(options.certificationLimits ?? {}) };
  for (const detector of options.boundedDetectors ?? []) {
    certificationLimits[detector] ??= 'bounded-candidate-frame';
  }
  for (const [detector, certificationLimit] of Object.entries(certificationLimits)) {
    if (!relationships[detector]) continue;
    relationships[detector] = {
      ...relationships[detector],
      ...(relationships[detector].certification === 'certified' ? { certification: 'qualified' } : {}),
      certificationLimit,
    };
  }
  return {
    relationships,
    recommendations: summarizeUtilityByDetector(rows, { detectors }),
  };
}

function collectFactualCandidates(db, detector, context) {
  const normalize = (candidate, evidence) =>
    normalizeFactualCandidate(candidate, {
      detector,
      repository: context.repository,
      commit: context.commit,
      evidence,
      capabilityStatus: context.capabilityStatus,
    });

  let rawRows;
  let evidence = 'heuristic';
  if (detector === 'unused-imports') {
    evidence = 'graph-fact';
    rawRows = typescriptSourceFiles(db).flatMap((file) =>
      unusedImports(db, file, { semantic: true }).map((finding) => {
        const line = findSourceLine(context.root, file, finding.shortName);
        return {
          relativePath: file,
          startLine: line,
          symbol: finding.symbol,
          shortName: finding.shortName,
          details: finding,
          sourceExcerpt: sourceExcerpt(context.root, file, line, line),
        };
      }),
    );
  } else if (detector === 'unused-params') {
    rawRows = unusedParams(db, { limit: undefined }).map((finding) => ({
      relativePath: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      symbol: finding.symbol,
      shortName: finding.shortName,
      details: finding,
      sourceExcerpt: sourceExcerpt(context.root, finding.file, finding.startLine, finding.endLine),
    }));
  } else if (detector === 'cycles') {
    evidence = 'graph-fact';
    rawRows = cycleSummary(db, { maxDepth: 100 }).cycles.map((finding) => ({
      relativePath: finding.path[0],
      startLine: 0,
      symbol: finding.path.join(' -> '),
      findingKind: finding.kind,
      details: finding,
      sourceExcerpt: dependencyPathExcerpt(context.root, finding.path),
    }));
  } else if (detector === 'duplicate-bodies') {
    rawRows = duplicateBodies(db, { limit: undefined }).map((finding) => ({
      relativePath: finding.canonical.file,
      startLine: finding.canonical.startLine,
      endLine: finding.canonical.endLine,
      symbol: finding.hash,
      shortName: finding.functions.map((entry) => entry.shortName).join(' = '),
      details: finding,
      sourceExcerpt: finding.functions
        .map(
          (entry) =>
            `${entry.file}:${entry.startLine + 1}-${entry.endLine + 1}\n${sourceExcerpt(
              context.root,
              entry.file,
              entry.startLine,
              entry.endLine,
            )}`,
        )
        .join('\n\n'),
    }));
  } else if (detector === 'complexity') {
    evidence = 'graph-fact';
    const definitions = ['function', 'method', 'constructor']
      .flatMap((kind) => byKind(db, kind, { limit: Number.POSITIVE_INFINITY }))
      .filter((definition) => /\.[cm]?[jt]sx?$/.test(definition.relativePath));
    const frames = definitions.map((definition) => ({
      detector,
      language: 'typescript',
      repository: context.repository,
      relativePath: definition.relativePath,
      symbol: definition.symbol,
      startLine: definition.startLine,
      verdict: null,
    }));
    const selected = deterministicSample(frames, Math.min(context.sampleSize, frames.length), context.seed);
    const measured = selected
      .map((frame) => complexity(db, frame.symbol, { semantic: true }))
      .filter(Boolean)
      .map((finding) =>
        normalize(
          {
            relativePath: finding.relativePath,
            startLine: finding.startLine,
            endLine: finding.endLine,
            symbol: finding.symbol,
            shortName: finding.shortName,
            details: finding,
            sourceExcerpt: sourceExcerpt(context.root, finding.relativePath, finding.startLine, finding.endLine),
          },
          evidence,
        ),
      );
    return { total: definitions.length, rows: measured };
  } else if (detector === 'isolated') {
    evidence = 'graph-fact';
    rawRows = isolated(db, { minLoc: 3, semantic: true }).map((finding) => ({
      relativePath: finding.relativePath,
      startLine: finding.startLine,
      endLine: finding.endLine,
      symbol: finding.symbol,
      shortName: finding.shortName,
      details: finding,
      sourceExcerpt: sourceExcerpt(context.root, finding.relativePath, finding.startLine, finding.endLine),
    }));
  } else if (detector === 'redundant-reexports') {
    evidence = 'graph-fact';
    rawRows = redundantReexports(db).map((finding) => {
      const line = findSourceLine(context.root, finding.barrelFile, leafName(finding.shortName));
      return {
        relativePath: finding.barrelFile,
        startLine: line,
        symbol: finding.symbol,
        shortName: finding.shortName,
        findingKind: finding.actionTier,
        details: finding,
        sourceExcerpt: sourceExcerpt(context.root, finding.barrelFile, Math.max(0, line - 2), line + 2),
      };
    });
  } else if (detector === 'not-implemented') {
    rawRows = notImplemented(db, { limit: undefined, semantic: true }).map((finding) =>
      findingRow(context.root, finding),
    );
  } else if (detector === 'decorative-checkers') {
    rawRows = decorativeCheckers(db, { limit: undefined }).map((finding) => findingRow(context.root, finding));
  } else if (detector === 'test-quality') {
    const report = testQuality(db, { limit: undefined });
    rawRows = [
      ...report.assertionFree.map((finding) => testQualityRow(context.root, finding, 'assertion-free')),
      ...report.skipped.map((finding) => testQualityRow(context.root, finding, 'skipped')),
      ...report.mockEcho.map((finding) => testQualityRow(context.root, finding, 'mock-echo')),
    ];
  } else {
    throw new Error(`unsupported factual detector: ${detector}`);
  }

  const normalized = rawRows.map((candidate) => normalize(candidate, evidence));
  return {
    total: normalized.length,
    rows: deterministicSample(normalized, Math.min(context.sampleSize, normalized.length), context.seed),
  };
}

function collectSimilarityCandidates(db, detector, context) {
  const normalize = (candidate) =>
    normalizeSimilarityCandidate(candidate, {
      detector,
      repository: context.repository,
      commit: context.commit,
      evidence: 'heuristic',
      capabilityStatus: context.capabilityStatus,
    });

  let rawRows;
  let metadata = { exhaustiveCandidateFrame: true };
  if (detector === 'recent-duplicates') {
    const result = recentDuplicates(db, {
      historyMode: 'full',
      limit: Number.POSITIVE_INFINITY,
      semantic: true,
    });
    metadata = {
      ...metadata,
      available: result.available,
      historyWindowCommits: result.windowCommits,
    };
    rawRows = result.findings.map((finding) => {
      const endpoints = [
        definitionEndpoint(db, finding.echoSymbol, finding.echoFile, context.root),
        definitionEndpoint(db, finding.establishedSymbol, finding.establishedFile, context.root),
      ];
      return similarityRow({
        root: context.root,
        endpoints,
        symbol: `${finding.domain}:${finding.echoSymbol}|${finding.establishedSymbol}`,
        shortName: `${finding.echoSymbol} ↔ ${finding.establishedSymbol}`,
        findingKind: `${finding.kind}:${finding.domain}:${finding.basis}`,
        details: finding,
      });
    });
  } else if (detector === 'similar') {
    rawRows = similarAll(db, { limit: Number.POSITIVE_INFINITY, semantic: true }).map((finding) => {
      const endpoints = [
        definitionEndpoint(db, finding.symbolA, finding.fileA, context.root),
        definitionEndpoint(db, finding.symbolB, finding.fileB, context.root),
      ];
      return similarityRow({
        root: context.root,
        endpoints,
        symbol: `${finding.symbolA}|${finding.symbolB}`,
        shortName: `${finding.shortNameA} ↔ ${finding.shortNameB}`,
        findingKind: finding.similarityBasis ?? 'callees',
        details: finding,
      });
    });
  } else if (detector === 'similar-files') {
    rawRows = similarFiles(db, { limit: Number.POSITIVE_INFINITY }).map((finding) => {
      const endpoints = [fileEndpoint(finding.fileA), fileEndpoint(finding.fileB)];
      return similarityRow({
        root: context.root,
        endpoints,
        symbol: `${finding.fileA}|${finding.fileB}`,
        shortName: `${finding.fileA} ↔ ${finding.fileB}`,
        findingKind: 'dependency-profile',
        details: finding,
        sourceExcerpt: dependencyFilesExcerpt(context.root, [finding.fileA, finding.fileB]),
      });
    });
  } else if (detector === 'similar-chains') {
    metadata = {
      exhaustiveCandidateFrame: false,
      frameLimit: '500 generated dependency chains before pair comparison',
    };
    rawRows = similarChains(db, { limit: Number.POSITIVE_INFINITY }).map((finding) => {
      const endpoints = [fileEndpoint(finding.chainA[0]), fileEndpoint(finding.chainB[0])];
      return similarityRow({
        root: context.root,
        endpoints,
        symbol: `${finding.chainA.join('>')}|${finding.chainB.join('>')}`,
        shortName: `${finding.chainA.join(' → ')} ↔ ${finding.chainB.join(' → ')}`,
        findingKind: 'dependency-chain',
        details: finding,
        sourceExcerpt: dependencyFilesExcerpt(context.root, [...finding.chainA, ...finding.chainB]),
      });
    });
  } else if (detector === 'similar-signatures') {
    rawRows = similarSignatures(db, { semantic: true }).map((finding) => {
      const endpoints = finding.functions.map((entry) => ({
        file: entry.file,
        symbol: entry.symbol,
        shortName: entry.shortName,
        startLine: entry.startLine,
        endLine: entry.endLine,
      }));
      return similarityRow({
        root: context.root,
        endpoints,
        symbol: `${finding.signature}|${finding.functions.map((entry) => entry.symbol).join('|')}`,
        shortName: finding.functions.map((entry) => entry.shortName).join(' = '),
        findingKind: finding.exactBody ? 'signature-and-body' : `signature:${finding.locBand}`,
        details: finding,
      });
    });
  } else if (detector === 'twin-drift') {
    rawRows = twinDrift(db).map((finding) => {
      const endpoints = finding.members.map((entry) => ({
        file: entry.file,
        symbol: entry.symbol,
        shortName: entry.shortName,
        startLine: entry.startLine,
        endLine: entry.endLine,
      }));
      return similarityRow({
        root: context.root,
        endpoints,
        symbol: `${finding.leaf}|${finding.members.map((entry) => entry.symbol).join('|')}`,
        shortName: `${finding.leaf}: ${finding.members.map((entry) => entry.shortName).join(' ↔ ')}`,
        findingKind: finding.relationship,
        details: finding,
      });
    });
  } else {
    throw new Error(`unsupported similarity detector: ${detector}`);
  }

  const normalized = rawRows.map(normalize);
  return {
    total: normalized.length,
    rows: deterministicSample(normalized, Math.min(context.sampleSize, normalized.length), context.seed),
    metadata,
  };
}

function collectArchitectureCandidates(db, detector, context) {
  const evidence = detector === 'co-change' ? 'mixed' : 'heuristic';
  const normalize = (candidate) =>
    normalizeSimilarityCandidate(candidate, {
      detector,
      repository: context.repository,
      commit: context.commit,
      evidence,
      capabilityStatus: context.capabilityStatus,
    });

  let rawRows;
  let metadata = { exhaustiveCandidateFrame: true };
  if (detector === 'co-change') {
    const result = coChange(db, undefined, {
      limit: Number.POSITIVE_INFINITY,
      historyMode: 'full',
    });
    metadata = { ...metadata, available: result.available, commitsAnalyzed: result.commitsAnalyzed };
    rawRows = result.findings.map((finding) => {
      const endpoints = [fileEndpoint(finding.fileA), fileEndpoint(finding.fileB)];
      return similarityRow({
        root: context.root,
        endpoints,
        symbol: `${finding.fileA}|${finding.fileB}`,
        shortName: `${finding.fileA} ↔ ${finding.fileB}`,
        findingKind: finding.partnerClass ?? 'co-change',
        details: finding,
        sourceExcerpt: filePreviewExcerpt(context.root, [finding.fileA, finding.fileB]),
      });
    });
  } else if (detector === 'doc-drift') {
    const result = docDrift(db, {
      limit: Number.POSITIVE_INFINITY,
      historyMode: 'full',
    });
    metadata = {
      ...metadata,
      available: result.available,
      commitsAnalyzed: result.commitsAnalyzed,
      docsScanned: result.docsScanned,
      snapshotDocsExcluded: true,
    };
    rawRows = result.findings.flatMap((finding) => [
      ...finding.subjects.map((subject) => {
        const line = docReferenceLine(context.root, finding.doc, subject);
        const endpoints = [
          { ...fileEndpoint(finding.doc), startLine: line, endLine: line },
          fileEndpoint(subject.file),
        ];
        return similarityRow({
          root: context.root,
          endpoints,
          symbol: `${finding.doc}|${subject.file}`,
          shortName: `${finding.doc} ↔ ${subject.file}`,
          findingKind: subject.evidence,
          details: {
            docLastChangedAt: finding.docLastChangedAt,
            docLastChangedAtEstimated: finding.docLastChangedAtEstimated ?? false,
            staleness: finding.staleness,
            snapshotExcluded: finding.snapshotExcluded ?? false,
            subject,
          },
          sourceExcerpt: docDriftExcerpt(context.root, finding.doc, subject, line),
        });
      }),
      ...finding.brokenReferences.map((brokenReference) => {
        const broken = String(brokenReference);
        const line = findSourceLine(context.root, finding.doc, broken);
        return similarityRow({
          root: context.root,
          endpoints: [{ ...fileEndpoint(finding.doc), startLine: line, endLine: line }, fileEndpoint(broken)],
          symbol: `${finding.doc}|broken:${broken}`,
          shortName: `${finding.doc} ↔ missing ${broken}`,
          findingKind: 'broken-reference',
          details: {
            docLastChangedAt: finding.docLastChangedAt,
            docLastChangedAtEstimated: finding.docLastChangedAtEstimated ?? false,
            staleness: finding.staleness,
            brokenReference: broken,
          },
          sourceExcerpt: docDriftExcerpt(context.root, finding.doc, null, line),
        });
      }),
    ]);
  } else if (detector === 'drift') {
    const result = drift(db, {
      includePatternDeviations: true,
      limit: Number.POSITIVE_INFINITY,
      semantic: true,
    });
    rawRows = result.results.map((finding) => {
      const endpoints = [fileEndpoint(finding.file), fileEndpoint(finding.dep)];
      return similarityRow({
        root: context.root,
        endpoints,
        symbol: `${finding.kind}:${finding.file}|${finding.dep}`,
        shortName: `${finding.kind}: ${finding.file} → ${finding.dep}`,
        findingKind: finding.kind,
        details: finding,
        sourceExcerpt: dependencyFilesExcerpt(context.root, [finding.file, finding.dep]),
      });
    });
  } else if (detector === 'wrapper-candidates') {
    rawRows = wrapperCandidates(db, {
      limit: Number.POSITIVE_INFINITY,
      semantic: true,
    }).map((finding) => {
      const endpoints = [definitionEndpoint(db, finding.symbol, finding.file, context.root)];
      if (finding.singleCaller) {
        endpoints.push(definitionEndpoint(db, finding.singleCaller, finding.file, context.root));
      }
      return similarityRow({
        root: context.root,
        endpoints,
        symbol: `${finding.symbol}|${finding.singleCaller}`,
        shortName: `${finding.shortName} → ${finding.singleCallerShort}`,
        findingKind: `single-caller:${finding.actionTier}`,
        details: finding,
      });
    });
  } else if (detector === 'passthrough-candidates') {
    rawRows = passthroughCandidates(db, {
      limit: Number.POSITIVE_INFINITY,
      semantic: true,
    }).map((finding) => {
      const endpoints = [
        definitionEndpoint(db, finding.symbol, finding.file, context.root),
        definitionEndpoint(db, finding.forwardsTo, finding.forwardsToFile, context.root),
      ];
      return similarityRow({
        root: context.root,
        endpoints,
        symbol: `${finding.symbol}|${finding.forwardsTo}`,
        shortName: `${finding.shortName} → ${finding.forwardsToShort}`,
        findingKind: `literal-passthrough:${finding.actionTier}`,
        details: finding,
      });
    });
  } else if (detector === 'stale-abstractions') {
    rawRows = staleAbstractions(db, {
      includeLowConfidence: true,
      limit: Number.POSITIVE_INFINITY,
      semantic: true,
    }).map((finding) =>
      similarityRow({
        root: context.root,
        endpoints: [definitionEndpoint(db, finding.symbol, finding.file, context.root)],
        symbol: finding.symbol,
        shortName: finding.shortName,
        findingKind: finding.stalenessKind,
        details: finding,
      }),
    );
  } else {
    throw new Error(`unsupported architecture detector: ${detector}`);
  }

  const normalized = rawRows.map(normalize);
  metadata = {
    ...metadata,
    subtypeCounts: Object.fromEntries(
      [...new Set(normalized.map((row) => row.findingKind))]
        .sort()
        .map((findingKind) => [findingKind, normalized.filter((row) => row.findingKind === findingKind).length]),
    ),
  };
  return {
    total: normalized.length,
    rows: deterministicStratifiedSample(
      normalized,
      Math.min(context.sampleSize, normalized.length),
      context.seed,
      (row) => row.findingKind,
    ),
    metadata,
  };
}

function similarityRow({ root, endpoints, symbol, shortName, findingKind, details, sourceExcerpt: excerpt }) {
  const primary = endpoints[0] ?? fileEndpoint('');
  return {
    relativePath: primary.file,
    startLine: primary.startLine ?? 0,
    endLine: primary.endLine ?? primary.startLine ?? 0,
    symbol,
    shortName,
    findingKind,
    endpoints,
    details,
    sourceExcerpt: excerpt ?? endpointSourceExcerpts(root, endpoints),
  };
}

function definitionEndpoint(db, symbol, fallbackFile, root) {
  const definition = db.get(
    `SELECT d.relative_path AS file,
            der.start_line AS startLine,
            der.end_line AS endLine
       FROM global_symbols gs
       JOIN defn_enclosing_ranges der ON der.symbol_id = gs.id
       JOIN documents d ON d.id = der.document_id
      WHERE gs.symbol = ?
      ORDER BY d.relative_path, der.start_line
      LIMIT 1`,
    symbol,
  );
  if (definition) {
    return {
      file: definition.file,
      symbol,
      startLine: definition.startLine,
      endLine: definition.endLine ?? definition.startLine,
    };
  }
  const sourceLine = findSourceLine(root, fallbackFile, leafName(symbol));
  return { file: fallbackFile, symbol, startLine: sourceLine, endLine: sourceLine + 80 };
}

function fileEndpoint(file) {
  return { file, symbol: file, startLine: 0, endLine: 0 };
}

function endpointSourceExcerpts(root, endpoints) {
  return endpoints
    .map((endpoint) => {
      const location = `${endpoint.file}:${(endpoint.startLine ?? 0) + 1}-${(endpoint.endLine ?? endpoint.startLine ?? 0) + 1}`;
      return `${location}\n${sourceExcerpt(root, endpoint.file, endpoint.startLine ?? 0, endpoint.endLine ?? 0) ?? '(source unavailable)'}`;
    })
    .join('\n\n');
}

function dependencyFilesExcerpt(root, files) {
  return [...new Set(files)]
    .map((relativePath) => {
      const absolutePath = join(root, relativePath);
      if (!existsSync(absolutePath)) return `${relativePath}\n(source unavailable)`;
      const lines = readFileSync(absolutePath, 'utf8').split('\n');
      const dependencies = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /\b(import|export)\b|\brequire\s*\(/.test(line))
        .slice(0, 60)
        .map(({ line, index }) => `${String(index + 1).padStart(5)} | ${line}`)
        .join('\n');
      return `${relativePath}\n${dependencies || '(no textual dependency lines)'}`;
    })
    .join('\n\n');
}

function filePreviewExcerpt(root, files) {
  return [...new Set(files)]
    .map((relativePath) => {
      const excerpt = sourceExcerpt(root, relativePath, 0, 40);
      return `${relativePath}:1-41\n${excerpt ?? '(source unavailable)'}`;
    })
    .join('\n\n');
}

function docReferenceLine(root, doc, subject) {
  const contexts = subject?.citationContexts ?? [];
  const needles = [subject?.file, ...contexts]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .map((value) => String(value).split('\n')[0].slice(0, 120));
  for (const needle of needles) {
    const line = findSourceLine(root, doc, needle);
    if (line > 0) return line;
  }
  return 0;
}

function docDriftExcerpt(root, doc, subject, line) {
  const contexts = subject?.citationContexts ?? [];
  const contextText = contexts.length > 0 ? `\n\nResolved citation contexts:\n${contexts.join('\n---\n')}` : '';
  const targetText =
    subject && existsSync(join(root, subject.file))
      ? `\n\n${subject.file}:1-41\n${sourceExcerpt(root, subject.file, 0, 40)}`
      : '';
  return `${doc}:${line + 1}-${line + 12}\n${sourceExcerpt(root, doc, Math.max(0, line - 3), line + 8)}${contextText}${targetText}`;
}

function typescriptSourceFiles(db) {
  return db
    .all(
      `SELECT relative_path AS relativePath
       FROM documents
       WHERE relative_path IS NOT NULL
       ORDER BY relative_path`,
    )
    .map((row) => row.relativePath)
    .filter((relativePath) => /\.[cm]?[jt]sx?$/.test(relativePath))
    .filter((relativePath) => !db.isIgnored(relativePath));
}

function findingRow(root, finding) {
  return {
    relativePath: finding.file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    symbol: finding.symbol,
    shortName: finding.shortName,
    findingKind: finding.stubKind ?? finding.nameKind,
    details: finding,
    sourceExcerpt: sourceExcerpt(root, finding.file, finding.startLine, finding.endLine),
  };
}

function testQualityRow(root, finding, findingKind) {
  return {
    relativePath: finding.file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    symbol: `${findingKind}:${finding.file}:${finding.startLine}:${finding.title}`,
    shortName: finding.title || findingKind,
    findingKind,
    details: finding,
    sourceExcerpt: sourceExcerpt(root, finding.file, finding.startLine, finding.endLine),
  };
}

function findSourceLine(root, relativePath, needle) {
  const path = join(root, relativePath);
  if (!existsSync(path)) return 0;
  const lines = readFileSync(path, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.includes(needle));
  return index < 0 ? 0 : index;
}

function leafName(shortName) {
  return String(shortName).replace(/\(\)$/, '').split(':').at(-1)?.replace(/^<|>$/g, '') ?? String(shortName);
}

function dependencyPathExcerpt(root, path) {
  return [...new Set(path.slice(0, -1))]
    .map((relativePath) => {
      const absolutePath = join(root, relativePath);
      if (!existsSync(absolutePath)) return `${relativePath}\n(source unavailable)`;
      const lines = readFileSync(absolutePath, 'utf8').split('\n');
      const imports = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /\b(import|export)\b|\brequire\s*\(/.test(line))
        .slice(0, 40)
        .map(({ line, index }) => `${String(index + 1).padStart(5)} | ${line}`)
        .join('\n');
      return `${relativePath}\n${imports || '(no textual dependency lines)'}`;
    })
    .join('\n\n');
}

function renderFactualPacket(packet) {
  const lines = [
    '# TypeScript Factual Detector Calibration Packet',
    '',
    `Generated: ${packet.generatedAt}`,
    `Schema: ${packet.schemaVersion}`,
    `Seed: \`${packet.seed}\``,
    '',
    '## Truth Rules',
    '',
  ];
  for (const detector of packet.detectors) lines.push(`- **${detector}:** ${packet.truthRules[detector]}`);
  lines.push('', '## Repository Inventory', '');
  for (const repository of packet.repositories) {
    lines.push(
      `### ${repository.repository}`,
      '',
      `- Commit: \`${repository.commit ?? '-'}\``,
      `- Candidate counts: \`${JSON.stringify(repository.candidateCounts ?? {})}\``,
      `- Sampled counts: \`${JSON.stringify(repository.sampledCounts ?? {})}\``,
      `- Error: ${repository.error ?? '-'}`,
      '',
    );
  }
  lines.push('## Current Summary', '', '```json', JSON.stringify(packet.summary, null, 2), '```', '');
  for (const [index, row] of packet.rows.entries()) {
    lines.push(
      `## ${index + 1}. ${row.detector}: ${row.repository}: ${row.shortName}`,
      '',
      `- Calibration ID: \`${row.calibrationId}\``,
      `- Commit: \`${row.commit}\``,
      `- Location: \`${row.relativePath}:${row.startLine + 1}-${row.endLine + 1}\``,
      `- Evidence: ${row.evidence}`,
      `- Kind: ${row.findingKind}`,
      `- Verdict: **${row.verdict?.toUpperCase() ?? 'PENDING'}**`,
      `- Noise archetype: ${row.noiseArchetype ?? '-'}`,
      `- Evidence note: ${row.evidenceNote ?? '-'}`,
      `- Details: \`${JSON.stringify(row.details)}\``,
      '',
      '````text',
      row.sourceExcerpt ?? '(source unavailable)',
      '````',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

function renderSimilarityPacket(packet) {
  return renderRelationshipPacket(packet, 'TypeScript Similarity Detector Calibration Packet');
}

function renderArchitecturePacket(packet) {
  return renderRelationshipPacket(packet, 'TypeScript Architecture and History Detector Calibration Packet');
}

function renderRelationshipPacketForType(packet) {
  return packet.detector === 'typescript-architecture'
    ? renderArchitecturePacket(packet)
    : renderSimilarityPacket(packet);
}

function isRelationshipPacket(packet) {
  return packet.detector === 'typescript-similarity' || packet.detector === 'typescript-architecture';
}

function renderRelationshipPacket(packet, title) {
  const lines = [
    `# ${title}`,
    '',
    `Generated: ${packet.generatedAt}`,
    `Schema: ${packet.schemaVersion}`,
    `Seed: \`${packet.seed}\``,
    '',
    'Relationship verdicts certify the disclosed measurement. Utility verdicts classify whether the emitted action is useful for the reviewed relationship; they do not alter relationship precision.',
    '',
    '## Truth Rules',
    '',
  ];
  for (const detector of packet.detectors) lines.push(`- **${detector}:** ${packet.truthRules[detector]}`);
  lines.push('', '## Repository Inventory', '');
  for (const repository of packet.repositories) {
    lines.push(
      `### ${repository.repository}`,
      '',
      `- Commit: \`${repository.commit ?? '-'}\``,
      `- Candidate counts: \`${JSON.stringify(repository.candidateCounts ?? {})}\``,
      `- Sampled counts: \`${JSON.stringify(repository.sampledCounts ?? {})}\``,
      `- Detector metadata: \`${JSON.stringify(repository.detectorMetadata ?? {})}\``,
      `- Error: ${repository.error ?? '-'}`,
      '',
    );
  }
  lines.push('## Current Summary', '', '```json', JSON.stringify(packet.summary, null, 2), '```', '');
  for (const [index, row] of packet.rows.entries()) {
    lines.push(
      `## ${index + 1}. ${row.detector}: ${row.repository}: ${row.shortName}`,
      '',
      `- Calibration ID: \`${row.calibrationId}\``,
      `- Commit: \`${row.commit}\``,
      `- Primary location: \`${row.relativePath}:${row.startLine + 1}-${row.endLine + 1}\``,
      `- Endpoints: \`${JSON.stringify(row.endpoints)}\``,
      `- Evidence: ${row.evidence}`,
      `- Kind: ${row.findingKind}`,
      `- Relationship verdict: **${row.verdict?.toUpperCase() ?? 'PENDING'}**`,
      `- Relationship noise archetype: ${row.noiseArchetype ?? '-'}`,
      `- Relationship evidence note: ${row.evidenceNote ?? '-'}`,
      `- Recommendation utility: **${row.utilityVerdict?.toUpperCase() ?? 'PENDING'}**`,
      `- Utility archetype: ${row.utilityArchetype ?? '-'}`,
      `- Utility evidence note: ${row.utilityNote ?? '-'}`,
      `- Details: \`${JSON.stringify(row.details)}\``,
      '',
      '````text',
      row.sourceExcerpt ?? '(source unavailable)',
      '````',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

function runNavigationMode(rawRoots) {
  const requestedRoots = rawRoots.map((entry) => resolve(entry));
  const cases =
    requestedRoots.length > 0
      ? navigationCases.filter((testCase) => requestedRoots.includes(resolve(testCase.projectRoot)))
      : navigationCases;
  const outPath = join(outDir, `${runId}-generated-real-repo-calibration.md`);
  const sections = [
    '# Accuracy Calibration',
    '',
    `Date: ${stamp}`,
    '',
    'This report records source-backed real-repository checks. A PASS means the command output was compared against source text and expected graph facts, not merely that the command exited successfully.',
    '',
  ];

  let failures = 0;
  let skipped = 0;
  for (const testCase of cases) {
    const projectRoot = resolve(testCase.projectRoot);
    sections.push(`## ${basename(projectRoot)}`, '', `Path: \`${projectRoot}\``, '');
    if (!existsSync(projectRoot)) {
      skipped += 1;
      sections.push('SKIP: repository is not present on this machine.', '');
      continue;
    }

    const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-calibrate-'));
    try {
      const checks = runNavigationCase(testCase, projectRoot, cacheDir);
      for (const check of checks) {
        if (!check.pass) failures += 1;
        sections.push(`- ${check.pass ? 'PASS' : 'FAIL'} ${check.name}`);
        if (check.evidence) sections.push('', '```text', check.evidence.trimEnd(), '```');
      }
      sections.push('');
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  }

  sections.push(
    `Summary: ${failures === 0 ? 'PASS' : 'FAIL'} (${failures} failure(s), ${skipped} skipped repo(s))`,
    '',
  );
  writeFileSync(outPath, sections.join('\n'));
  console.log(outPath);
  if (failures > 0) process.exitCode = 1;
}

function runHealthDeadMode(rawArgs) {
  const options = parseHealthDeadArgs(rawArgs);
  const rows = [];
  const repositories = [];
  let failures = 0;

  for (const sourceRoot of options.roots) {
    const repository = basename(sourceRoot);
    if (!existsSync(join(sourceRoot, '.git'))) {
      failures += 1;
      repositories.push({ repository, sourceRoot, error: 'repository is missing or is not a Git checkout' });
      continue;
    }

    const isolated = createDetachedWorktree(sourceRoot);
    const cacheDir = mkdtempSync(join(tmpdir(), 'scip-query-health-calibrate-'));
    try {
      const env = {
        ...process.env,
        SCIP_QUERY_PROJECT_ROOT: isolated.root,
        SCIP_QUERY_CACHE_DIR: cacheDir,
        SCIP_QUERY_SKIP_WATCH_SERVICE: '1',
      };
      const reindex = runCli(['reindex', '--force', '--language', options.language], isolated.root, env, 600_000);
      if (reindex.status !== 0) {
        failures += 1;
        repositories.push({
          repository,
          sourceRoot,
          commit: isolated.commit,
          error: commandError('reindex', reindex),
        });
        continue;
      }

      const status = runCli(['status', '--capabilities', '--json'], isolated.root, env, 60_000);
      const dead = runCli(['dead', '--full', '--json'], isolated.root, env, 600_000);
      if (status.status !== 0 || dead.status !== 0) {
        failures += 1;
        repositories.push({
          repository,
          sourceRoot,
          commit: isolated.commit,
          reindexDurationMs: reindex.durationMs,
          error: status.status !== 0 ? commandError('status', status) : commandError('dead', dead),
        });
        continue;
      }

      const statusEnvelope = parseEnvelope(status.stdout, 'status');
      const deadEnvelope = parseEnvelope(dead.stdout, 'dead');
      const capability = statusEnvelope.result.capabilities?.matrix?.find(
        (entry) => entry.language === options.language,
      );
      const candidates = (deadEnvelope.result.symbols ?? []).filter((candidate) => candidate.kind === 'dead-code');
      const normalized = candidates.map((candidate) =>
        normalizeDeadCandidate(candidate, {
          language: options.language,
          repository,
          commit: isolated.commit,
          evidence: deadEnvelope.evidence,
          capabilityStatus: capability ?? null,
          sourceExcerpt: (entry) => sourceExcerpt(isolated.root, entry.relativePath, entry.startLine, entry.endLine),
        }),
      );
      const sampled = deterministicSample(
        normalized,
        Math.min(options.sampleSize, normalized.length),
        `${options.seed}:${repository}`,
      );
      rows.push(...sampled);
      repositories.push({
        repository,
        sourceRoot,
        commit: isolated.commit,
        language: options.language,
        capability: capability ?? null,
        reindexDurationMs: reindex.durationMs,
        deadDurationMs: dead.durationMs,
        totalDeadCandidates: candidates.length,
        sampled: sampled.length,
      });
    } catch (error) {
      failures += 1;
      repositories.push({ repository, sourceRoot, commit: isolated.commit, error: errorMessage(error) });
    } finally {
      isolated.remove();
      rmSync(cacheDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  const packet = {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    detector: 'dead',
    language: options.language,
    truthRule: deadTruthRules[options.language],
    seed: options.seed,
    sampleSizePerRepository: options.sampleSize,
    repositories,
    rows,
    summary: summarizeCalibration(rows),
  };
  const baseName = `${runId}-${options.language}-dead-calibration`;
  const jsonPath = join(outDir, `${baseName}.json`);
  const markdownPath = join(outDir, `${baseName}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(packet, null, 2)}\n`);
  writeFileSync(markdownPath, renderDeadPacket(packet));
  console.log(jsonPath);
  console.log(markdownPath);
  if (failures > 0) process.exitCode = 1;
}

function parseHealthDeadArgs(rawArgs) {
  return parseDeadCalibrationOptions(rawArgs, defaultDeadReposByLanguage, resolve);
}

function createDetachedWorktree(sourceRoot) {
  const root = mkdtempSync(join(tmpdir(), `scip-query-${basename(sourceRoot)}-`));
  const add = runProcess('git', ['worktree', 'add', '--detach', root, 'HEAD'], sourceRoot, 120_000);
  if (add.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(commandError('git worktree add', add));
  }
  const commit = runProcess('git', ['rev-parse', 'HEAD'], root, 30_000).stdout.trim();
  const sourceNodeModules = join(sourceRoot, 'node_modules');
  const worktreeNodeModules = join(root, 'node_modules');
  if (existsSync(sourceNodeModules) && !existsSync(worktreeNodeModules)) {
    symlinkSync(sourceNodeModules, worktreeNodeModules, 'dir');
  }
  return {
    root,
    commit,
    remove() {
      const removed = runProcess('git', ['worktree', 'remove', '--force', root], sourceRoot, 120_000);
      if (removed.status !== 0) rmSync(root, { recursive: true, force: true });
    },
  };
}

function runNavigationCase(testCase, projectRoot, cacheDir) {
  const checks = [];
  const env = { ...process.env, SCIP_QUERY_PROJECT_ROOT: projectRoot, SCIP_QUERY_CACHE_DIR: cacheDir };
  env.SCIP_QUERY_SKIP_WATCH_SERVICE = '1';
  const reindex = runCli(['reindex', '--force', '--language', testCase.language], projectRoot, env, 180_000);
  checks.push(checkExit('reindex', reindex));
  if (reindex.status !== 0) return checks;
  checks.push(performanceMetadata(cacheDir, { reindex }));

  const source = readFileSync(join(projectRoot, testCase.file), 'utf8');
  checks.push(assertIncludes('source oracle', source, testCase.sourceIncludes));
  const commands = {
    symbols: runCli(['symbols', testCase.file], projectRoot, env, 60_000),
    code: runCli(['code', testCase.symbol], projectRoot, env, 60_000),
    refs: runCli(['refs', testCase.symbol], projectRoot, env, 60_000),
    trace: runCli(['trace', testCase.symbol], projectRoot, env, 60_000),
    callGraph: runCli(['call-graph', testCase.symbol], projectRoot, env, 60_000),
    complexity: runCli(['complexity', testCase.symbol], projectRoot, env, 60_000),
    dataflow: runCli(['dataflow', testCase.symbol], projectRoot, env, 60_000),
    slice: runCli(['slice', testCase.symbol, ...(testCase.sliceArgs ?? [])], projectRoot, env, 60_000),
  };
  for (const [name, result] of Object.entries(commands)) checks.push(checkExit(name, result));
  checks.push(assertIncludes('symbols output', commands.symbols.stdout, [testCase.symbol]));
  checks.push(assertIncludes('code output', commands.code.stdout, testCase.sourceIncludes));
  checks.push(assertIncludes('refs output', commands.refs.stdout, testCase.expectedRefs));
  checks.push(assertIncludes('trace output', commands.trace.stdout, ['═══ DEFINITION ═══', testCase.file]));
  checks.push(assertIncludes('call-graph output', commands.callGraph.stdout, testCase.expectedCallGraph));
  checks.push(assertIncludes('complexity output', commands.complexity.stdout, ['Cyclomatic', 'Fan-in', 'Fan-out']));
  checks.push(assertIncludes('dataflow output', commands.dataflow.stdout, testCase.expectedDataflow));
  checks.push(assertIncludes('slice output', commands.slice.stdout, testCase.expectedSlice));
  checks.push(commandDurations(commands));
  return checks;
}

function runCli(args, cwd, env, timeout) {
  const startMs = Date.now();
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    maxBuffer: 64 * 1024 * 1024,
  });
  return processResult(result, startMs);
}

function runProcess(command, args, cwd, timeout) {
  const startMs = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  return processResult(result, startMs);
}

function processResult(result, startMs) {
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? '',
    durationMs: Date.now() - startMs,
  };
}

function parseEnvelope(text, command) {
  try {
    const envelope = JSON.parse(text);
    if (!envelope || envelope.command !== command || typeof envelope.result !== 'object') {
      throw new Error(`unexpected ${command} envelope`);
    }
    return envelope;
  } catch (error) {
    throw new Error(`could not parse ${command} JSON: ${errorMessage(error)}`);
  }
}

function sourceExcerpt(projectRoot, relativePath, startLine, endLine) {
  const path = join(projectRoot, relativePath);
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, 'utf8').split('\n');
  const from = Math.max(0, startLine - 3);
  const to = Math.min(lines.length, Math.max(endLine + 2, startLine + 4));
  return lines
    .slice(from, to)
    .map((line, index) => `${String(from + index + 1).padStart(5)} | ${line}`)
    .join('\n');
}

function renderDeadPacket(packet) {
  const languageLabel = packet.language === 'rust' ? 'Rust' : 'TypeScript';
  const lines = [
    `# ${languageLabel} Dead-Code Calibration Packet`,
    '',
    `Generated: ${packet.generatedAt}`,
    `Schema: ${packet.schemaVersion}`,
    `Seed: \`${packet.seed}\``,
    '',
    'Truth rule:',
    '',
    `> ${packet.truthRule}`,
    '',
    '## Repository Inventory',
    '',
    `| Repository | Commit | Candidates | Sampled | ${languageLabel} semantic | Error |`,
    '| --- | --- | ---: | ---: | --- | --- |',
  ];
  for (const repo of packet.repositories) {
    lines.push(
      `| ${repo.repository} | ${repo.commit ?? '-'} | ${repo.totalDeadCandidates ?? '-'} | ${repo.sampled ?? '-'} | ${repo.capability?.semantic?.status ?? '-'} | ${escapeTable(repo.error ?? '')} |`,
    );
  }
  lines.push('', '## Current Summary', '', '```json', JSON.stringify(packet.summary, null, 2), '```', '');
  for (const [index, row] of packet.rows.entries()) {
    lines.push(
      `## ${index + 1}. ${row.repository}: ${row.shortName}`,
      '',
      `- Calibration ID: \`${row.calibrationId}\``,
      `- Commit: \`${row.commit}\``,
      `- Location: \`${row.relativePath}:${row.startLine + 1}-${row.endLine + 1}\``,
      `- Evidence: ${row.evidence}`,
      `- Implicit usage: ${row.implicitUsageReason ?? '-'}`,
      `- Verdict: **${row.verdict?.toUpperCase() ?? 'PENDING'}**`,
      `- Noise archetype: ${row.noiseArchetype ?? '-'}`,
      `- Evidence note: ${row.evidenceNote ?? '-'}`,
      '',
      '````text',
      row.sourceExcerpt ?? '(source unavailable)',
      '````',
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

function escapeTable(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
}

function checkExit(name, result) {
  return { name, pass: result.status === 0, evidence: result.status === 0 ? '' : commandError(name, result) };
}

function commandError(name, result) {
  return `${name} failed (${result.status}):\n${result.stdout}${result.stderr}${result.error}`.trim();
}

function performanceMetadata(cacheDir, commands) {
  return {
    name: 'performance metadata',
    pass: true,
    evidence: [
      `reindex duration: ${commands.reindex.durationMs}ms`,
      `index.scip: ${formatBytes(fileSize(join(cacheDir, 'index.scip')))}`,
      `index.db: ${formatBytes(fileSize(join(cacheDir, 'index.db')))}`,
    ].join('\n'),
  };
}

function commandDurations(commands) {
  return {
    name: 'command durations',
    pass: true,
    evidence: Object.entries(commands)
      .map(([name, result]) => `${name}: ${result.durationMs}ms`)
      .join('\n'),
  };
}

function fileSize(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function assertIncludes(name, text, expectedValues) {
  const missing = expectedValues.filter((value) => !text.includes(value));
  return {
    name,
    pass: missing.length === 0,
    evidence: missing.length === 0 ? '' : `Missing: ${missing.join(', ')}\n\nOutput:\n${text.slice(0, 2_000)}`,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
