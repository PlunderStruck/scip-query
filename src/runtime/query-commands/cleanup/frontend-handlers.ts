import * as queries from '../../../queries/index.js';
import {
  booleanOptionValue,
  budgetedReportCommand,
  definedLimitOption,
  definedNumberOption,
  optionalStringArg,
  optionValueSource,
  stringOptionValue,
} from '../../command-kit/command-execution.js';
import { render } from '../../render.js';

export const handleReactComponentDuplicates = budgetedReportCommand('react-component-duplicates', {
  query: ({ db, args, opts, budget }) =>
    queries.reactComponentDuplicates(db, {
      minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.62),
      minTokens: definedNumberOption(opts, 'minTokens', 8),
      limit: definedLimitOption(opts, 'limit', 20),
      scope: stringOptionValue(opts, 'scope'),
      scanLimit: budget.scanLimit,
      filePattern: optionalStringArg(args, 0),
    }),
  emptyMessage: (results) => (results.length === 0 ? 'No duplicated React component structures found.' : undefined),
  heuristicLabel: 'React component duplicate candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${Math.round(r.similarity * 100)}% similar React structure:`,
        `  ${r.componentA}  (${r.fileA})`,
        `  ${r.componentB}  (${r.fileB})`,
        `  Evidence class: ${r.evidenceClass}  (tier: ${r.actionTier})`,
        `  Recommendation: ${r.recommendation}`,
      ];
      if (r.evidenceClassReasons.length) lines.push(`  Evidence reasons: ${r.evidenceClassReasons.join('; ')}`);
      if (r.sharedComponents.length) lines.push(`  Shared components: ${r.sharedComponents.join(', ')}`);
      if (r.sharedNativeTags.length) lines.push(`  Shared native tags: ${r.sharedNativeTags.join(', ')}`);
      if (r.sharedProps.length) lines.push(`  Shared props: ${r.sharedProps.join(', ')}`);
      if (r.sharedEvents.length) lines.push(`  Shared events: ${r.sharedEvents.join(', ')}`);
      if (r.sharedBindings.length) lines.push(`  Shared bindings: ${r.sharedBindings.slice(0, 20).join(', ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} duplicated React component pair(s) found.`);
  },
});

export const handleReactHookCandidates = budgetedReportCommand('react-hook-candidates', {
  query: ({ db, args, opts, budget }) =>
    queries.reactHookCandidates(db, {
      minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.45),
      minSharedBehaviors: definedNumberOption(opts, 'minSharedBehaviors', 6),
      limit: definedLimitOption(opts, 'limit', 20),
      scope: stringOptionValue(opts, 'scope'),
      scanLimit: budget.scanLimit,
      filePattern: optionalStringArg(args, 0),
    }),
  emptyMessage: (results) => (results.length === 0 ? 'No duplicated React hook behavior candidates found.' : undefined),
  heuristicLabel: 'React hook extraction candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${Math.round(r.similarity * 100)}% similar React behavior:`,
        `  ${r.componentA}  (${r.fileA})`,
        `  ${r.componentB}  (${r.fileB})`,
        `  Evidence class: ${r.evidenceClass}  (tier: ${r.actionTier})`,
        `  Recommendation: ${r.recommendation}`,
        `  ${r.reason}`,
      ];
      if (r.evidenceClassReasons.length) lines.push(`  Evidence reasons: ${r.evidenceClassReasons.join('; ')}`);
      if (r.sharedHooks.length) lines.push(`  Shared hooks: ${r.sharedHooks.join(', ')}`);
      if (r.sharedReactHooks.length) lines.push(`  Shared React hooks: ${r.sharedReactHooks.join(', ')}`);
      if (r.sharedEffects.length) lines.push(`  Shared effects: ${r.sharedEffects.join(', ')}`);
      if (r.sharedState.length) lines.push(`  Shared state: ${r.sharedState.join(', ')}`);
      if (r.sharedRequests.length) lines.push(`  Shared requests: ${r.sharedRequests.join(', ')}`);
      if (r.sharedHandlers.length) lines.push(`  Shared handlers: ${r.sharedHandlers.slice(0, 12).join(', ')}`);
      if (r.sharedHandlerVerbs.length)
        lines.push(`  Shared action verbs: ${r.sharedHandlerVerbs.slice(0, 12).join(', ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} React hook candidate pair(s) found.`);
  },
});

