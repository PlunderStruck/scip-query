import type { ScipDatabase } from '../storage/db.js';
import { createPerDbCache } from '../storage/per-db-cache.js';
import { getSourceText } from '../source/source-text.js';

const VUE_NON_SCRIPT_IDENTIFIERS_CACHE = createPerDbCache<string, Set<string>>('vue-non-script-identifiers', {
  clearGroups: ['whole-project', 'source-file'],
});

/**
 * Collect identifier-shaped tokens from the parts of a Vue SFC that are not
 * inside `<script>` blocks. This marks imports as used when they are only
 * referenced from a template.
 */
export function collectVueNonScriptIdentifiers(
  db: ScipDatabase,
  relativePath: string,
): Set<string> {
  return VUE_NON_SCRIPT_IDENTIFIERS_CACHE.get(db, relativePath, () => {
    const out = new Set<string>();
    const source = getSourceText(db, relativePath);
    if (!source) return out;
    const withoutScripts = source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, (m) =>
      m.replace(/[^\r\n]/g, ' '),
    );
    const stripped = withoutScripts
      .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\r\n]/g, ' '))
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\r\n]/g, ' '));
    for (const match of stripped.matchAll(/[A-Za-z_$][\w$]*/g)) {
      out.add(match[0]);
    }
    return out;
  });
}
