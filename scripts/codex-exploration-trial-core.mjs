import { createHash } from 'node:crypto';

const COMMAND_BOUNDARY = String.raw`(?:^|[\s'";&|()])`;
const COMMAND_END = String.raw`(?=[\s'"]|$)`;
const SHELL_COMMAND_POSITION = String.raw`(?:^|(?:\|\||&&|[;|])\s*|(?:-lc|-c)\s+["']?)`;
const NATIVE_SEARCH = new RegExp(
  `${COMMAND_BOUNDARY}(?:rg|grep|find|fd|ls|tree|ps|pgrep|git\\s+(?:grep|ls-files))${COMMAND_END}`,
  'iu',
);
const NATIVE_READ = new RegExp(
  `${COMMAND_BOUNDARY}(?:cat|sed|awk|head|tail|nl|bat|less|more|perl|git\\s+show)${COMMAND_END}`,
  'iu',
);
const SCRIPTED_READ = /(?:readFile(?:Sync)?|read_text|\.read\(|open\s*\()/u;
const SCIP_QUERY = new RegExp(`${COMMAND_BOUNDARY}(?:[^\\s'"]*/)?scip-query${COMMAND_END}`, 'iu');
const MIXED_NATIVE_SEARCH = new RegExp(
  `${SHELL_COMMAND_POSITION}(?:rg|grep|find|fd|ls|tree|ps|pgrep|git\\s+(?:grep|ls-files))${COMMAND_END}`,
  'iu',
);
const MIXED_NATIVE_READ = new RegExp(
  `${SHELL_COMMAND_POSITION}(?:cat|sed|awk|head|tail|nl|bat|less|more|perl|git\\s+show)${COMMAND_END}`,
  'iu',
);

export function treatmentPrompt(question, _maxSemanticQueries = 4) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:

${question}

  Use scip-query as the only repository exploration surface for tracked nonbinary content. Do not use rg, grep, find, fd, ls, tree, cat, sed, awk, head, tail, nl, bat, less, more, perl, git show, git grep, git ls-files, Python/Node file reads, or direct source-reading tools. Do not edit files or inspect benchmark definitions, evaluation fixtures, rubrics, or recorded answers.

  The benchmark records semantic-query efficiency externally; no query count is a correctness cutoff. Never leave a known, recoverable material claim unresolved to reduce query count. Run scip-query capabilities only if current provider support is needed to choose a command; the skill already defines the ordinary workflow. A capabilities call and an unchanged scip-query continuation are transport/setup rather than semantic exploration. Never restart a running command or run a process-listing command to check it.

  Before querying, privately list the few material claims the answer must establish. Preserve behavior-changing predicates, authorization checks, data reshaping, hard bounds and defaults, runtime crossings, durable state changes, emitted notifications, returned values, relevant sibling outcomes, and externally visible ordering when the question depends on them. For dispatch, preserve precedence, eligibility, fallback, and exception conversion. For coordination, preserve owner lifetime, lock scope, and interruption behavior. A named constant is not an established value.

  Prefer one batched query to locate exact referents. Use search for trustworthy exact text, outline when the file is known, or entrypoints when the question begins at an external entry. If the first locator does not expose a referent capable of establishing a named material claim, issue the narrowest additional exact locator that can. Select exact symbols or file:line constructs yourself. Do not use deprecated anchor groups, selection terms, automatic routes, next-anchor scores, or system-map as a required phase.

  Batch compatible selected roots into a scip-query evidence call. The CLI requires repeated --edge flags, explicit --direction, --depth, and --max-edges; for example: scip-query evidence --symbol '<exact>' --edge execution --edge dataflow --direction both --depth 2 --max-edges 32. Explicitly choose incoming, outgoing, or both, and select only edge families or exact subtypes capable of establishing the material claims; never request complete, all, or every family merely to discover what exists. Include the initiating owner as a root, or select incoming execution when it must be discovered; do not assume a core type is the ingress. Use --connecting only when connectivity between roots is required. Keep graph projection separate from source materialization: do not add --include to a graph request; use one later batched inspect only for named behavioral gaps. Calls and exact runtime handoffs establish executable reachability. Data, state, temporal, contract, identity, ownership, and dependency edges establish their named relationships but do not become call claims. Read the inventory, provider provenance, evidence strength, coverage, unsupported gaps, and stable folds as part of the result; missing output is not evidence of absence. Run another projection only when the previous evidence exposes a new exact root or relationship needed by a still-unresolved claim.

  Stop as soon as every material claim is established, explicitly unsupported by the available providers, or justified as immaterial. Otherwise use a batched inspect --view behavior for exact unresolved constructs, then follow the narrowest printed fold, exact identity, code range, or additional projection that can close a still-material gap. Repeat only while a named claim remains unresolved and an exact in-scope recovery path exists. Never reread evidence already rendered, expand every frontier, or issue serial one-symbol queries when the roots can be batched. Before answering, audit the draft against the material claims; evidence seen but omitted from the answer is not recovered. If output emits Continue exactly:, run it unchanged until transport completes.

  Return a concise explanation with concrete symbol and file/line evidence and state any material coverage limitation.`;
}

export function minimalTreatmentPrompt(question) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:\n\n${question}\n\nUse scip-query as the only repository exploration surface for tracked nonbinary content. Do not use rg, grep, find, fd, ls, tree, cat, sed, awk, head, tail, nl, bat, git show, git grep, git ls-files, Python/Node file reads, or direct source-reading tools. Do not edit files. Do not inspect benchmark definitions, evaluation fixtures, rubrics, or recorded answers. First run scip-query status --capabilities once, then use whatever scip-query commands you judge necessary.\n\nReturn a concise explanation with concrete symbol and file/line evidence and state any material coverage limitation.`;
}

export function directGraphTreatmentPrompt(question) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:

${question}

Use scip-query as the only repository exploration surface for tracked nonbinary content. Do not use rg, grep, find, fd, ls, tree, cat, sed, awk, head, tail, nl, bat, less, more, perl, git show, git grep, git ls-files, Python/Node file reads, or direct source-reading tools. Do not edit files or inspect benchmark definitions, evaluation fixtures, rubrics, or recorded answers.

Before exploring the repository, read the scip-explore and scip-query SKILL.md instruction files once with cat. These two instruction reads are the only exemptions from the repository-source ban. scip-explore defines the investigation purpose, evidence ledger, and stopping rule; scip-query defines command and evidence semantics. Follow both.

First run scip-query status --capabilities once. There is no fixed semantic-query allowance. Continue while a material claim remains unresolved and an exact relevant recovery path is available; do not spend queries on facts that cannot change the answer, reread returned evidence, or treat a tool packet's completion as completion of the user's task. If output emits Continue exactly:, run it unchanged until transport completes.

Return a concise explanation with concrete symbol and file/line evidence and state any material coverage limitation.`;
}

export function controlPrompt(question) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:\n\n${question}\n\nDo not run scip-query. Explore the repository with the native shell search and source-reading tools you would normally use. Do not edit files. Return a concise explanation with concrete symbol and file/line evidence and state any material limitation.`;
}

