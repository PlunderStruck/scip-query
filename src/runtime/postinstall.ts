#!/usr/bin/env node
/**
 * npm postinstall hook. Runs automatically after `npm install -g scip-query`.
 * Installs skills into Claude Code and Codex, checks for scip binary.
 */
import { postinstall } from './setup.js';

postinstall();
