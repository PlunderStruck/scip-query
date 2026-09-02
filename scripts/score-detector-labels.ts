#!/usr/bin/env vite-node
/**
 * Score a detector's complete output against a reviewed label set.
 *
 * A label set is the durable form of a full-list review: each row a reviewer
 * classified carries a stable identity (derived from the detector's own row
 * shape), a verdict, and the reason. Re-scoring a detector dump against the
 * set after a policy change answers two questions the change must not
 * regress: did any labeled true finding disappear (recall), and how many of
 * the rows it still reports are labeled false (precision).
 *
 * Usage:
 *   vite-node scripts/score-detector-labels.ts \
 *     --labels docs/validation/labels/<repo>/<detector>.json \
 *     --dump <detector --json --json-output file> [--min-precision 0.8]
 *
 * Exit status is non-zero when a labeled true finding is missing from the
 * dump or when precision over labeled rows falls below `--min-precision`.
 */
import { readFileSync } from 'node:fs';

export type LabelVerdict = 'true' | 'false' | 'uncertain';

export interface DetectorLabel {
  id: string;
  verdict: LabelVerdict;
  reason: string;
}

export interface DetectorLabelSet {
  detector: string;
  repository: string;
  /** Row identity scheme; must match `rowIdentity` below. */
  identity: 'pair' | 'symbol' | 'group' | 'file-pair';
  labels: DetectorLabel[];
}

export interface LabelScore {
  detector: string;
  dumpRows: number;
  labeledRows: number;
  /** Labeled rows the dump still reports at signal tier (or without a tier), by verdict. */
  present: Record<LabelVerdict, number>;
  /** Labeled rows the dump reports only at support tier, by verdict; not findings, still visible. */
  demoted: Record<LabelVerdict, number>;
  /** Labeled rows the dump no longer reports, by verdict. */
  absent: Record<LabelVerdict, number>;
  /** true / (true + false) over labeled rows still present. */
  precision: number | null;
  /** present true / all labeled true. */
  recall: number | null;
  missingTrue: DetectorLabel[];
  retainedFalse: DetectorLabel[];
  unlabeledRows: number;
}

export function rowIdentity(identity: DetectorLabelSet['identity'], row: Record<string, unknown>): string | null {
  const text = (key: string): string | null => (typeof row[key] === 'string' ? (row[key] as string) : null);
  switch (identity) {
    case 'pair': {
      const left = `${text('fileA') ?? ''}#${text('componentA') ?? text('symbolA') ?? ''}`;
      const right = `${text('fileB') ?? ''}#${text('componentB') ?? text('symbolB') ?? ''}`;
      if (left === '#' || right === '#') return null;
      return [left, right].sort().join('|');
    }
    case 'file-pair': {
      const left = text('fileA');
      const right = text('fileB');
      return left && right ? [left, right].sort().join('|') : null;
    }
    case 'symbol': {
      const file = text('file') ?? text('relativePath');
      const name = text('shortName') ?? text('symbol');
      return file && name ? `${file}#${name}` : null;
    }
    case 'group': {
      const leaf = text('leaf') ?? text('hash');
      const members = (row['members'] ?? row['functions']) as Array<{ file?: string }> | undefined;
      if (!leaf || !Array.isArray(members)) return null;
      const files = members
        .map((member) => member.file)
        .filter((file): file is string => typeof file === 'string')
        .sort();
      return `${leaf}|${files.join(',')}`;
    }
  }
}

export function dumpRows(dump: unknown): Record<string, unknown>[] {
  const result = (dump as { result?: unknown }).result ?? dump;
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  if (result && typeof result === 'object') {
    for (const key of ['results', 'findings', 'groups', 'symbols', 'cycles']) {
      const value = (result as Record<string, unknown>)[key];
      if (Array.isArray(value)) return value as Record<string, unknown>[];
    }
  }
  return [];
}