export const handleReactLargeComponentPressure = budgetedReportCommand('react-large-component-pressure', {
  query: ({ db, args, opts, budget }) =>
    queries.reactLargeComponentPressure(db, {
      minComponentLines: definedNumberOption(opts, 'minComponentLines', 300),
      minFileLines: definedNumberOption(opts, 'minFileLines', 800),
      minJsxTokens: definedNumberOption(opts, 'minJsxTokens', 80),
      minBehaviorTokens: definedNumberOption(opts, 'minBehaviorTokens', 40),
      limit: definedLimitOption(opts, 'limit', 20),
      scope: stringOptionValue(opts, 'scope'),
      scanLimit: budget.scanLimit,
      filePattern: optionalStringArg(args, 0),
    }),
  emptyMessage: (results) => (results.length === 0 ? 'No large React component pressure found.' : undefined),
  heuristicLabel: 'large React component pressure candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${r.componentLines} component line(s): ${r.component}  (${r.file})`,
        `  Dominant pressure: ${r.dominantPressure}  (context: ${r.contextKind})`,
        `  Pressure kinds: ${r.pressureKinds.join(', ')}`,
        `  File lines: ${r.fileLines}; JSX tokens: ${r.jsxTokens}; behavior tokens: ${r.behaviorTokens}`,
        `  Recommendation: ${r.recommendationKind} - ${r.recommendation}`,
        `  Reasons: ${r.reasons.join('; ')}`,
      ];
      return lines.join('\n');
    });
    console.log(`\n${results.length} large React component(s) found.`);
  },
});

export const handleVueComponentDuplicates = budgetedReportCommand('vue-component-duplicates', {
  query: ({ db, args, opts, budget }) =>
    queries.vueComponentDuplicates(db, {
      minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.62),
      minTokens: definedNumberOption(opts, 'minTokens', 8),
      limit: definedLimitOption(opts, 'limit', 20),
      scope: stringOptionValue(opts, 'scope'),
      scanLimit: budget.scanLimit,
      filePattern: optionalStringArg(args, 0),
    }),
  emptyMessage: (results) => (results.length === 0 ? 'No duplicated Vue component structures found.' : undefined),
  heuristicLabel: 'Vue component duplicate candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${Math.round(r.similarity * 100)}% similar Vue structure:`,
        `  ${r.fileA}`,
        `  ${r.fileB}`,
        `  Evidence class: ${r.evidenceClass}  (tier: ${r.actionTier})`,
        `  Recommendation: ${r.recommendation}`,
      ];
      if (r.evidenceClassReasons.length) lines.push(`  Evidence reasons: ${r.evidenceClassReasons.join('; ')}`);
      if (r.sharedComponents.length) lines.push(`  Shared components: ${r.sharedComponents.join(', ')}`);
      if (r.sharedProps.length) lines.push(`  Shared props: ${r.sharedProps.join(', ')}`);
      if (r.sharedEvents.length) lines.push(`  Shared events: ${r.sharedEvents.join(', ')}`);
      if (r.sharedDirectives.length) lines.push(`  Shared directives: ${r.sharedDirectives.join(', ')}`);
      if (r.sharedSlots.length) lines.push(`  Shared slots: ${r.sharedSlots.join(', ')}`);
      if (r.sharedIdentifiers.length)
        lines.push(`  Shared identifiers: ${r.sharedIdentifiers.slice(0, 20).join(', ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} duplicated Vue component pair(s) found.`);
  },
});

