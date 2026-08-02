import type { CommandOperationSelector } from '../command-operation.js';
import type { CommandClaimContract } from '../claim-qualification.js';

export type CommandOptionParser = (value: string, previous: unknown) => unknown;
export type CommandHandler = (...args: unknown[]) => void | Promise<void>;

export interface CommandArgumentDescriptor {
  name: string;
}

export interface CommandOptionDescriptor {
  flags: string;
  description: string;
  parser?: CommandOptionParser;
  defaultValue?: unknown;
}

export interface CommandDocumentation {
  category: string;
  examples?: readonly string[];
}

export interface CommandHeuristicNotice {
  label: string;
}

export type CommandBudgetPolicy = 'none' | 'semantic' | 'candidate-scan';
export type CommandRenderShape = 'custom' | 'empty' | 'list' | 'grouped-by-file' | 'sectioned-report' | 'table';
export type CommandEvidenceTier = 'graph-fact' | 'heuristic' | 'mixed';

/**
 * How much of the available answer a command examines by default.
 *
 * Independent of `CommandEvidenceTier`, which says how a result was *derived*.
 * A heuristic scan can be `complete`; a graph-fact query can be `bounded`.
 * `heuristic` is therefore not a coverage value — keep the two fields separate.
 *
 * This is the DEFAULT policy only. What actually happened on one invocation
 * depends on `--full`, index size, and analysis budgets, so it is reported at
 * runtime by the handler (see `InvocationCoverage`) rather than inferred here.
 */
export type CoveragePolicy =
  /** The default result is the whole answer. */
  | 'complete'
  /** A cap may engage; the invocation must disclose whether it did. */
  | 'bounded'
  /** Deliberately examines a subset (sampling is the point of the command). */
  | 'sampled'
  /** The command cannot currently determine its own coverage. Honest, not a placeholder. */
  | 'unknown';

/**
 * Positional input kinds, in declaration order. A list rather than one target
 * union because the command set does not fit a single value: `similar <a> <b>`
 * is two symbols, `coupling <f1> <f2>` two files, `tla <operation> [spec]` an
 * action plus a path, and `hotspots` takes nothing.
 */
export type CommandInputKind = 'symbol' | 'file' | 'module' | 'pattern' | 'path' | 'action' | 'finding' | 'record';

/**
 * What a command reads when it is given no target: the working-tree diff, or
 * the whole index. Kept separate from `CommandInputKind` because these are not
 * positional — `diff-impact` names no argument yet plainly operates on something,
 * and collapsing the two makes the arity of a signature unstateable.
 */
export type CommandScope = 'diff' | 'repository';

export interface InvocationContinuation {
  /** Resume token bound to the exact command inputs and result ordering. */
  cursor: string;
  /** Index generation against which the resume token is valid. */
  indexGeneration: string;
}

export interface InvocationResolution {
  /** Symbol-selection truth, independent from result enumeration and transport pagination. */
  state: 'exact' | 'ambiguous' | 'missing';
  totalCandidates: number;
}

interface InvocationCoverageBase {
  /** Number of result units returned by this invocation. */
  returned: number;
  resolution?: InvocationResolution;
}

/**
 * What one invocation can prove about the result it returned.
 *
 * Known-complete coverage names the entire answer and therefore has no
 * omissions or continuation. Known-incomplete coverage names a strict subset
 * of a known total. Unknown coverage cannot claim counts or identities it did
 * not establish.
 */
export type InvocationCoverage = InvocationCoverageBase &
  (
    | {
        complete: true;
        totalKnown: true;
        total: number;
        omitted: 0;
        omittedIdentities?: never;
        continuation?: never;
      }
    | {
        complete: false;
        totalKnown: true;
        total: number;
        omitted: number;
        omittedIdentities?: readonly string[];
        continuation?: InvocationContinuation;
      }
    | {
        complete: false | null;
        totalKnown: false;
        total?: never;
        omitted?: never;
        omittedIdentities?: never;
        continuation?: InvocationContinuation;
      }
  );

export type CommandResultUnitPolicy = { kind: 'rows' } | { kind: 'report' } | { kind: 'field'; field: string };

/**
 * One positional slot. An array means the slot accepts any of those kinds —
 * `context <target>` takes a symbol, a file, or a module.
 *
 * Arity is deliberately not encoded here: `command` already distinguishes
 * `<required>` from `[optional]`, and duplicating it would let the two drift.
 */
export type CommandInputSlot = CommandInputKind | readonly CommandInputKind[];

/**
 * What an agent needs to know before choosing this command: which questions it
 * settles, what units come back, and how complete the default answer is.
 *
 * Distinct from `description` (human prose) and `evidence` (provenance). This
 * is the source the generated skill tables read, so agents and docs cannot
 * drift from each other.
 */
export interface CommandAgentContract {
  /** Task questions this command settles, phrased as an agent would ask them. */
  answers: readonly string[];
  /** Concrete units in the result (e.g. 'referencing file paths'). */
  returns: readonly string[];
  /** Positional input slots, in order. Must match the arity declared in `command`. */
  inputs: readonly CommandInputSlot[];
  /**
   * What the command reads with no target given. Required when `inputs` is
   * empty, and also set on commands whose target is optional (`co-change
   * [file]` falls back to repository-wide).
   */
  scope?: CommandScope;
  /** Default coverage policy; the invocation reports what actually happened. */
  coverage: CoveragePolicy;
  /**
   * Observable effect selected from parsed arguments/options. This is
   * independent from evidence origin and result coverage.
   */
  operation: CommandOperationSelector;
  /**
   * Descriptor-owned semantic unit extraction. When omitted, registration
   * derives rows vs. one report from the descriptor's render shape.
   */
  resultUnits?: CommandResultUnitPolicy;
  /** Neighbouring commands this one is commonly confused with. */
  contrasts?: readonly { command: string; distinction: string }[];
}

export interface CommandDescriptor {
  id: string;
  command: string;
  description: string;
  /** Additional plain-text examples or mode guidance shown after --help. */
  helpAfter?: string;
  hidden?: boolean;
  arguments?: readonly CommandArgumentDescriptor[];
  options?: readonly CommandOptionDescriptor[];
  evidence?: CommandEvidenceTier;
  /**
   * Producer facts used to qualify claims. Commands with one evidence origin
   * receive a conservative generated contract; mixed commands must declare
   * the result families that keep their origins distinguishable.
   */
  claims?: CommandClaimContract;
  /** Agent-facing return/coverage contract. Required for public commands — see cli-contract. */
  agent?: CommandAgentContract;
  heuristic?: CommandHeuristicNotice;
  budget?: CommandBudgetPolicy;
  renderShape: CommandRenderShape;
  docs?: CommandDocumentation;
  handler: CommandHandler;
}
