import { createHash } from 'node:crypto';

const COMMAND_BOUNDARY = String.raw`(?:^|[\s'";&|()])`;
const COMMAND_END = String.raw`(?=[\s'"]|$)`;
const SHELL_COMMAND_POSITION = String.raw`(?:^|(?:\|\||&&|[;|])\s*|(?:-lc|-c)\s+["']?)`;
const NATIVE_SEARCH = new RegExp(
  `${COMMAND_BOUNDARY}(?:rg|grep|find|fd|ls|tree|git\\s+(?:grep|ls-files))${COMMAND_END}`,
  'iu',
);
const NATIVE_READ = new RegExp(
  `${COMMAND_BOUNDARY}(?:cat|sed|awk|head|tail|nl|bat|less|more|perl|git\\s+show)${COMMAND_END}`,
  'iu',
);
const SCRIPTED_READ = /(?:readFile(?:Sync)?|read_text|\.read\(|open\s*\()/u;
const SCIP_QUERY = new RegExp(`${COMMAND_BOUNDARY}(?:[^\\s'"]*/)?scip-query${COMMAND_END}`, 'iu');
const MIXED_NATIVE_SEARCH = new RegExp(
  `${SHELL_COMMAND_POSITION}(?:rg|grep|find|fd|ls|tree|git\\s+(?:grep|ls-files))${COMMAND_END}`,
  'iu',
);
const MIXED_NATIVE_READ = new RegExp(
  `${SHELL_COMMAND_POSITION}(?:cat|sed|awk|head|tail|nl|bat|less|more|perl|git\\s+show)${COMMAND_END}`,
  'iu',
);

export function treatmentPrompt(question) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:

${question}

Use scip-query as the only repository exploration surface for tracked nonbinary content. Do not use rg, grep, find, fd, ls, tree, cat, sed, awk, head, tail, nl, bat, git show, git grep, git ls-files, Python/Node file reads, or direct source-reading tools. Do not edit files. Do not inspect benchmark definitions, evaluation fixtures, rubrics, or recorded answers.

First run scip-query status --capabilities once. Privately reduce the question to the few material claims the answer must establish. For an end-to-end explanation, material facts include every relevant behavior-changing predicate, authorization check, data reshaping, hard bound, runtime crossing, durable state change, emitted notification, and returned value on the selected causal path; preserve them in the answer instead of summarizing them away. For a multi-step mutation, preserve external-effect order plus compaction, rollback, or cleanup. For every event, log, or outbox write, preserve its operation kind and record-identity fields. For coordination, state the lock's scope and which read/check/write steps occur inside it. For interrupted-update behavior, state whether the sequence is atomic, prevented, rolled back, or repaired later.

Use exactly one initial locator. Use search only when the question quotes an exact source/runtime literal or supplies an exact compiler symbol; an unquoted domain term, feature name, or command name is not an exact selector. Otherwise run scip-query anchors with the complete question as one shell-safely quoted positional argument; there is no --question option. Anchor discovery mechanically joins normalized repository words to compiler owners and bounded call relationships; its ranking is navigation help, not a claim that a set answers the question. For a cross-process or cross-protocol causal sequence, choose the first cross-boundary-flow whose displayed producer, runtime key, and downstream owner match the requested operation. Otherwise choose the smallest connected-flow set that covers the sequence. For an exhaustive "which operations/callers can" question, choose the smallest shared-callee-owners set that covers the candidate sibling owners; common callees do not by themselves prove state-changing effects. Run the chosen set's printed system-map command unchanged. The map labels exact causal targets as upstream callers, downstream callees, result-producing callbacks, or runtime producers/consumers without claiming they all matter. If one corresponds to a named missing material fact, include its printed location in the one batched gap inspect after the map. Do not run inspect, evidence, code, or command help before the map. A source-owned search identity remains --search; use --symbol only for a printed compiler identity, and never pass the same loose term to both selectors.

The map's connected behavior is already source evidence: compare its lines and transitions with the material claims and stop immediately when they establish all of them. Before any gap query, make a private evidence ledger for every explicit anchor. Preserve every relevant sibling branch outcome shown under an anchor; sibling branches are jointly required behavior, not alternative search results. Optional causal recovery is folded by default. Only if one material claim is absent may you name that exact gap plus the specific printed upstream caller, downstream callee, result callback, or runtime participant that can establish it. Resolve category-changing gaps first—process versus cross-process, atomic versus later repair, durable versus merely written—before adding detail to behavior already established. Use exact printed targets directly in one batched inspect --view behavior command. Use --gap-callee / --gap-recovery-only only for an additional or ambiguous target whose exact location was not printed. If inspect requires behavior focus, use interior file:line locations already visible in the map; do not use --full, and do not treat the refusal itself as missing task evidence. Do not override an exact-source materialization refusal unless omitted syntax itself can change the decision. Do not enumerate helpers, implementation families, examples, tests, or unrelated frontiers. The normal allowance is one locator, one map, and one scoped gap batch. Treat exact edges as facts only within reported coverage and candidates as leads. Before sending, audit the draft itself against the material claims: evidence seen but left implicit is not recovered, and returned file/line identities must be copied exactly rather than reconstructed. If output emits Continue exactly:, run it unchanged.

Return a concise explanation with concrete symbol and file/line evidence and state any material coverage limitation.`;
}

export function minimalTreatmentPrompt(question) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:\n\n${question}\n\nUse scip-query as the only repository exploration surface for tracked nonbinary content. Do not use rg, grep, find, fd, ls, tree, cat, sed, awk, head, tail, nl, bat, git show, git grep, git ls-files, Python/Node file reads, or direct source-reading tools. Do not edit files. Do not inspect benchmark definitions, evaluation fixtures, rubrics, or recorded answers. First run scip-query status --capabilities once, then use whatever scip-query commands you judge necessary.\n\nReturn a concise explanation with concrete symbol and file/line evidence and state any material coverage limitation.`;
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
