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
