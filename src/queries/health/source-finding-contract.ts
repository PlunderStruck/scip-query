import type { SourceFunction } from '../../source/ast/function-metrics.js';
import type { FunctionCoverage } from '../../source/maintenance-coverage.js';

export interface FindingSite {
  file: string;
  line: number;
  name?: string;
}
export interface SourceFinding {
  id: string;
  rule:
    | 'complexity'
    | 'duplication'
    | 'dependency-cycle'
    | 'architecture'
    | 'crap'
    | 'broken-dependency'
    | 'responsibility';
  evidence: 'derived' | 'candidate';
  summary: string;
  sites: FindingSite[];
  score: number;
  details: string[];
  status?: 'introduced' | 'worsened' | 'existing' | 'resolved' | 'uncomparable';
}

export interface MeasuredFunction extends SourceFunction {
  coverage: FunctionCoverage;
}

/** A component describes several mutually dependent units; it is not a defect owned by its first member. */
export function isDependencyComponent(finding: SourceFinding): boolean {
  return finding.rule === 'dependency-cycle' || finding.id.startsWith('architecture:group-cycle:');
}
export function compareFindings(a: SourceFinding, b: SourceFinding): number {
  const priority = {
    'broken-dependency': 0,
    architecture: 1,
    'dependency-cycle': 2,
    responsibility: 3,
    duplication: 4,
    crap: 5,
    complexity: 6,
  };
  return priority[a.rule] - priority[b.rule] || b.score - a.score || a.id.localeCompare(b.id);
}
