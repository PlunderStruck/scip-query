import type { AstLanguage } from './ast-language.js';

export interface VueScriptBlock {
  body: string;
  startLine: number;
  language: AstLanguage;
}

/**
 * Find the first `<script>` or `<script setup>` block in a Vue SFC.
 * Vue's grammar disallows nested script tags, so a source regex is enough for
 * this extraction policy. Prefer setup script because it is the modern import
 * and binding surface.
 */
export function extractVueScriptBlock(source: string): VueScriptBlock | null {
  const scripts: { tagOpen: string; body: string; openIdx: number }[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  for (const match of source.matchAll(re)) {
    if (typeof match.index !== 'number') continue;
    scripts.push({
      tagOpen: match[1] ?? '',
      body: match[2] ?? '',
      openIdx: match.index + (match[0].length - (match[2]?.length ?? 0) - '</script>'.length),
    });
  }
  if (scripts.length === 0) return null;

  const preferred = scripts.find((s) => /\bsetup\b/.test(s.tagOpen)) ?? scripts[0]!;
  const langMatch = preferred.tagOpen.match(/\blang\s*=\s*["']?([\w-]+)/);
  const langAttr = langMatch?.[1]?.toLowerCase();
  const language: AstLanguage = langAttr === 'ts' || langAttr === 'typescript'
    ? 'typescript'
    : langAttr === 'tsx'
      ? 'tsx'
      : 'javascript';

  return {
    body: preferred.body,
    startLine: countNewlinesBefore(source, preferred.openIdx),
    language,
  };
}

function countNewlinesBefore(source: string, offset: number): number {
  let count = 0;
  for (let i = 0; i < offset && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) count++;
  }
  return count;
}
