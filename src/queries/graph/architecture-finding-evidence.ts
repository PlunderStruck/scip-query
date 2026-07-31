import { matchesGlob } from '../../analysis/glob-match.js';
import type { ArchitectureConfig } from '../../domain/config-types.js';
import { ARCHITECTURE_BASELINE_PREFIX, type ArchitectureFileEdge, type ArchitectureReport } from './architecture.js';

export interface ArchitectureFindingEvidence {
  file?: string;
  relatedFiles: string[];
  why: string[];
}

/**
 * Recover the repository referents behind one stable architecture identity.
 *
 * Baseline identities intentionally omit file examples so ordinary moves do
 * not churn accepted debt. Completion evidence has the opposite need: it must
 * name the current source, target, test, coverage file, or policy file that an
 * agent can inspect. This projection joins the stable identity back to the
 * already-computed typed report; it does not run another architecture engine.
 */
export function architectureFindingEvidence(
  finding: string,
  report: ArchitectureReport,
  config: ArchitectureConfig | undefined,
  changedFiles: readonly string[] = [],
): ArchitectureFindingEvidence {
  if (!finding.startsWith(ARCHITECTURE_BASELINE_PREFIX)) return { relatedFiles: [], why: [] };
  const payload = finding.slice(ARCHITECTURE_BASELINE_PREFIX.length);
  const [kind, rest] = splitFirst(payload, ':');
  const files = new Set<string>();
  const boundaries = new Set<string>();
  let primary: string | undefined;
  let policyReferent = false;

  if (kind === 'forbidden-edge') {
    const [encodedFrom, encodedTo] = splitFirst(rest, ':');
    const from = decodePart(encodedFrom);
    const to = decodePart(encodedTo);
    boundaries.add(from);
    boundaries.add(to);
    const edge = report.forbiddenEdges.find((candidate) => candidate.from === from && candidate.to === to);
    addEdges(files, edge?.examples ?? []);
    primary = edge?.examples[0]?.fromFile;
  } else if (kind === 'cycle') {
    const members = rest.split('|').filter(Boolean).map(decodePart).sort();
    for (const boundary of members) boundaries.add(boundary);
    const cycle = report.cycles.find(
      (candidate) =>
        candidate.violatesPolicy &&
        candidate.boundaries.length === members.length &&
        candidate.boundaries
          .map(decodePart)
          .sort()
          .every((value, index) => value === members[index]),
    );
    for (const edge of cycle?.narrowestEdges ?? cycle?.internalEdges ?? []) addEdges(files, edge.examples);
    primary = firstImporter(cycle?.narrowestEdges.flatMap((edge) => edge.examples) ?? []);
  } else if (kind === 'coarse-boundary') {
    const [encodedBoundary] = splitFirst(rest, ':');
    const boundary = decodePart(encodedBoundary);
    boundaries.add(boundary);
    const coarse = report.coarseBoundaries.find(
      (candidate) => candidate.violatesPolicy && candidate.boundary === boundary,
    );
    for (const edge of coarse?.narrowestEdges ?? coarse?.internalEdges ?? []) addEdges(files, edge.examples);
    primary = firstImporter(coarse?.narrowestEdges.flatMap((edge) => edge.examples) ?? []);
  } else if (kind === 'test-boundary') {
    const [encodedTest, encodedBoundary] = splitFirst(rest, ':');
    const testFile = decodePart(encodedTest);
    const importedBoundary = decodePart(encodedBoundary);
    const violation = report.testBoundaryViolations.find(
      (candidate) => candidate.testFile === testFile && candidate.importedBoundary === importedBoundary,
    );
    primary = testFile;
    files.add(testFile);
    boundaries.add(importedBoundary);
    if (violation?.ownerBoundary) boundaries.add(violation.ownerBoundary);
    if (violation?.importedFile) files.add(violation.importedFile);
  } else if (kind === 'unmapped-file') {
    primary = decodePart(rest);
    files.add(primary);
  } else if (kind === 'ambiguous-file') {
    const [encodedFile, encodedBoundaries] = splitFirst(rest, ':');
    primary = decodePart(encodedFile);
    files.add(primary);
    for (const boundary of encodedBoundaries.split('|').filter(Boolean).map(decodePart)) boundaries.add(boundary);
  } else if (kind === 'boundary-limit') {
    const [, encodedBoundary] = splitFirst(rest, ':');
    boundaries.add(decodePart(encodedBoundary));
    policyReferent = true;
  } else if (kind === 'missing-policy-row') {
    boundaries.add(decodePart(rest));
    policyReferent = true;
  } else if (kind === 'stale-allowance') {
    const [encodedFrom, encodedTo] = splitFirst(rest, ':');
    boundaries.add(decodePart(encodedFrom));
    boundaries.add(decodePart(encodedTo));
    policyReferent = true;
  }

  for (const changed of changedFiles) {
    if (belongsToAnyBoundary(changed, boundaries, config)) files.add(changed);
  }
  if (policyReferent) files.add('.scipquery.json');
  const relatedFiles = [...files].sort();
  return {
    ...(primary ? { file: primary } : relatedFiles[0] ? { file: relatedFiles[0] } : {}),
    relatedFiles,
    why:
      relatedFiles.length > 0
        ? [`Current architecture evidence: ${relatedFiles.join(', ')}.`]
        : ['The stable architecture identity has no current file referent in this report.'],
  };
}

function addEdges(files: Set<string>, edges: readonly ArchitectureFileEdge[]): void {
  for (const edge of edges) {
    files.add(edge.fromFile);
    files.add(edge.toFile);
  }
}

function firstImporter(edges: readonly ArchitectureFileEdge[]): string | undefined {
  return edges[0]?.fromFile;
}

function belongsToAnyBoundary(
  file: string,
  boundaries: ReadonlySet<string>,
  config: ArchitectureConfig | undefined,
): boolean {
  if (boundaries.size === 0 || !config) return false;
  return config.boundaries.some(
    (boundary) => boundaries.has(boundary.name) && boundary.paths.some((pattern) => matchesGlob(pattern, file)),
  );
}

function splitFirst(value: string, delimiter: string): [string, string] {
  const index = value.indexOf(delimiter);
  return index < 0 ? [value, ''] : [value.slice(0, index), value.slice(index + delimiter.length)];
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
