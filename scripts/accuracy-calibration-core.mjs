import { createHash } from 'node:crypto';

export const CALIBRATION_SCHEMA_VERSION = 1;

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
    sourceExcerpt: context.sourceExcerpt(candidate),
    verdict: null,
    noiseArchetype: null,
    evidenceNote: null,
  };
  return { ...row, calibrationId: calibrationRowIdentity(row) };
}

export function applyVerdictGroups(rows, groups) {
  const byId = new Map(rows.map((row) => [row.calibrationId, row]));
  const assigned = new Set();
  for (const group of groups) {
    if (!['valid', 'invalid', 'uncertain'].includes(group.verdict)) {
      throw new Error(`unknown calibration verdict: ${group.verdict}`);
    }
    for (const id of group.ids) {
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

function sampleRank(seed, identity) {
  return createHash('sha256').update(`${seed}\0${identity}`).digest('hex');
}