export const handleVueComposableCandidates = budgetedReportCommand('vue-composable-candidates', {
  query: ({ db, args, opts, budget }) =>
    queries.vueComposableCandidates(db, {
      minSimilarity: definedNumberOption(opts, 'minSimilarity', 0.45),
      minSharedBehaviors: definedNumberOption(opts, 'minSharedBehaviors', 6),
      limit: definedLimitOption(opts, 'limit', 20),
      scope: stringOptionValue(opts, 'scope'),
      scanLimit: budget.scanLimit,
      filePattern: optionalStringArg(args, 0),
    }),
  emptyMessage: (results) => (results.length === 0 ? 'No duplicated Vue behavior candidates found.' : undefined),
  heuristicLabel: 'Vue composable extraction candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${Math.round(r.similarity * 100)}% similar Vue behavior:`,
        `  ${r.fileA}`,
        `  ${r.fileB}`,
        `  Evidence class: ${r.evidenceClass}  (tier: ${r.actionTier})`,
        `  Recommendation: ${r.recommendation}`,
        `  ${r.reason}`,
      ];
      if (r.evidenceClassReasons.length) lines.push(`  Evidence reasons: ${r.evidenceClassReasons.join('; ')}`);
      if (r.sharedComposables.length) lines.push(`  Shared composables: ${r.sharedComposables.join(', ')}`);
      if (r.sharedStores.length) lines.push(`  Shared stores: ${r.sharedStores.join(', ')}`);
      if (r.sharedRequests.length) lines.push(`  Shared requests: ${r.sharedRequests.join(', ')}`);
      if (r.sharedLifecycle.length) lines.push(`  Shared lifecycle: ${r.sharedLifecycle.join(', ')}`);
      if (r.sharedFunctions.length) lines.push(`  Shared functions: ${r.sharedFunctions.slice(0, 12).join(', ')}`);
      if (r.sharedFunctionVerbs.length)
        lines.push(`  Shared action verbs: ${r.sharedFunctionVerbs.slice(0, 12).join(', ')}`);
      if (r.sharedBindings.length) lines.push(`  Shared bindings: ${r.sharedBindings.slice(0, 20).join(', ')}`);
      if (r.sharedTemplateEvents.length)
        lines.push(`  Shared template events: ${r.sharedTemplateEvents.slice(0, 20).join(', ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} Vue composable candidate pair(s) found.`);
  },
});

export const handleVueLargeViewPressure = budgetedReportCommand('vue-large-view-pressure', {
  query: ({ db, args, opts, budget }) =>
    queries.vueLargeViewPressure(db, {
      minTotalLines:
        booleanOptionValue(opts, 'reviewThresholds') && optionValueSource(opts, 'minTotalLines') === 'default'
          ? 300
          : definedNumberOption(opts, 'minTotalLines', 800),
      minTemplateLines: definedNumberOption(opts, 'minTemplateLines', 300),
      minScriptLines: definedNumberOption(opts, 'minScriptLines', 300),
      minStyleLines: definedNumberOption(opts, 'minStyleLines', 500),
      limit: definedLimitOption(opts, 'limit', 20),
      scope: stringOptionValue(opts, 'scope'),
      scanLimit: budget.scanLimit,
      filePattern: optionalStringArg(args, 0),
    }),
  emptyMessage: (results) => (results.length === 0 ? 'No large Vue view pressure found.' : undefined),
  heuristicLabel: 'large Vue view pressure candidates',
  render: (results) => {
    render.list(results, (r) => {
      const lines = [
        `\n${r.totalLines} total line(s): ${r.file}`,
        `  Dominant pressure: ${r.dominantPressure}  (context: ${r.contextKind})`,
        `  Pressure kinds: ${r.pressureKinds.join(', ')}`,
        `  Blocks: template ${r.templateLines}, script ${r.scriptLines}, style ${r.styleLines}, external script ${r.externalScriptLines}, custom ${r.customBlockLines}`,
        `  Recommendation: ${r.recommendationKind} - ${r.recommendation}`,
      ];
      if (r.externalScriptPaths.length) lines.push(`  External scripts: ${r.externalScriptPaths.join(', ')}`);
      lines.push(`  Reasons: ${r.reasons.join('; ')}`);
      return lines.join('\n');
    });
    console.log(`\n${results.length} large Vue view pressure file(s) found.`);
  },
});
