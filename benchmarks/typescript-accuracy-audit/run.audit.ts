import { it } from 'vitest';

it('records TypeScript accuracy observations without requiring the tool to pass its probes', async () => {
  await import('./run.js');
}, 300_000);
