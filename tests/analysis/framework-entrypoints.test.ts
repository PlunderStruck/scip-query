import { describe, expect, it } from 'vitest';
import { isFrameworkEntrypointPath } from '../../src/analysis/file-classifier.js';

describe('framework entrypoint paths', () => {
  it('recognizes Next.js file-convention boundaries in nested monorepos', () => {
    expect(isFrameworkEntrypointPath('ee/apps/web/app/(admin)/billing/page.tsx')).toBe(true);
    expect(isFrameworkEntrypointPath('ee/apps/web/app/layout.tsx')).toBe(true);
    expect(isFrameworkEntrypointPath('ee/apps/web/app/api/health/route.ts')).toBe(true);
    expect(isFrameworkEntrypointPath('ee/apps/landing/middleware.ts')).toBe(true);
    expect(isFrameworkEntrypointPath('ee/apps/landing/src/proxy.ts')).toBe(true);
    expect(isFrameworkEntrypointPath('frontend/ui/src/proxy.ts')).toBe(true);
    expect(isFrameworkEntrypointPath('instrumentation-client.ts')).toBe(true);
    expect(isFrameworkEntrypointPath('apps/web/src/instrumentation-client.ts')).toBe(true);
  });

  it('does not turn ordinary similarly named modules into framework roots', () => {
    expect(isFrameworkEntrypointPath('src/components/layout.tsx')).toBe(false);
    expect(isFrameworkEntrypointPath('src/http/middleware.ts')).toBe(false);
    expect(isFrameworkEntrypointPath('src/services/page.ts')).toBe(false);
  });
});
