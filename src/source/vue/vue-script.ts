import type { AstLanguage } from '../ast/ast-language.js';
import type { ScipDatabase } from '../../storage/db.js';
import { buildVueSfcUnit } from './vue-sfc.js';

export interface VueScriptBlock {
  body: string;
  startLine: number;
  language: AstLanguage;
}

/**
 * Adapter for the generic AST pipeline. Vue-specific profiling consumes the
 * full SFC unit directly; this path flattens all JS/TS script blocks into one
 * parseable source string while preserving SFC-relative line numbers with
 * newline padding. Relative `src=` blocks are resolved by `buildVueSfcUnit`;
 * absolute paths and URLs stay unsupported there so every Vue path shares the
 * same envelope.
 */
export function extractVueScriptBlock(db: ScipDatabase, relativePath: string, source: string): VueScriptBlock | null {
  const unit = buildVueSfcUnit(db, relativePath, source);
  const scripts = unit.scripts.filter((script) => script.astLanguage && script.body.length > 0);
  const language = scripts[0]?.astLanguage;
  if (!language) return null;

  return {
    body: scripts.map((script) => `${'\n'.repeat(script.startLine)}${script.body}`).join('\n'),
    startLine: 0,
    language,
  };
}
