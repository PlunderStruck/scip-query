import { repositoryContext } from './context.js';
import type { RepositoryContextHistory, RepositoryContextOptions, RepositoryContextResult } from './context.js';

/**
 * @deprecated Use `repositoryContext`. This compatibility name remains for
 * one minor release so existing library consumers can migrate without a
 * source break.
 */
export const planContext = repositoryContext;

/** @deprecated Use `RepositoryContextOptions`. */
export type PlanContextOptions = RepositoryContextOptions;

/** @deprecated Use `RepositoryContextHistory`. */
export type PlanContextHistory = RepositoryContextHistory;

/** @deprecated Use `RepositoryContextResult`. */
export type PlanContextResult = RepositoryContextResult;
