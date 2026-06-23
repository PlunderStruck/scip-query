import { existsSync, readFileSync } from 'node:fs';
import type { ScipDatabase } from '../../storage/db.js';
import { markdownCitationContext } from '../cleanup/doc-citation-context.js';
import { matchingDocTerms } from '../cleanup/doc-terms.js';
import type { ChangedLineRange } from './diff-impact.js';
import { rangesByFile } from './diff-ranges.js';
import type { DiffGateActionTier, DocCitationKind } from './diff-gate-types.js';

export interface DocCitationClassification {
  citationKind: DocCitationKind;
  actionTier: DiffGateActionTier;
  reasons: string[];
}

export const docReferencePolicy = {
  classifyCitation,
  citationContexts,
  citationKindLabel,
  citationRemediation,
  referenceTargets,
} as const;

function classifyCitation(contexts: readonly string[]): DocCitationClassification {
  const haystack = contexts.join('\n').toLowerCase();
  const reasons: string[] = [];

  const configHits = matchingDocTerms(haystack, [
    '.scipquery',
    'declaredcouplings',
    'suppression',
    'suppressions',
    'config',
    'configuration',
    'json',
  ]);
  if (configHits.length > 0) {
    reasons.push(`configuration/example terms near citation: ${configHits.join(', ')}`);
    return { citationKind: 'configuration-example', actionTier: 'support', reasons };
  }

  const intentionalHits = matchingDocTerms(haystack, [
    'accepted',
    'intentional',
    'intentionally',
    'retained',
    'historical',
  ]);
  if (intentionalHits.length > 0) {
    reasons.push(`intentional-record terms near citation: ${intentionalHits.join(', ')}`);
    return { citationKind: 'intentional-record', actionTier: 'support', reasons };
  }

  const guideHits = matchingDocTerms(haystack, ['command', 'cli', 'usage', 'example', 'run', 'workflow']);
  if (guideHits.length > 0) {
    reasons.push(`guide/reference terms near citation: ${guideHits.join(', ')}`);
    return { citationKind: 'guide-reference', actionTier: 'signal', reasons };
  }

  reasons.push(
    contexts.length > 0 ? 'citation appears in prose without config or guide markers' : 'citation context unavailable',
  );
  return { citationKind: 'behavioral-claim', actionTier: 'direct', reasons };
}

function citationContexts(db: ScipDatabase, doc: string, cited: readonly string[]): string[] {
  let lines: string[];
  try {
    lines = readFileSync(`${db.config.projectRoot}/${doc}`, 'utf-8').split(/\r?\n/);
  } catch {
    return [];
  }

  const needles = cited.flatMap(citationNeedles);
  const contexts: string[] = [];
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? '';
    if (!needles.some((needle) => line.includes(needle))) continue;
    contexts.push(markdownCitationContext(lines, lineIndex));
  }
  return contexts;
}

function citationNeedles(file: string): string[] {
  const segments = file.split('/');
  return [file, `./${file}`, segments.slice(-3).join('/'), segments.slice(-2).join('/')].filter(
    (needle, index, all) => needle.length > 0 && all.indexOf(needle) === index,
  );
}

function citationKindLabel(kind: DocCitationKind): string {
  switch (kind) {
    case 'behavioral-claim':
      return 'a behavioral doc claim';
    case 'configuration-example':
      return 'a configuration example';
    case 'guide-reference':
      return 'a guide reference';
    case 'intentional-record':
      return 'an intentional record';
  }
}

function citationRemediation(kind: DocCitationKind, doc: string): string {
  switch (kind) {
    case 'behavioral-claim':
      return `Re-read ${doc} and update the behavioral claim or citation.`;
    case 'configuration-example':
      return `Verify the configuration example in ${doc} still points at the intended file; update only if the example target changed.`;
    case 'guide-reference':
      return `Verify the guide reference in ${doc} still sends readers to the right implementation or command surface.`;
    case 'intentional-record':
      return `Verify the intentional citation in ${doc} is still meant to name this file.`;
  }
}

function referenceTargets(
  db: ScipDatabase,
  changed: ReadonlySet<string>,
  changedRanges: readonly ChangedLineRange[],
): ReadonlySet<string> {
  const ranges = rangesByFile(changedRanges);
  const targets = new Set<string>();
  for (const file of changed) {
    if (hasDocRelevantChange(db, file, ranges.get(file) ?? [])) {
      targets.add(file);
    }
  }
  return targets;
}

function hasDocRelevantChange(db: ScipDatabase, file: string, ranges: readonly ChangedLineRange[]): boolean {
  if (ranges.length === 0) return false;
  if (!SOURCE_FILE_PATTERN.test(file)) return true;
  const absolutePath = `${db.config.projectRoot}/${file}`;
  if (!existsSync(absolutePath)) return true;
  const lines = readFileSync(absolutePath, 'utf-8').split(/\r?\n/);
  const importLines = staticImportExportLines(lines);
  for (const range of ranges) {
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      if ((lines[line] ?? '').trim() === '') continue;
      if (!importLines.has(line)) return true;
    }
  }
  return false;
}

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]sx?)$/i;

function staticImportExportLines(lines: readonly string[]): ReadonlySet<number> {
  const out = new Set<number>();
  let inDeclaration = false;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i]!.trim();
    if (!inDeclaration && isStaticImportExportStart(trimmed)) {
      inDeclaration = true;
    }
    if (!inDeclaration) continue;
    out.add(i);
    if (trimmed.endsWith(';')) {
      inDeclaration = false;
    }
  }
  return out;
}

function isStaticImportExportStart(trimmed: string): boolean {
  return /^import(?:\s|$)/.test(trimmed) || /^export(?:\s+type)?\s+(?:\*|\{)/.test(trimmed);
}