export function scoreLabels(labelSet: DetectorLabelSet, dump: unknown): LabelScore {
  const rows = dumpRows(dump);
  // A row reported at support tier is visible but not a finding; count it
  // apart so a demotion reads as neither a hit nor a miss.
  // Detectors name their tiers two ways: `signal | support` (signal is the
  // finding) and `direct | signal` (direct is the finding, signal the demoted
  // review lead). When a dump carries any `direct` row, its `signal` rows are
  // the demoted ones.
  const directVocabulary = rows.some((row) => row['actionTier'] === 'direct');
  const tiers = new Map<string, 'signal' | 'support'>();
  for (const row of rows) {
    const id = rowIdentity(labelSet.identity, row);
    if (!id) continue;
    const actionTier = row['actionTier'];
    const demoted = actionTier === 'support' || (directVocabulary && actionTier === 'signal');
    const tier = demoted ? 'support' : 'signal';
    if (tiers.get(id) !== 'signal') tiers.set(id, tier);
  }
  const present: Record<LabelVerdict, number> = { true: 0, false: 0, uncertain: 0 };
  const demoted: Record<LabelVerdict, number> = { true: 0, false: 0, uncertain: 0 };
  const absent: Record<LabelVerdict, number> = { true: 0, false: 0, uncertain: 0 };
  const missingTrue: DetectorLabel[] = [];
  const retainedFalse: DetectorLabel[] = [];
  const labeledIds = new Set<string>();
  for (const label of labelSet.labels) {
    labeledIds.add(label.id);
    const tier = tiers.get(label.id);
    if (tier === 'signal') {
      present[label.verdict] += 1;
      if (label.verdict === 'false') retainedFalse.push(label);
    } else if (tier === 'support') {
      demoted[label.verdict] += 1;
      if (label.verdict === 'true') missingTrue.push(label);
    } else {
      absent[label.verdict] += 1;
      if (label.verdict === 'true') missingTrue.push(label);
    }
  }
  const labeledTrue = present.true + demoted.true + absent.true;
  const decided = present.true + present.false;
  return {
    detector: labelSet.detector,
    dumpRows: rows.length,
    labeledRows: labelSet.labels.length,
    present,
    demoted,
    absent,
    precision: decided > 0 ? round3(present.true / decided) : null,
    recall: labeledTrue > 0 ? round3(present.true / labeledTrue) : null,
    missingTrue,
    retainedFalse,
    unlabeledRows: [...tiers.keys()].filter((id) => !labeledIds.has(id)).length,
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function parseArguments(argv: readonly string[]): { labels: string; dump: string; minPrecision: number } {
  const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected argument ${token}.`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}.`);
    options[token.slice(2)] = value;
    index += 1;
  }
  if (!options['labels'] || !options['dump']) {
    throw new Error(
      'Usage: score-detector-labels --labels <label file> --dump <detector json dump> [--min-precision n]',
    );
  }
  return {
    labels: options['labels'],
    dump: options['dump'],
    minPrecision: options['min-precision'] === undefined ? 0 : Number(options['min-precision']),
  };
}

function main(): void {
  const args = parseArguments(process.argv.slice(2));
  const labelSet = JSON.parse(readFileSync(args.labels, 'utf8')) as DetectorLabelSet;
  const dump = JSON.parse(readFileSync(args.dump, 'utf8')) as unknown;
  const score = scoreLabels(labelSet, dump);
  console.log(
    `${score.detector} (${labelSet.repository}): ${score.dumpRows} rows in dump, ${score.labeledRows} labeled`,
  );
  console.log(
    `  signal: ${score.present.true} true, ${score.present.false} false, ${score.present.uncertain} uncertain; ` +
      `support: ${score.demoted.true} true, ${score.demoted.false} false, ${score.demoted.uncertain} uncertain; ` +
      `absent: ${score.absent.true} true, ${score.absent.false} false, ${score.absent.uncertain} uncertain`,
  );
  console.log(
    `  precision over labeled rows ${score.precision ?? 'n/a'}; recall of labeled true ${score.recall ?? 'n/a'}; ${score.unlabeledRows} unlabeled rows`,
  );
  for (const label of score.missingTrue) console.log(`  MISSING or demoted true: ${label.id} (${label.reason})`);
  for (const label of score.retainedFalse) console.log(`  retained false: ${label.id} (${label.reason})`);
  const precisionOk = score.precision === null || score.precision >= args.minPrecision;
  if (score.missingTrue.length > 0 || !precisionOk) process.exitCode = 1;
}

// vite-node strips the script path from argv, so the CLI is recognized by
// its own required option; a library import never passes `--labels`.
if (process.argv.includes('--labels')) main();
