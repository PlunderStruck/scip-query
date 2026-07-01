#!/usr/bin/env node
/**
 * npm postinstall hook. Runs automatically after `npm install -g scip-query`.
 * Prints a one-line pointer at `scip-query setup`; deliberately performs no
 * home-directory writes, skill installs, or toolchain checks at install time.
 */
import { postinstall } from './setup.js';

postinstall();
