#!/usr/bin/env node
/* global process */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

const EVIDENCE_DIR_ENV = 'SCIP_EXPLORE_EVIDENCE_DIR';
const MAX_PROJECTION_CHARACTERS = 32_000;
const SAFE_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
const FORBIDDEN_OUTPUT_ARGUMENTS = [
  '--agent-output',
  '--json',
  '--json-output',
  '--output-cursor',
  '--output-page-size',
  '--raw-json',
];

main();

function main() {
  const { id, queryArgs } = parseArguments(process.argv.slice(2));
  const configuredRoot = process.env[EVIDENCE_DIR_ENV];
  if (!configuredRoot) fail(`${EVIDENCE_DIR_ENV} is not set.`);
  const evidenceRoot = resolve(configuredRoot);
  mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
  const rawPath = join(evidenceRoot, `${id}.json`);
  const receiptPath = join(evidenceRoot, `${id}.receipt.json`);
  if (existsSync(rawPath) || existsSync(receiptPath)) fail(`Evidence id already exists: ${id}`);

  for (const argument of queryArgs) {
    if (FORBIDDEN_OUTPUT_ARGUMENTS.some((flag) => argument === flag || argument.startsWith(`${flag}=`))) {
      fail(`The capture wrapper owns ${argument.split('=', 1)[0]}; remove it from the scip-query arguments.`);
    }
  }

  const priorReceipts = readPriorReceipts(evidenceRoot);
  const reusableReceipts = receiptsForLatestObservation(priorReceipts);
  const request = requestIdentity(queryArgs);
  const reuse = findReusableObservation(request, reusableReceipts);
  if (reuse) {
    process.stdout.write(
      `${JSON.stringify({
        kind: 'scip-explore-evidence-reuse',
        schemaVersion: 1,
        requestedId: id,
        status: 'already-captured',
        request,
        existingReceiptIds: reuse.receiptIds,
        rawEvidence: reuse.rawEvidence,
        recovery: 'Reuse the named receipt ids in the ledger; do not rerun this observation.',
      })}\n`,
    );
    return;
  }

  const overlap = findOverlappingCodeRanges(request, reusableReceipts);
  if (overlap) {
    process.stdout.write(
      `${JSON.stringify({
        kind: 'scip-explore-evidence-reuse',
        schemaVersion: 1,
        requestedId: id,
        status: 'overlap-requires-uncovered-query',
        request,
        existingReceiptIds: overlap.receiptIds,
        uncoveredSelectors: overlap.uncoveredSelectors,
        recovery:
          'The requested code ranges overlap delivered evidence. Capture only the uncovered selectors under a new id; do not reread covered bytes.',
      })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const execution = spawnSync('scip-query', [...queryArgs, '--json', '--json-output', rawPath], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  if (execution.error) fail(execution.error.message);
  if (execution.status !== 0) {
    fail((execution.stderr || execution.stdout || `scip-query exited ${execution.status}`).trim());
  }

  const exportReceipt = parseLastJsonLine(execution.stdout, 'scip-query export receipt');
  if (!isAbsolute(exportReceipt.path) || resolve(exportReceipt.path) !== rawPath) {
    fail('scip-query wrote the evidence packet to an unexpected path.');
  }
  const envelope = JSON.parse(readFileSync(rawPath, 'utf8'));
  const projection = projectCommandResult(envelope);
  if (projection.status !== 'complete') {
    const refusal = {
      kind: 'scip-explore-evidence-receipt',
      schemaVersion: 1,
      id,
      command: envelope.command,
      request,
      rawEvidence: {
        path: rawPath,
        bytes: exportReceipt.bytes,
        sha256: exportReceipt.sha256,
      },
      status: projection.status,
      coverage: envelope.coverage,
      recovery: projection.recovery,
    };
    writeFileSync(receiptPath, `${JSON.stringify(refusal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify(refusal)}\n`);
    process.exitCode = 2;
    return;
  }
  const receipt = {
    kind: 'scip-explore-evidence-receipt',
    schemaVersion: 1,
    id,
    command: envelope.command,
    request,
    rawEvidence: {
      path: rawPath,
      bytes: exportReceipt.bytes,
      sha256: exportReceipt.sha256,
    },
    observation: {
      ...(envelope.operationRole === undefined ? {} : { operationRole: envelope.operationRole }),
      ...(envelope.evidence === undefined ? {} : { evidence: envelope.evidence }),
      args: envelope.args,
      coverage: envelope.coverage,
      ...(envelope.evidenceContext === undefined
        ? {}
        : { evidenceCalibration: projectEvidenceCalibration(envelope.evidenceContext, priorReceipts) }),
      result: projection.result,
    },
  };
  const serialized = JSON.stringify(receipt);
  if (serialized.length > MAX_PROJECTION_CHARACTERS) {
    const refusal = {
      kind: 'scip-explore-evidence-receipt',
      schemaVersion: 1,
      id,
      command: envelope.command,
      rawEvidence: receipt.rawEvidence,
      projectionCharacters: serialized.length,
      status: 'projection-too-large',
      recovery: `Narrow the query so its agent projection is at most ${MAX_PROJECTION_CHARACTERS} characters; use a new evidence id.`,
    };
    writeFileSync(receiptPath, `${JSON.stringify(refusal, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`${JSON.stringify(refusal)}\n`);
    process.exitCode = 2;
    return;
  }

  writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${serialized}\n`);
}

function projectCommandResult(envelope) {
  if (envelope.command === 'inspect') return projectInspectResult(envelope.result);
  if (envelope.command !== 'search') return { status: 'complete', result: envelope.agentResult ?? envelope.result };

  const result = envelope.result;
  const identityCoverage = result?.identityCoverage;
  const identities = result?.identities;
  const scopeHints = result?.scopeHints;
  const commandProjectionComplete =
    Array.isArray(identities) &&
    identityCoverage?.mode === 'complete' &&
    identityCoverage.omitted === 0 &&
    identityCoverage.returned === identities.length &&
    identityCoverage.total === identities.length;
  const exhaustivePacketComplete =
    Array.isArray(identities) &&
    Number.isSafeInteger(identityCoverage?.total) &&
    identities.length === identityCoverage.total &&
    result.matchingLines === identityCoverage.total;
  const identitiesComplete = commandProjectionComplete || exhaustivePacketComplete;
  const scopeHintsComplete = Array.isArray(scopeHints) && result.omittedScopeHints === 0;
  if (!identitiesComplete || !scopeHintsComplete) {
    return {
      status: 'incomplete-locator-projection',
      recovery:
        'The exhaustive packet did not contain a complete search identity and scope-hint manifest. Narrow the exact query or scope, or follow the command-owned recovery until coverage is complete.',
    };
  }

  return {
    status: 'complete',
    result: {
      kind: 'complete-search-identity-manifest',
      schemaVersion: 1,
      pattern: result.pattern,
      mode: result.mode,
      matchingLines: result.matchingLines,
      matchingFiles: result.matchingFiles,
      identityCoverage: commandProjectionComplete
        ? identityCoverage
        : {
            mode: 'complete-exhaustive-packet',
            returned: identities.length,
            total: identities.length,
            omitted: 0,
            commandProjection: identityCoverage,
          },
      identityManifest: groupSearchIdentities(identities),
      scopeHints,
      scopeHintCoverage: {
        returned: scopeHints.length,
        omitted: result.omittedScopeHints,
      },
      scannedFiles: result.scannedFiles,
      textCoverage: compactTextCoverage(result.textCoverage),
      sourceMaterialization: {
        state: 'stored-in-raw-packet',
        excludedFromReceipt: true,
        reason: 'Search locates exact roots; inspect or code establishes behavior for a named gap.',
      },
    },
  };
}

function groupSearchIdentities(identities) {
  const files = new Map();
  for (const identity of identities) {
    const fileKey = JSON.stringify([identity.relativePath, identity.fileKind, identity.freshness]);
    let file = files.get(fileKey);
    if (!file) {
      file = {
        relativePath: identity.relativePath,
        fileKind: identity.fileKind,
        freshness: compactFreshness(identity.freshness),
        owners: new Map(),
      };
      files.set(fileKey, file);
    }
    const ownerKey = JSON.stringify([
      identity.ownerSymbol,
      identity.ownerShort,
      identity.ownerStartLine,
      identity.ownerEndLine,
    ]);
    let owner = file.owners.get(ownerKey);
    if (!owner) {
      owner = {
        ownerSymbol: identity.ownerSymbol,
        ownerShort: identity.ownerShort,
        ownerStartLine: identity.ownerStartLine,
        ownerEndLine: identity.ownerEndLine,
        focusLines: [],
      };
      file.owners.set(ownerKey, owner);
    }
    owner.focusLines.push(identity.focusLine);
  }

  return {
    encoding: 'grouped-file-owner-lines/v1',
    identities: identities.length,
    files: [...files.values()]
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath))
      .map((file) => ({
        relativePath: file.relativePath,
        fileKind: file.fileKind,
        freshness: file.freshness,
        owners: [...file.owners.values()]
          .map((owner) => ({ ...owner, focusLines: [...owner.focusLines].sort((left, right) => left - right) }))
          .sort(
            (left, right) =>
              (left.ownerStartLine ?? Number.MAX_SAFE_INTEGER) - (right.ownerStartLine ?? Number.MAX_SAFE_INTEGER) ||
              String(left.ownerSymbol ?? '').localeCompare(String(right.ownerSymbol ?? '')),
          ),
      })),
  };
}

function compactFreshness(freshness) {
  return {
    exactText: freshness?.exactText?.state ?? 'unknown',
    semantic: freshness?.semantic?.state ?? 'unknown',
    verboseProof: 'stored-in-raw-packet',
  };
}

function compactTextCoverage(coverage) {
  if (!coverage) return coverage;
  const binaryPaths = Array.isArray(coverage.skippedBinaryPaths) ? coverage.skippedBinaryPaths : [];
  return {
    basis: coverage.basis,
    candidateFiles: coverage.candidateFiles,
    scannedTextFiles: coverage.scannedTextFiles,
    scannedBytes: coverage.scannedBytes,
    skippedBinary: {
      count: binaryPaths.length,
      sha256: sha256(JSON.stringify(binaryPaths)),
      paths: 'stored-in-raw-packet',
    },
    skippedUnreadablePaths: coverage.skippedUnreadablePaths,
    skippedOversizedPaths: coverage.skippedOversizedPaths,
    semanticFiles: coverage.semanticFiles,
  };
}

function projectInspectResult(result) {
  if (!result || !Array.isArray(result.slices) || !Array.isArray(result.units) || !result.packetCoverage) {
    return {
      status: 'incomplete-inspect-projection',
      recovery:
        'The exhaustive inspect packet did not expose exact slices, unit metadata, and a packet coverage contract. Use a narrower exact selector under a new evidence id.',
    };
  }

  return {
    status: 'complete',
    result: {
      kind: 'bounded-inspect-behavior-projection',
      schemaVersion: 1,
      view: result.view,
      locations: result.locations,
      searches: result.searches,
      slices: result.slices,
      units: result.units.map(compactInspectUnit),
      bindingClosure: result.bindingClosure,
      packetCoverage: result.packetCoverage,
      omissionGroups: result.omissionGroups,
      continuation: result.continuation,
      causalFrontier: compactCausalFrontier(result.causalFrontier),
      stoppingSummary: result.stoppingSummary,
      externalizedFields: {
        state: 'stored-in-raw-packet',
        fields: [
          'units[].source',
          'units[].behavior.lines',
          'causalFrontier.*[].id',
          'causalFrontier.*[].callsite.text',
          'causalFrontier.withheldAnchors[]',
        ],
        reason:
          'Exact source is present once in slices; duplicate behavioral lines and withheld frontier leads remain checksum-addressed in the exhaustive packet with exact recovery commands in the receipt.',
      },
    },
  };
}

function compactInspectUnit(unit) {
  const behavior = unit.behavior;
  return {
    kind: unit.kind,
    relativePath: unit.relativePath,
    startLine: unit.startLine,
    endLine: unit.endLine,
    focusLine: unit.focusLine,
    unitType: unit.unitType,
    unitStartLine: unit.unitStartLine,
    unitEndLine: unit.unitEndLine,
    omittedLines: unit.omittedLines,
    reasons: unit.reasons,
    focusLines: unit.focusLines,
    ownerSymbol: unit.ownerSymbol,
    ownerShort: unit.ownerShort,
    roles: unit.roles,
    symbols: unit.symbols,
    id: unit.id,
    omittedCharacters: unit.omittedCharacters,
    ...(behavior
      ? {
          behavior: {
            callable: behavior.callable,
            representation: behavior.representation,
            constructKind: behavior.constructKind,
            signature: behavior.signature,
            signals: behavior.signals,
            testCases: behavior.testCases,
            coverage: behavior.coverage,
            rawCharacters: behavior.rawCharacters,
            outlineCharacters: behavior.outlineCharacters,
            candidateLines: behavior.candidateLines,
            omittedLines: behavior.omittedLines,
          },
        }
      : {}),
  };
}

function compactCausalFrontier(frontier) {
  if (!frontier) return frontier;
  return {
    anchors: Array.isArray(frontier.anchors) ? frontier.anchors.map(compactFrontierAnchor) : [],
    withheldAnchorManifest: {
      count: Array.isArray(frontier.withheldAnchors) ? frontier.withheldAnchors.length : 0,
      state: 'stored-in-raw-packet',
      recovery: 'Use remainingInspectCommands only when a named material claim depends on a withheld frontier.',
    },
    candidateAnchors: frontier.candidateAnchors,
    omittedAnchors: frontier.omittedAnchors,
    scannedBehaviorSteps: frontier.scannedBehaviorSteps,
    visibleCallsites: frontier.visibleCallsites,
    graphEvidencedCallsites: frontier.graphEvidencedCallsites,
    identityCandidateCallsites: frontier.identityCandidateCallsites,
    ambiguousCallsites: frontier.ambiguousCallsites,
    unresolvedCallsites: frontier.unresolvedCallsites,
    upstreamCandidates: frontier.upstreamCandidates,
    resultCandidates: frontier.resultCandidates,
    runtimeCandidates: frontier.runtimeCandidates,
    inspectCommand: frontier.inspectCommand,
    remainingInspectCommands: frontier.remainingInspectCommands,
  };
}

function compactFrontierAnchor(anchor) {
  return {
    status: anchor.status,
    direction: anchor.direction,
    causalRole: anchor.causalRole,
    relationKind: anchor.relationKind,
    callsite: anchor.callsite
      ? {
          file: anchor.callsite.file,
          line: anchor.callsite.line,
          endLine: anchor.callsite.endLine,
          calleeLeaf: anchor.callsite.calleeLeaf,
        }
      : null,
    alternatives: Array.isArray(anchor.alternatives)
      ? anchor.alternatives.map((alternative) => ({
          label: alternative.label,
          file: alternative.file,
          line: alternative.line,
          endLine: alternative.endLine,
        }))
      : [],
    alternativeCount: anchor.alternativeCount,
    evidenceStrengths: Array.isArray(anchor.evidence)
      ? [...new Set(anchor.evidence.map((evidence) => evidence.strength))]
      : [],
  };
}

function projectEvidenceCalibration(context, priorReceipts) {
  const stableObservation = context.receipt
    ? {
        schemaVersion: context.receipt.schemaVersion,
        facts: context.receipt.facts,
        observedSources: context.receipt.observedSources,
        stabilityProofs: context.receipt.stabilityProofs,
        ...(context.receipt.diagnostics === undefined ? {} : { diagnostics: context.receipt.diagnostics }),
      }
    : null;
  const observationIdentity = stableObservation ? sha256(JSON.stringify(stableObservation)) : null;
  const priorObservation = observationIdentity ? findPriorObservation(priorReceipts, observationIdentity) : null;
  return {
    operationRole: context.operationRole,
    analysisManifest: context.analysisManifest,
    ...(observationIdentity ? { observationIdentity: { sha256: observationIdentity } } : {}),
    ...(stableObservation && priorObservation === null
      ? {
          observation: {
            ...stableObservation,
            observedAt: context.receipt.observedAt,
          },
        }
      : {}),
    ...(priorObservation
      ? {
          observationReference: {
            receiptId: priorObservation.receiptId,
            sha256: observationIdentity,
            schemaVersion: stableObservation.schemaVersion,
            observedAt: context.receipt.observedAt,
          },
        }
      : {}),
  };
}

function requestIdentity(queryArgs) {
  return {
    schemaVersion: 1,
    args: queryArgs,
    sha256: sha256(JSON.stringify(queryArgs)),
  };
}

function readPriorReceipts(evidenceRoot) {
  return readdirSync(evidenceRoot)
    .filter((name) => name.endsWith('.receipt.json'))
    .sort()
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(join(evidenceRoot, name), 'utf8'))];
      } catch {
        return [];
      }
    });
}

function receiptsForLatestObservation(priorReceipts) {
  const observed = priorReceipts.flatMap((receipt) => {
    const calibration = receipt.observation?.evidenceCalibration;
    const identity = calibration?.observationIdentity?.sha256;
    const observedAt = calibration?.observation?.observedAt ?? calibration?.observationReference?.observedAt;
    return typeof identity === 'string' && typeof observedAt === 'string' ? [{ receipt, identity, observedAt }] : [];
  });
  if (observed.length === 0) return [];
  const latest = observed.reduce((left, right) => (right.observedAt > left.observedAt ? right : left));
  return observed.filter(({ identity }) => identity === latest.identity).map(({ receipt }) => receipt);
}

function findReusableObservation(request, priorReceipts) {
  const exact = priorReceipts.find(
    (receipt) => receipt.observation !== undefined && receipt.request?.sha256 === request.sha256,
  );
  if (exact) return reuseSummary([exact]);

  if (request.args[0] !== 'code') return null;
  const requestedRanges = parseCodeRanges(request.args.slice(1));
  if (requestedRanges === null) return null;
  const coverage = priorSourceCoverage(priorReceipts);
  const coveringReceipts = new Set();
  const fullyCovered = requestedRanges.every((range) => {
    const intervals = coverage.get(range.path) ?? [];
    const covered = subtractIntervals(range, intervals);
    if (covered.length > 0) return false;
    for (const interval of intervals) {
      if (interval.end >= range.start && interval.start <= range.end) coveringReceipts.add(interval.receipt);
    }
    return true;
  });
  return fullyCovered ? reuseSummary([...coveringReceipts]) : null;
}

function findOverlappingCodeRanges(request, priorReceipts) {
  if (request.args[0] !== 'code') return null;
  const requestedRanges = parseCodeRanges(request.args.slice(1));
  if (requestedRanges === null) return null;
  const coverage = priorSourceCoverage(priorReceipts);
  const receiptIds = new Set();
  const uncoveredSelectors = [];
  let overlap = false;
  for (const range of requestedRanges) {
    const intervals = coverage.get(range.path) ?? [];
    for (const interval of intervals) {
      if (interval.end < range.start || interval.start > range.end) continue;
      overlap = true;
      receiptIds.add(interval.receipt.id);
    }
    uncoveredSelectors.push(...subtractIntervals(range, intervals).map(formatCodeRange));
  }
  if (!overlap) return null;
  return { receiptIds: [...receiptIds].sort(), uncoveredSelectors };
}

function parseCodeRanges(selectors) {
  if (selectors.length === 0) return null;
  const ranges = [];
  for (const selector of selectors) {
    const match = /^(.*):([1-9]\d*)-([1-9]\d*)$/u.exec(selector);
    if (!match) return null;
    const start = Number(match[2]);
    const end = Number(match[3]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) return null;
    ranges.push({ path: match[1], start, end });
  }
  return ranges;
}

function priorSourceCoverage(priorReceipts) {
  const coverage = new Map();
  for (const receipt of priorReceipts) {
    if (receipt.observation === undefined) continue;
    const ranges = [];
    if (receipt.request?.args?.[0] === 'code') {
      const codeRanges = parseCodeRanges(receipt.request.args.slice(1));
      if (codeRanges !== null) ranges.push(...codeRanges);
    }
    if (receipt.observation.result?.kind === 'bounded-inspect-behavior-projection') {
      for (const slice of receipt.observation.result.slices ?? []) {
        if (
          typeof slice.relativePath === 'string' &&
          Number.isSafeInteger(slice.startLine) &&
          Number.isSafeInteger(slice.endLine) &&
          slice.startLine <= slice.endLine
        ) {
          ranges.push({ path: slice.relativePath, start: slice.startLine, end: slice.endLine });
        }
      }
    }
    for (const range of ranges) {
      const intervals = coverage.get(range.path) ?? [];
      intervals.push({ ...range, receipt });
      coverage.set(range.path, intervals);
    }
  }
  return coverage;
}

function subtractIntervals(range, intervals) {
  let remaining = [{ start: range.start, end: range.end }];
  for (const interval of intervals.sort((left, right) => left.start - right.start || left.end - right.end)) {
    remaining = remaining.flatMap((candidate) => {
      if (interval.end < candidate.start || interval.start > candidate.end) return [candidate];
      const next = [];
      if (interval.start > candidate.start) next.push({ start: candidate.start, end: interval.start - 1 });
      if (interval.end < candidate.end) next.push({ start: interval.end + 1, end: candidate.end });
      return next;
    });
  }
  return remaining.map((candidate) => ({ path: range.path, ...candidate }));
}

function formatCodeRange(range) {
  return `${range.path}:${range.start}-${range.end}`;
}

function reuseSummary(receipts) {
  return {
    receiptIds: receipts.map((receipt) => receipt.id).sort(),
    rawEvidence: receipts.map((receipt) => receipt.rawEvidence),
  };
}

function findPriorObservation(priorReceipts, observationIdentity) {
  for (const receipt of priorReceipts) {
    const calibration = receipt.observation?.evidenceCalibration;
    if (calibration?.observationIdentity?.sha256 !== observationIdentity) continue;
    return {
      receiptId: calibration.observationReference?.receiptId ?? receipt.id,
    };
  }
  return null;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function parseArguments(args) {
  const separator = args.indexOf('--');
  if (separator < 0) usage();
  const wrapperArgs = args.slice(0, separator);
  const queryArgs = args.slice(separator + 1);
  if (wrapperArgs.length !== 2 || wrapperArgs[0] !== '--id' || !SAFE_ID.test(wrapperArgs[1] ?? '')) usage();
  if (queryArgs.length === 0 || queryArgs[0] === 'continue') usage();
  return { id: wrapperArgs[1], queryArgs };
}

function parseLastJsonLine(output, label) {
  const lines = output.trim().split(/\r?\n/u);
  const last = lines.at(-1);
  if (!last) fail(`Missing ${label}.`);
  try {
    return JSON.parse(last);
  } catch (error) {
    fail(`Invalid ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function usage() {
  fail('Usage: capture-evidence.mjs --id <lowercase-id> -- <scip-query command and arguments>');
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
