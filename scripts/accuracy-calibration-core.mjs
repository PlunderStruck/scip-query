import { createHash } from 'node:crypto';

export const CALIBRATION_SCHEMA_VERSION = 1;
export const DEAD_CALIBRATION_LANGUAGES = ['typescript', 'rust'];
export const TYPESCRIPT_FACTUAL_DETECTORS = [
  'unused-imports',
  'unused-params',
  'cycles',
  'duplicate-bodies',
  'complexity',
  'isolated',
  'redundant-reexports',
  'not-implemented',
  'decorative-checkers',
  'test-quality',
];
export const TYPESCRIPT_SIMILARITY_DETECTORS = [
  'recent-duplicates',
  'similar',
  'similar-files',
  'similar-chains',
  'similar-signatures',
  'twin-drift',
];
export const TYPESCRIPT_ARCHITECTURE_DETECTORS = [
  'co-change',
  'doc-drift',
  'drift',
  'wrapper-candidates',
  'passthrough-candidates',
  'stale-abstractions',
];
export const TYPESCRIPT_GRAPH_RISK_DETECTORS = [
  'extract-candidates',
  'locality-candidates',
  'coupling',
  'bottlenecks',
  'deep-chains',
  'complexity-hotspots',
  'hotspots',
  'fan-in',
  'fan-out',
];
export const TYPESCRIPT_FRAMEWORK_DETECTORS = [
  'react-component-duplicates',
  'react-hook-candidates',
  'react-large-component-pressure',
  'vue-component-duplicates',
  'vue-composable-candidates',
  'vue-large-view-pressure',
];

export function parseFrameworkCalibrationOptions(rawArgs, defaultRoots, resolveRoot = (value) => value) {
  return parseTypeScriptDetectorOptions(rawArgs, {
    defaultRoots,
    detectors: TYPESCRIPT_FRAMEWORK_DETECTORS,
    optionLabel: 'framework',
    resolveRoot,
    seed: 'typescript-framework-v1',
  });
}

export function parseGraphRiskCalibrationOptions(rawArgs, defaultRoots, resolveRoot = (value) => value) {
  return parseTypeScriptDetectorOptions(rawArgs, {
    defaultRoots,
    detectors: TYPESCRIPT_GRAPH_RISK_DETECTORS,
    optionLabel: 'graph-risk',
    resolveRoot,
    seed: 'typescript-graph-risk-v1',
  });
}

export function parseArchitectureCalibrationOptions(rawArgs, defaultRoots, resolveRoot = (value) => value) {
  return parseTypeScriptDetectorOptions(rawArgs, {
    defaultRoots,
    detectors: TYPESCRIPT_ARCHITECTURE_DETECTORS,
    optionLabel: 'architecture',
    resolveRoot,
    seed: 'typescript-architecture-v1',
  });
}

export function parseSimilarityCalibrationOptions(rawArgs, defaultRoots, resolveRoot = (value) => value) {
  return parseTypeScriptDetectorOptions(rawArgs, {
    defaultRoots,
    detectors: TYPESCRIPT_SIMILARITY_DETECTORS,
    optionLabel: 'similarity',
    resolveRoot,
    seed: 'typescript-similarity-v1',
  });
}

export function parseFactualCalibrationOptions(rawArgs, defaultRoots, resolveRoot = (value) => value) {
  return parseTypeScriptDetectorOptions(rawArgs, {
    defaultRoots,
    detectors: TYPESCRIPT_FACTUAL_DETECTORS,
    optionLabel: 'factual',
    resolveRoot,
    seed: 'typescript-factual-v1',
  });
}

