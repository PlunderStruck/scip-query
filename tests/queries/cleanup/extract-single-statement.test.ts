import { describe, expect, it } from 'vitest';
import { singleStatementRegion } from '../../../src/queries/cleanup/extract-candidates.js';

const region = (lines: string[]) => singleStatementRegion(lines, { startLine: 0, endLine: lines.length - 1 });

describe('singleStatementRegion', () => {
  it('recognizes one awaited call with a callback argument as a single statement', () => {
    expect(
      region([
        '    await runRequest({',
        '      loading,',
        '      request: async () => {',
        '        const data = await load();',
        '        items.value = data.items;',
        '      },',
        '    });',
      ]),
    ).toBe('one call or expression statement');
  });

  it('recognizes one declaration and one nested function', () => {
    expect(region(['  const resource = useResource({', '    key: "x",', '    request: () => load(),', '  });'])).toBe(
      'one declaration',
    );
    expect(region(['  const load = async () => {', '    await refresh();', '  };'])).toBe(
      'one nested function declaration',
    );
    expect(region(['  function helper(value: string) {', '    return format(value);', '  }'])).toBe(
      'one nested function declaration',
    );
  });

  it('treats a region that starts inside an enclosing expression as a fragment', () => {
    expect(region(['  ) => {', '    await save();', '  };'])).toBe(
      'a fragment that starts inside an enclosing expression',
    );
  });

  it('keeps control-flow blocks, rendered subtrees, and multi-statement regions', () => {
    expect(region(['  for (const item of items) {', '    handle(item);', '  }'])).toBeNull();
    expect(region(['  if (!ready) {', '    warn();', '  }'])).toBeNull();
    expect(region(['      <Dialog open={open}>', '        <Body />', '      </Dialog>'])).toBeNull();
    expect(region(['  const a = first();', '', '  const b = second(a);'])).toBeNull();
    expect(region(['  await first();', '  await second();'])).toBeNull();
  });
});