export function disciplinedControlPrompt(question) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:\n\n${question}\n\nDo not run scip-query. Explore the repository with native shell search and source-reading tools. Do not edit files or inspect benchmark definitions, evaluation fixtures, rubrics, or recorded answers. Privately reduce the question to the few material claims the answer must establish. Locate the smallest relevant implementation owners, follow the direct entry-to-effect path, and treat source already returned as read. Batch independent searches and reads, avoid documentation, examples, tests, and unrelated helpers unless a named material gap requires them, and stop when every material claim is established. Before sending, audit the draft itself against those claims.\n\nReturn a concise explanation with concrete symbol and file/line evidence and state any material coverage limitation.`;
}

export function parseCodexJsonl(jsonl, metadata = {}) {
  const events = [];
  for (const [index, line] of jsonl.split(/\r?\n/u).entries()) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `invalid Codex JSONL event on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const calls = [];
  let answer = '';
  let usage;
  let threadId;
  for (const event of events) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
    if (event.type === 'turn.completed') usage = parseUsage(event.usage);
    if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') continue;
    if (event.item.type === 'agent_message' && typeof event.item.text === 'string') answer = event.item.text;
    if (!['command_execution', 'shell_command'].includes(event.item.type)) continue;
    const command = commandText(event.item.command);
    const output = outputText(event.item);
    calls.push({
      ...classifyExplorationCommand(command),
      command,
      output: '',
      outputCharacters: output.length,
      outputSha256: createHash('sha256').update(output).digest('hex'),
      preconditionRefusal: /NAVIGATION MAP REQUIRED|NAVIGATION MAP ALREADY RUNNING|MAP TRANSPORT INCOMPLETE/u.test(
        output,
      ),
      exitCode: Number.isSafeInteger(event.item.exit_code) ? event.item.exit_code : null,
    });
  }

  if (answer.trim() === '') throw new Error('Codex JSONL contained no completed agent answer');
  if (!usage) throw new Error('Codex JSONL contained no turn.completed usage');
  return {
    ...metadata,
    answer,
    calls,
    usage,
    codexThreadId: threadId ?? null,
    rawEventCount: events.length,
  };
}

