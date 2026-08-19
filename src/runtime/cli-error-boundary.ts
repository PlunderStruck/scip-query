export interface CliErrorBoundaryOptions {
  debug?: boolean;
}

/** Convert an otherwise uncaught CLI failure into one concise terminal diagnostic. */
export async function runCliWithErrorBoundary(
  run: () => Promise<void>,
  opts: CliErrorBoundaryOptions = {},
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`error: ${message}`);
    if ((opts.debug ?? process.env['SCIP_QUERY_DEBUG'] !== undefined) && error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}
