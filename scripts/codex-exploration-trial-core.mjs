import { createHash } from 'node:crypto';

const COMMAND_BOUNDARY = String.raw`(?:^|[\s'";&|()])`;
const COMMAND_END = String.raw`(?=[\s'"]|$)`;
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

export function treatmentPrompt(question) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:\n\n${question}\n\nUse scip-query as the only repository exploration surface for tracked nonbinary content. Do not use rg, grep, find, fd, ls, tree, cat, sed, awk, head, tail, nl, bat, git show, git grep, git ls-files, Python/Node file reads, or direct source-reading tools. Do not edit files. Do not inspect benchmark definitions, evaluation fixtures, rubrics, or recorded answers.\n\nFirst run scip-query status --capabilities once. Privately reduce the question to the few material claims the answer must establish. For an end-to-end explanation, material facts include every relevant behavior-changing predicate, authorization check, data reshaping, hard bound, runtime crossing, durable state change, emitted notification, and returned value on the selected causal path; preserve them in the answer instead of summarizing them away. Use at most one locating search to identify the smallest independent exact owners, then make system-map the first graph/detail operation. A source-owned search identity remains --search; use --symbol only for a printed compiler identity, and never pass the same loose term to both selectors. Do not run inspect, evidence, code, or command help before the map. The map's connected behavior is already source evidence: compare its lines and transitions with the material claims and stop immediately when they establish all of them. If one material claim is absent, name that exact gap and use one batched inspect (with repeated --symbol or --at flags) or exact-source query capable of resolving it. Do not enumerate helpers, implementation families, examples, tests, or unrelated frontiers. The normal allowance is one locating query, one map, and at most one batched gap query; exceed it only when the latest evidence explicitly leaves another material claim unresolved. Treat exact edges as facts only within reported coverage and candidates as leads. Before sending, audit the draft itself against the material claims: evidence seen but left implicit is not recovered, and returned file/line identities must be copied exactly rather than reconstructed. If output emits Continue exactly:, run it unchanged.\n\nReturn a concise explanation with concrete symbol and file/line evidence and state any material coverage limitation.`;
}

export function controlPrompt(question) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:\n\n${question}\n\nDo not run scip-query. Explore the repository with the native shell search and source-reading tools you would normally use. Do not edit files. Return a concise explanation with concrete symbol and file/line evidence and state any material limitation.`;
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
  if (NATIVE_SEARCH.test(command)) return { surface: 'native-search', kind: 'query' };
  if (NATIVE_READ.test(command) || SCRIPTED_READ.test(command)) return { surface: 'native-read', kind: 'query' };
  if (!scipQuery) return { surface: 'other', kind: 'other' };
  if (/\bscip-query\s+status\b/iu.test(command)) return { surface: 'scip-query', kind: 'status' };
  if (/\bscip-query\s+continue\b/iu.test(command) || /--output-cursor\b/u.test(command)) {
    return { surface: 'scip-query', kind: 'continuation' };
  }
  return { surface: 'scip-query', kind: 'query' };
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
