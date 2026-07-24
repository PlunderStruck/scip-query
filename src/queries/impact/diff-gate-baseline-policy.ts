import type { DiffGateActionTier } from './diff-gate-types.js';

export interface BaselineFindingMetadata {
  sourceAnalyzer: string;
  actionTier: DiffGateActionTier;
  rootCauseKey: string;
  label: string;
  file?: string;
  relatedFiles: string[];
  why: string[];
  remediation: string;
}

export function baselineFindingMetadata(finding: string): BaselineFindingMetadata {
  const [sourceAnalyzer, payload] = splitFirst(finding, ':');
  const analyzer = sourceAnalyzer || 'unknown';
  const base = (overrides: Partial<BaselineFindingMetadata> = {}): BaselineFindingMetadata => {
    const actionTier = overrides.actionTier ?? baselineAnalyzerActionTier(analyzer);
    return {
      sourceAnalyzer: analyzer,
      actionTier,
      rootCauseKey: overrides.rootCauseKey ?? (payload || finding),
      label: overrides.label ?? `${analyzer} finding`,
      relatedFiles: overrides.relatedFiles ?? [],
      why: overrides.why ?? [],
      remediation: overrides.remediation ?? baselineRemediation(actionTier, analyzer),
      file: overrides.file,
    };
  };

  if (!payload) return base({ rootCauseKey: finding, why: ['Baseline identity did not include analyzer payload.'] });

  if (['dead', 'isolated', 'extract', 'wrapper', 'passthrough', 'stale'].includes(analyzer)) {
    const [file, subject] = splitFirst(payload, ':');
    return base({
      file,
      relatedFiles: file ? [file] : [],
      rootCauseKey: subject ? `${file}:${subject}` : payload,
      label: `${analyzer} finding`,
      why: subject ? [`Baseline subject: ${subject}.`] : [],
    });
  }

  if (analyzer === 'cycle') {
    const cycleFiles = payload.split('>').filter(Boolean);
    return base({
      relatedFiles: cycleFiles,
      rootCauseKey: payload,
      label: 'cycle finding',
      why: cycleFiles.length > 0 ? [`Cycle path: ${cycleFiles.join(' > ')}.`] : [],
    });
  }

  if (analyzer === 'similar') {
    const symbols = payload.split('|').filter(Boolean);
    return base({
      relatedFiles: [],
      rootCauseKey: payload,
      label: 'similarity finding',
      why: symbols.length > 0 ? [`Similar symbols: ${symbols.join(' | ')}.`] : [],
    });
  }

  if (analyzer === 'architecture') {
    const [architectureKind, rest] = splitFirst(payload, ':');
    if (architectureKind === 'forbidden-edge') {
      const [encodedFrom, encodedTo] = splitFirst(rest, ':');
      const from = decodeIdentityPart(encodedFrom);
      const to = decodeIdentityPart(encodedTo);
      return base({
        actionTier: 'direct',
        rootCauseKey: payload,
        label: 'architecture boundary violation',
        why: [`Declared boundary rule rejects ${from} -> ${to}.`],
        remediation: `Move the dependency behind an allowed boundary, or deliberately update the ${from} dependency rule and baseline.`,
      });
    }
    if (architectureKind === 'cycle') {
      const boundaries = rest.split('|').filter(Boolean).map(decodeIdentityPart);
      return base({
        actionTier: 'direct',
        rootCauseKey: payload,
        label: 'forbidden architecture cycle',
        why: [`requireAcyclic rejects the connected boundary group: ${boundaries.join(', ')}.`],
        remediation: 'Break the boundary cycle, or deliberately revise the acyclicity rule and baseline.',
      });
    }
    if (architectureKind === 'missing-policy-row') {
      const boundary = decodeIdentityPart(rest);
      return base({
        actionTier: 'direct',
        rootCauseKey: payload,
        label: 'incomplete architecture policy',
        why: [`requireCompletePolicy rejects the missing outgoing dependency row for ${boundary}.`],
        remediation: `Declare the allowed outgoing dependencies for ${boundary}, including an empty row when it must depend on nothing.`,
      });
    }
  }

  if (analyzer === 'drift') {
    const [driftKind, rest] = splitFirst(payload, ':');
    const [file, dep] = splitFirst(rest, ':');
    return base({
      actionTier: driftKind === 'unused-import' ? 'direct' : 'signal',
      file,
      relatedFiles: [...new Set([file, dep].filter(Boolean))],
      rootCauseKey: payload,
      label: `${driftKind || 'drift'} finding`,
      why: [...(driftKind ? [`Drift kind: ${driftKind}.`] : []), ...(dep ? [`Related dependency: ${dep}.`] : [])],
    });
  }

  return base({ why: ['Baseline analyzer prefix is not recognized by this diff-gate version.'] });
}

function baselineAnalyzerActionTier(analyzer: string): DiffGateActionTier {
  switch (analyzer) {
    case 'dead':
    case 'isolated':
    case 'cycle':
    case 'passthrough':
    case 'architecture':
      return 'direct';
    case 'similar':
    case 'extract':
    case 'wrapper':
    case 'stale':
      return 'signal';
    default:
      return 'signal';
  }
}

// scip-query: ignore-similar — reviewed D1 product policy; baseline acceptance is distinct from echo remediation.
function baselineRemediation(actionTier: DiffGateActionTier, analyzer: string): string {
  if (actionTier === 'direct') {
    return `Fix the new ${analyzer} baseline finding, or knowingly accept it via health --write-baseline.`;
  }
  return `Review the new ${analyzer} baseline signal; fix it if it reflects real debt, or knowingly accept it via health --write-baseline.`;
}

function splitFirst(value: string, delimiter: string): [string, string] {
  const index = value.indexOf(delimiter);
  if (index < 0) return [value, ''];
  return [value.slice(0, index), value.slice(index + delimiter.length)];
}

function decodeIdentityPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