function parseTypeScriptDetectorOptions(
  rawArgs,
  { defaultRoots, detectors: availableDetectors, optionLabel, resolveRoot, seed: defaultSeed },
) {
  let sampleSize = 10;
  let seed = defaultSeed;
  const roots = [];
  const detectors = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--sample-size') {
      const value = Number(rawArgs[index + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--sample-size must be a positive integer');
      sampleSize = value;
      index += 1;
    } else if (arg === '--seed') {
      const value = rawArgs[index + 1];
      if (!value) throw new Error('--seed requires a value');
      seed = value;
      index += 1;
    } else if (arg === '--detector') {
      const value = rawArgs[index + 1];
      if (!availableDetectors.includes(value)) {
        throw new Error(`--detector must be one of: ${availableDetectors.join(', ')}`);
      }
      detectors.push(value);
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown ${optionLabel} option: ${arg}`);
    } else {
      roots.push(resolveRoot(arg));
    }
  }

  return {
    language: 'typescript',
    sampleSize,
    seed,
    detectors: detectors.length > 0 ? [...new Set(detectors)] : [...availableDetectors],
    roots: (roots.length > 0 ? roots : defaultRoots).map((root) => resolveRoot(root)),
  };
}

export function parseDeadCalibrationOptions(rawArgs, defaultRootsByLanguage, resolveRoot = (value) => value) {
  let language = 'typescript';
  let sampleSize = 25;
  let seed = null;
  const roots = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === '--language') {
      const value = rawArgs[index + 1];
      if (!DEAD_CALIBRATION_LANGUAGES.includes(value)) {
        throw new Error(`--language must be one of: ${DEAD_CALIBRATION_LANGUAGES.join(', ')}`);
      }
      language = value;
      index += 1;
    } else if (arg === '--sample-size') {
      const value = Number(rawArgs[index + 1]);
      if (!Number.isInteger(value) || value < 1) throw new Error('--sample-size must be a positive integer');
      sampleSize = value;
      index += 1;
    } else if (arg === '--seed') {
      const value = rawArgs[index + 1];
      if (!value) throw new Error('--seed requires a value');
      seed = value;
      index += 1;
    } else if (arg.startsWith('-')) {
      throw new Error(`unknown health-dead option: ${arg}`);
    } else {
      roots.push(resolveRoot(arg));
    }
  }

  const selectedRoots = roots.length > 0 ? roots : defaultRootsByLanguage[language];
  if (!Array.isArray(selectedRoots) || selectedRoots.length === 0) {
    throw new Error(`no default calibration repositories configured for ${language}`);
  }
  return {
    language,
    sampleSize,
    seed: seed ?? `${language}-dead-v1`,
    roots: [...selectedRoots],
  };
}

export function calibrationRowIdentity(row) {
  const raw = [
    row.detector,
    row.language,
    row.repository,
    row.relativePath,
    row.symbol,
    row.startLine,
    row.findingId ?? '',
  ].join('\0');
  return createHash('sha256').update(raw).digest('hex').slice(0, 20);
}

export function deterministicSample(rows, count, seed) {
  if (!Number.isInteger(count) || count < 0) throw new Error('sample count must be a non-negative integer');
  return rows
    .map((row) => ({ row, identity: calibrationRowIdentity(row) }))
    .sort((left, right) => {
      const leftRank = sampleRank(seed, left.identity);
      const rightRank = sampleRank(seed, right.identity);
      return leftRank.localeCompare(rightRank) || left.identity.localeCompare(right.identity);
    })
    .slice(0, count)
    .map(({ row, identity }) => ({ ...row, calibrationId: identity }));
}

export function deterministicStratifiedSample(rows, count, seed, stratumForRow) {
  if (!Number.isInteger(count) || count < 0) throw new Error('sample count must be a non-negative integer');
  if (typeof stratumForRow !== 'function') throw new Error('stratumForRow must be a function');

  const grouped = new Map();
  for (const row of rows) {
    const stratum = String(stratumForRow(row));
    const group = grouped.get(stratum) ?? [];
    group.push(row);
    grouped.set(stratum, group);
  }

  const strata = [...grouped.entries()]
    .map(([stratum, entries]) => ({
      stratum,
      rows: deterministicSample(entries, entries.length, `${seed}:${stratum}`),
    }))
    .sort(
      (left, right) =>
        sampleRank(seed, left.stratum).localeCompare(sampleRank(seed, right.stratum)) ||
        left.stratum.localeCompare(right.stratum),
    );

  const selected = [];
  for (let depth = 0; selected.length < Math.min(count, rows.length); depth += 1) {
    let foundAtDepth = false;
    for (const stratum of strata) {
      const candidate = stratum.rows[depth];
      if (!candidate) continue;
      foundAtDepth = true;
      selected.push(candidate);
      if (selected.length >= count) break;
    }
    if (!foundAtDepth) break;
  }
  return selected;
}

export function wilsonInterval(successes, total, z = 1.96) {
  if (!Number.isInteger(successes) || !Number.isInteger(total) || successes < 0 || total < 0 || successes > total) {
    throw new Error('successes and total must be non-negative integers with successes <= total');
  }
  if (total === 0) return { lower: null, upper: null };
  const proportion = successes / total;
  const zSquared = z * z;
  const denominator = 1 + zSquared / total;
  const center = proportion + zSquared / (2 * total);
  const margin = z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * total)) / total);
  return {
    lower: (center - margin) / denominator,
    upper: (center + margin) / denominator,
  };
}

export function summarizeCalibration(
  rows,
  { minimumReviewed = 30, minimumRepositories = 3, knownPositiveRecallCases = 0, unsupported = false } = {},
) {
  const valid = rows.filter((row) => row.verdict === 'valid').length;
  const invalid = rows.filter((row) => row.verdict === 'invalid').length;
  const uncertain = rows.filter((row) => row.verdict === 'uncertain').length;
  const pending = rows.length - valid - invalid - uncertain;
  const reviewed = valid + invalid;
  const observedPrecision = reviewed > 0 ? valid / reviewed : null;
  const interval = wilsonInterval(valid, reviewed);
  const repositoryCount = new Set(
    rows.filter((row) => row.verdict === 'valid' || row.verdict === 'invalid').map((row) => row.repository),
  ).size;

  let certification;
  if (unsupported) {
    certification = 'unsupported';
  } else if (reviewed < minimumReviewed || repositoryCount < minimumRepositories) {
    certification = 'insufficient-evidence';
  } else if (
    observedPrecision !== null &&
    observedPrecision >= 0.95 &&
    interval.lower !== null &&
    interval.lower >= 0.9 &&
    knownPositiveRecallCases > 0
  ) {
    certification = 'certified';
  } else if (observedPrecision !== null && observedPrecision >= 0.9) {
    certification = 'qualified';
  } else {
    certification = 'experimental';
  }

  return {
    rows: rows.length,
    reviewed,
    valid,
    invalid,
    uncertain,
    pending,
    repositoryCount,
    knownPositiveRecallCases,
    observedPrecision,
    confidence95: interval,
    certification,
  };
}

export function normalizeDeadCandidate(candidate, context) {
  const row = {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    detector: 'dead',
    language: context.language,
    repository: context.repository,
    commit: context.commit,
    evidence: context.evidence,
    capabilityStatus: context.capabilityStatus,
    relativePath: candidate.relativePath,
    startLine: candidate.startLine,
    endLine: candidate.endLine,
    loc: candidate.loc,
    symbol: candidate.symbol,
    shortName: candidate.shortName,
    findingKind: candidate.kind,
    sameFileRefs: candidate.sameFileRefs,
    ...(candidate.implicitUsageReason ? { implicitUsageReason: candidate.implicitUsageReason } : {}),
    sourceExcerpt: context.sourceExcerpt(candidate),
    verdict: null,
    noiseArchetype: null,
    evidenceNote: null,
  };
  return { ...row, calibrationId: calibrationRowIdentity(row) };
}

export function normalizeFactualCandidate(candidate, context) {
  const row = {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    detector: context.detector,
    language: 'typescript',
    repository: context.repository,
    commit: context.commit,
    evidence: context.evidence,
    capabilityStatus: context.capabilityStatus,
    relativePath: candidate.relativePath,
    startLine: candidate.startLine ?? 0,
    endLine: candidate.endLine ?? candidate.startLine ?? 0,
    symbol: candidate.symbol,
    shortName: candidate.shortName ?? candidate.symbol,
    findingKind: candidate.findingKind ?? context.detector,
    details: candidate.details ?? null,
    sourceExcerpt: candidate.sourceExcerpt ?? null,
    verdict: null,
    noiseArchetype: null,
    evidenceNote: null,
  };
  return { ...row, calibrationId: calibrationRowIdentity(row) };
}

export function normalizeSimilarityCandidate(candidate, context) {
  const row = {
    schemaVersion: CALIBRATION_SCHEMA_VERSION,
    detector: context.detector,
    language: 'typescript',
    repository: context.repository,
    commit: context.commit,
    evidence: context.evidence,
    capabilityStatus: context.capabilityStatus,
    relativePath: candidate.relativePath,
    startLine: candidate.startLine ?? 0,
    endLine: candidate.endLine ?? candidate.startLine ?? 0,
    symbol: candidate.symbol,
    shortName: candidate.shortName ?? candidate.symbol,
    findingKind: candidate.findingKind ?? context.detector,
    endpoints: candidate.endpoints ?? [],
    details: candidate.details ?? null,
    sourceExcerpt: candidate.sourceExcerpt ?? null,
    verdict: null,
    noiseArchetype: null,
    evidenceNote: null,
    utilityVerdict: null,
    utilityArchetype: null,
    utilityNote: null,
  };
  return { ...row, calibrationId: calibrationRowIdentity(row) };
}

export function summarizeCalibrationByDetector(
  rows,
  { detectors: declaredDetectors = [], knownPositiveRecallCases = {}, unsupportedDetectors = [] } = {},
) {
  const detectors = [...new Set([...declaredDetectors, ...rows.map((row) => row.detector)])].sort();
  for (const detector of unsupportedDetectors) {
    if (!detectors.includes(detector)) detectors.push(detector);
  }
  return Object.fromEntries(
    detectors.sort().map((detector) => [
      detector,
      summarizeCalibration(
        rows.filter((row) => row.detector === detector),
        {
          knownPositiveRecallCases: knownPositiveRecallCases[detector] ?? 0,
          unsupported: unsupportedDetectors.includes(detector),
        },
      ),
    ]),
  );
}

export function applyVerdictGroups(rows, groups) {
  const byId = new Map(rows.map((row) => [row.calibrationId, row]));
  const assigned = new Set();
  for (const group of groups) {
    if (!['valid', 'invalid', 'uncertain'].includes(group.verdict)) {
      throw new Error(`unknown calibration verdict: ${group.verdict}`);
    }
    for (const id of calibrationGroupIds(rows, group, 'verdict')) {
      if (!byId.has(id)) throw new Error(`verdict references unknown calibration row: ${id}`);
      if (assigned.has(id)) throw new Error(`calibration row has more than one verdict: ${id}`);
      assigned.add(id);
      byId.set(id, {
        ...byId.get(id),
        verdict: group.verdict,
        noiseArchetype: group.verdict === 'invalid' ? group.archetype : null,
        evidenceNote: group.evidenceNote,
      });
    }
  }
  return rows.map((row) => byId.get(row.calibrationId));
}

export function applyUtilityGroups(rows, groups) {
  const byId = new Map(rows.map((row) => [row.calibrationId, row]));
  const assigned = new Set();
  for (const group of groups) {
    if (!['actionable', 'non-actionable', 'uncertain', 'not-applicable'].includes(group.verdict)) {
      throw new Error(`unknown calibration utility verdict: ${group.verdict}`);
    }
    for (const id of calibrationGroupIds(rows, group, 'utility verdict')) {
      if (!byId.has(id)) throw new Error(`utility verdict references unknown calibration row: ${id}`);
      if (assigned.has(id)) throw new Error(`calibration row has more than one utility verdict: ${id}`);
      assigned.add(id);
      byId.set(id, {
        ...byId.get(id),
        utilityVerdict: group.verdict,
        utilityArchetype: group.verdict === 'non-actionable' ? group.archetype : null,
        utilityNote: group.evidenceNote,
      });
    }
  }
  return rows.map((row) => byId.get(row.calibrationId));
}

function calibrationGroupIds(rows, group, label) {
  const hasIds = Array.isArray(group.ids);
  const hasDetectors = Array.isArray(group.detectors);
  if (hasIds === hasDetectors) {
    throw new Error(`${label} group must declare exactly one of ids or detectors`);
  }
  if (hasIds) return group.ids;
  const detectorSet = new Set(group.detectors);
  return rows.filter((row) => detectorSet.has(row.detector)).map((row) => row.calibrationId);
}

export function summarizeUtilityByDetector(rows, { detectors: declaredDetectors = [] } = {}) {
  const detectors = [...new Set([...declaredDetectors, ...rows.map((row) => row.detector)])].sort();
  return Object.fromEntries(
    detectors.map((detector) => {
      const detectorRows = rows.filter((row) => row.detector === detector);
      const actionable = detectorRows.filter((row) => row.utilityVerdict === 'actionable').length;
      const nonActionable = detectorRows.filter((row) => row.utilityVerdict === 'non-actionable').length;
      const uncertain = detectorRows.filter((row) => row.utilityVerdict === 'uncertain').length;
      const notApplicable = detectorRows.filter((row) => row.utilityVerdict === 'not-applicable').length;
      const reviewed = actionable + nonActionable;
      return [
        detector,
        {
          rows: detectorRows.length,
          reviewed,
          actionable,
          nonActionable,
          uncertain,
          notApplicable,
          pending: detectorRows.length - reviewed - uncertain - notApplicable,
          observedUtilityRate: reviewed > 0 ? actionable / reviewed : null,
        },
      ];
    }),
  );
}

function sampleRank(seed, identity) {
  return createHash('sha256').update(`${seed}\0${identity}`).digest('hex');
}
