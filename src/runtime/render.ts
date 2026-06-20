/**
 * CLI rendering helpers — display-side formatting shared across commands.
 *
 * Two roles:
 *
 * 1. **Display-formatting utilities** (`displayLine`, `displayRange`,
 *    `displayPathRange`) — convert 0-indexed DB line numbers into
 *    1-indexed user-facing strings. Used inside formatItem callbacks.
 *
 * 2. **Renderer registry** (`render`) — five shared output shapes that
 *    cover the bulk of CLI commands: `empty`, `list`, `groupedByFile`,
 *    `sectionedReport`, `table`. Each command's `.action(...)` body
 *    becomes a thin "run query → pick a shape" wrapper.
 *
 * One module owns "how do we show line ranges, file:line refs, and the
 * five canonical output layouts to the user." A consumer who needs a
 * different format only changes one place.
 */

/** Convert a 0-indexed DB line number to a 1-indexed display line number. */
export function displayLine(line: number): number {
  return line + 1;
}

/** "{startDisplay}-{endDisplay}". Used after `file:` and as a stand-alone range. */
export function displayRange(startLine: number, endLine: number): string {
  return `${displayLine(startLine)}-${displayLine(endLine)}`;
}

/** "{relativePath}:{startDisplay}-{endDisplay}". The canonical "this is where the symbol lives" form. */
export function displayPathRange(relativePath: string, startLine: number, endLine: number): string {
  return `${relativePath}:${displayRange(startLine, endLine)}`;
}

/** A single section in a sectioned report. */
export interface ReportSection {
  /** Section banner text (rendered as `═══ {title} ═══`). Skipped if undefined. */
  title?: string;
  /** Optional explanation/sub-banner printed below the title before the rows. */
  explanation?: string;
  /** Rows printed verbatim under the title. */
  rows: string[];
  /** When true, the section is dropped if `rows` is empty. Default false (always render header + body, even if rows is empty). */
  skipIfEmpty?: boolean;
}

/**
 * Renderer registry — five shapes that cover most CLI command outputs.
 *
 * Each shape writes to `console.log` directly. Returning `void` keeps
 * `.action(...)` callers from wiring up "did anything print?" plumbing.
 */
export const render = {
  /** Empty-state: prints a single line. Match the EXACT current empty message per command. */
  empty(message: string): void {
    console.log(message);
  },

  /** One row per item, no grouping. Used by files/deps/rdeps/imported-by/members. */
  list<T>(items: readonly T[], formatItem: (item: T) => string): void {
    for (const item of items) {
      console.log(formatItem(item));
    }
  },

  /**
   * Items grouped by file, in input order; blank line between groups.
   * Within a group, the file header prints once, then each item via `formatItem`.
   *
   * The grouping key defaults to `item.relativePath` — items can either
   * carry that field directly (refs/isolated) or pass a custom `keyFn`
   * (redundant-reexports groups by `barrelFile`, drift groups by `file`).
   *
   * Used by refs/isolated/redundant-reexports/drift.
   */
  groupedByFile<T>(
    items: readonly T[],
    formatItem: (item: T) => string,
    keyFn: (item: T) => string = (item) => (item as { relativePath: string }).relativePath,
  ): void {
    let prevKey = '';
    for (const item of items) {
      const key = keyFn(item);
      if (key !== prevKey) {
        if (prevKey) console.log('');
        console.log(key);
        prevKey = key;
      }
      console.log(formatItem(item));
    }
  },

  /**
   * Title banners + body rows + optional explanations.
   * One blank line between sections; sections with `skipIfEmpty=true` and
   * no rows are dropped (default false: header still prints with empty body).
   * Used by trace/system/call-graph/dataflow.
   */
  sectionedReport(sections: readonly ReportSection[]): void {
    let first = true;
    for (const section of sections) {
      if (section.skipIfEmpty && section.rows.length === 0) continue;
      if (!first) console.log('');
      first = false;
      if (section.title !== undefined) console.log(`═══ ${section.title} ═══`);
      if (section.explanation !== undefined) console.log(section.explanation);
      for (const row of section.rows) console.log(row);
    }
  },

  /**
   * Aligned table with header. `headers` becomes the first row; the second
   * row is dashes — defaulting to one dash per header character, but
   * overridable via `dashWidths` when a body column is wider than its
   * header (e.g. a `LOC` column padded to 4 under a 3-char header).
   * Body rows print verbatim — the caller pads each cell, since alignment
   * width is column-specific.
   * Used by hotspots/bottlenecks/complexity-hotspots/kind-counts/top-fan-in/top-fan-out.
   */
  table(headers: readonly string[], rows: readonly string[], dashWidths?: readonly number[]): void {
    console.log(`  ${headers.join('  ')}`);
    const widths = dashWidths ?? headers.map((h) => h.length);
    console.log(`  ${widths.map((w) => '─'.repeat(w)).join('  ')}`);
    for (const row of rows) console.log(row);
  },
};