export function classifyExplorationCommand(command) {
  if (isSkillInstructionRead(command)) return { surface: 'other', kind: 'other' };
  const scipQuery = SCIP_QUERY.test(command);
  // Classify the primary exploration surface before scanning its quoted
  // arguments. Natural-language anchor questions can contain words such as
  // "find" without executing the native find command.
  if (scipQuery) {
    if (MIXED_NATIVE_SEARCH.test(command)) return { surface: 'native-search', kind: 'query' };
    if (MIXED_NATIVE_READ.test(command)) return { surface: 'native-read', kind: 'query' };
    if (/\bscip-query\s+status\b/iu.test(command)) return { surface: 'scip-query', kind: 'status' };
    if (/\bscip-query\s+continue\b/iu.test(command) || /--output-cursor\b/u.test(command)) {
      return { surface: 'scip-query', kind: 'continuation' };
    }
    return { surface: 'scip-query', kind: 'query' };
  }
  if (NATIVE_SEARCH.test(command)) return { surface: 'native-search', kind: 'query' };
  if (NATIVE_READ.test(command) || SCRIPTED_READ.test(command)) return { surface: 'native-read', kind: 'query' };
  return { surface: 'other', kind: 'other' };
}

function isSkillInstructionRead(command) {
  const fileOperands = command.match(/skills\/[A-Za-z0-9_.:-]+\/SKILL\.md/giu) ?? [];
  if (fileOperands.length === 0) return false;
  const withoutSkillPaths = fileOperands.reduce((remaining, operand) => remaining.replace(operand, ' '), command);
  return !/(?:^|\s)(?:src|tests|scripts|docs|benchmarks)\//u.test(withoutSkillPaths);
}

function commandText(value) {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (Array.isArray(value) && value.length > 0) return value.map(String).join(' ');
  throw new Error('completed command event has no command text');
}

function outputText(item) {
  for (const value of [item.aggregated_output, item.output, item.stdout]) {
    if (typeof value === 'string') return value;
  }
  return '';
}

function parseUsage(value) {
  if (!value || typeof value !== 'object') throw new Error('turn.completed has no usage object');
  return {
    inputTokens: tokenCount(value.input_tokens, 'input_tokens'),
    cachedInputTokens: tokenCount(value.cached_input_tokens, 'cached_input_tokens'),
    outputTokens: tokenCount(value.output_tokens, 'output_tokens'),
    reasoningOutputTokens: tokenCount(value.reasoning_output_tokens, 'reasoning_output_tokens'),
  };
}

function tokenCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid Codex usage ${label}`);
  return value;
}
