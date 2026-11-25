#!/usr/bin/env node
// Internal implementation; agents use the installed `nucleus` command.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
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
  if (command === 'helper') {
    const [name, ...helperArgs] = args;
    const helpers = {
      submit: './nucleus-submit.mjs',
      reparent: './nucleus-reparent.mjs',
      detach: './nucleus-detach.mjs',
      'review-entry': './nucleus-review-entry.mjs',
      'bulk-dispose': './nucleus-bulk-dispose.mjs',
      subscribe: './nucleus-subscribe.mjs',
    };
    const helperList = 'Choose a helper: submit, reparent, detach, review-entry, bulk-dispose, subscribe, or report';
    const wantsHelp = helperArgs.some(arg => arg === '--help' || arg === '-h');
    // Help never spawns the report helper: that helper reads stdin, and an agent shell's
    // stdin is a pipe that never closes. The other helpers answer --help themselves.
    if (name === undefined || name === '--help' || name === '-h') { console.log(`${helperList}. Each takes --help.`); process.exit(0); }
    if (name === 'report' && wantsHelp) { console.log((await import('../shared/service/report-usage.mjs')).REPORT_USAGE); process.exit(0); }
    if (!Object.hasOwn(helpers, name) && name !== 'report') throw Error(helperList);
    const script = name === 'report' ? (process.env.NUCLEUS_HELPER || join(dataHome(), 'worker-report.mjs')) : fileURLToPath(new URL(helpers[name], import.meta.url));
    const ticket = name === 'report' ? (await import('./run-ticket.mjs')).runTicketPath() : null;
    // A retained shell can name a ticket that a release already deleted (nucleus#1392). Say which
    // exit applies instead of surfacing a bare ENOENT from the helper.
    if (ticket && !existsSync(ticket)) throw Error(`The run ticket this shell names is gone, because its run was released. Run the helper with NUCLEUS_CONTINUATION_RUN_ID and NUCLEUS_CONTINUATION_TICKET set to this run's ID and ticket path from your prompt, then retry`);
    const child = spawnSync(process.execPath, [script, ...(ticket ? [ticket] : []), ...helperArgs], { stdio: 'inherit' });
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
  else if (command === 't3') {
    // The T3Code host's operator install route (nucleus#1330): connect, report and
    // remove this integration's `nucleus` ACP provider, and nothing else in T3.
    await import('./nucleus-t3.mjs');
  }
  else if (command === 'bb') {
    // The BB host's operator install route (Spec 062, phase 7): install, report and
    // remove this integration's BB plugin, and nothing else in the operator's BB.
    await import('./nucleus-bb.mjs');
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
