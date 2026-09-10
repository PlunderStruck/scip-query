import type { BoundaryKeyPart, BoundaryTerm, BoundaryValuePrecision } from './types.js';

/** Preserve value uncertainty independently of how an observation was derived. */
export function boundaryKeyPrecision(part: BoundaryKeyPart): BoundaryValuePrecision {
  if (part.precision) return part.precision;
  if (part.term) return termPrecision(part.term);
  if (part.evidence === 'expression') return 'unknown';
  return part.evidence === 'identifier' ? 'symbolic' : 'literal';
}

export function boundaryValuePrecision(parts: readonly BoundaryKeyPart[]): BoundaryValuePrecision {
  return weakestPrecision(parts.map(boundaryKeyPrecision));
}

function weakestPrecision(values: readonly BoundaryValuePrecision[]): BoundaryValuePrecision {
  return (
    (['unknown', 'symbolic', 'constrained-pattern', 'finite-set'] as const).find((value) => values.includes(value)) ??
    'literal'
  );
}

function termPrecision(term: BoundaryTerm): BoundaryValuePrecision {
  switch (term.kind) {
    case 'literal':
      return 'literal';
    case 'finite-set':
      return 'finite-set';
    case 'pattern':
      return 'constrained-pattern';
    case 'parameter':
    case 'symbol':
      return 'symbolic';
    case 'concat':
      return weakestPrecision(term.parts.map(termPrecision));
    default:
      return 'unknown';
  }
}
