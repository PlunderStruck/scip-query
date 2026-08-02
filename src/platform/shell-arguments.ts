const SAFE_UNQUOTED_ARGUMENT = /^[A-Za-z0-9_@%+=:,./-]+$/u;

export interface QuoteShellArgumentOptions {
  platform?: NodeJS.Platform;
  omitSafeQuotes?: boolean;
}

/** Quote one command argument for the current host shell. */
export function quoteShellArgument(value: string, options: QuoteShellArgumentOptions = {}): string {
  if (options.omitSafeQuotes && SAFE_UNQUOTED_ARGUMENT.test(value)) return value;
  if ((options.platform ?? process.platform) === 'win32') {
    return `"${value.replaceAll('%', '%%').replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
