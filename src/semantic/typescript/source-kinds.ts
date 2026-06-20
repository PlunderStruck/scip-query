export const TYPESCRIPT_SEMANTIC_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

export function isTypeScriptLike(relativePath: string): boolean {
  const normalized = relativePath.toLowerCase();
  return TYPESCRIPT_SEMANTIC_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}
