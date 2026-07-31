/**
 * What one parsed command invocation does to or learns about the world.
 *
 * A command name is not sufficient: one command can preview in one mode and
 * mutate in another. The selected role follows the invocation's observable
 * effect, not the subsystem that implements it.
 */
export const COMMAND_OPERATION_ROLES = [
  'repository-observation',
  'repository-preview',
  'mutation',
  'composite',
  'environment-observation',
  'tool-information',
] as const;

export type CommandOperationRole = (typeof COMMAND_OPERATION_ROLES)[number];

export type CommandOperationRuleCondition =
  | {
      kind: 'argument';
      index: number;
      equals: string | number | boolean;
    }
  | {
      kind: 'option';
      name: string;
      equals: string | number | boolean;
    }
  | {
      kind: 'option-present';
      name: string;
    };

export interface CommandOperationRule {
  when: CommandOperationRuleCondition;
  role: CommandOperationRole;
}

/**
 * Declarative rather than executable so descriptors, docs, validation, and
 * runtime selection all inspect one finite contract.
 */
export interface CommandOperationSelector {
  defaultRole: CommandOperationRole;
  rules?: readonly CommandOperationRule[];
}

export interface CommandOperationInvocation {
  args: readonly unknown[];
  options: Readonly<Record<string, unknown>>;
}

export const REPOSITORY_OBSERVATION_OPERATION = {
  defaultRole: 'repository-observation',
} as const satisfies CommandOperationSelector;

export function commandOperation(
  defaultRole: CommandOperationRole,
  rules: readonly CommandOperationRule[] = [],
): CommandOperationSelector {
  return {
    defaultRole,
    ...(rules.length > 0 ? { rules } : {}),
  };
}

export function resolveCommandOperationRole(
  selector: CommandOperationSelector,
  invocation: CommandOperationInvocation,
): CommandOperationRole {
  for (const rule of selector.rules ?? []) {
    if (rule.when.kind === 'option-present') {
      const actual = invocation.options[rule.when.name];
      if (actual !== undefined && actual !== false) return rule.role;
      continue;
    }
    const actual =
      rule.when.kind === 'argument' ? invocation.args[rule.when.index] : invocation.options[rule.when.name];
    if (actual === rule.when.equals) return rule.role;
  }
  return selector.defaultRole;
}

export function commandOperationRoles(selector: CommandOperationSelector): CommandOperationRole[] {
  return [...new Set([selector.defaultRole, ...(selector.rules ?? []).map((rule) => rule.role)])];
}

export function isCommandOperationRole(value: unknown): value is CommandOperationRole {
  return COMMAND_OPERATION_ROLES.includes(value as CommandOperationRole);
}

export function operationObservesRepository(role: CommandOperationRole): boolean {
  return role === 'repository-observation' || role === 'repository-preview' || role === 'composite';
}
