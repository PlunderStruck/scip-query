/**
 * Zero-dependency regex primitives shared across layers that otherwise
 * cannot depend on each other (src/semantic must never import src/source —
 * see docs/AGENT_GUIDE.md's layering invariant). Kept dependency-free so
 * every layer already permitted to import src/core/ can use it without
 * pulling in source-stripper's caching machinery.
 */

/** Escape regex meta-characters so a user-supplied identifier matches literally. */
export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
