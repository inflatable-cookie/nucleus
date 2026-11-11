#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DATA_HOME_ENTRIES, dataHome, isDataHomeError, resolveDataHome } from '../shared/data-home.mjs';

/** One diagnostic line; a refused configuration reports itself instead of throwing twice. */
function describeDataHome() {
  try {
    return `Data home: ${dataHome()}`;
  } catch (error) {
    return `Data home: unresolved (${error.message})`;
  }
}

const [command, ...args] = process.argv.slice(2);
function hasRunTicketCredential() {
  const path = process.env.NUCLEUS_TICKET;
  if (!path) return false;
  try {
    const ticket = JSON.parse(readFileSync(path, 'utf8'));
    return typeof ticket.token === 'string' && ticket.token.length > 0;
  } catch { return true; }
}
try {
  if (command === 'worktree') {
    const { worktree } = await import('./worktree.mjs');
    worktree(args[0], args.slice(1));
  }
  else if (command === 'helper') {
    const [name, ...helperArgs] = args;
    const helpers = {
      submit: './nucleus-submit.mjs',
      reparent: './nucleus-reparent.mjs',
      'review-entry': './nucleus-review-entry.mjs',
    };
    if (!Object.hasOwn(helpers, name)) throw Error('Choose a helper: nucleus helper submit, reparent, or review-entry');
    const child = spawnSync(process.execPath, [fileURLToPath(new URL(helpers[name], import.meta.url)), ...helperArgs], { stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.signal) throw Error(`Helper stopped by ${child.signal}; inspect its result before retrying`);
    process.exitCode = child.status ?? 1;
  }
  else if (command === 'ask' || command === 'tell') {
    // The helper form of the agent verbs for hosts without an MCP binding (task 1108).
    await import('./agent-verbs.mjs');
  }
  else if (command === 'data-home') {
    // The one resolver, printed for the operator: which folder, why, and the path inventory.
    console.log(JSON.stringify({ ...resolveDataHome(), entries: DATA_HOME_ENTRIES }, null, 2));
  }
  else if (command === 'recover-previous') {
    if (args.length || hasRunTicketCredential()) throw Error('Recovery is an operator-only maintenance command');
    const { recoverPrevious } = await import('../service/transport/install.mjs');
    console.log(JSON.stringify(await recoverPrevious()));
  }
  else if (['install', 'integrate', 'version'].includes(command)) {
    const service = await import('../service/transport/install.mjs');
    console.log(JSON.stringify(await (command === 'install' ? service.install(args[0], args[1] === '--sha256' ? args[2] : undefined) : service[command](...args))));
  }
  else if (command === 'channel' || command === 'rollback') {
    const service = await import('../service/transport/main-channel.mjs');
    console.log(JSON.stringify(await (command === 'channel' ? service.configureChannel(...args) : service.requestRollback())));
  }
  else {
    // Delegate the complete catalogue, payload handling and output contract.
    await import('./queue-cli.mjs');
  }
} catch (error) {
  // A resolver refusal already names the path and the way to settle it; anything
  // else is reported with the data home this run uses.
  console.error(isDataHomeError(error) ? `Nucleus: ${error.message}` : `Nucleus: ${error.message}. ${describeDataHome()}`);
  process.exitCode = 1;
}
