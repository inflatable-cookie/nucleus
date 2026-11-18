#!/usr/bin/env node
/**
 * The installed `t3` command's session verbs, for the operator install route's
 * tests (nucleus#1330). It answers the nightly's own wire shapes — `issue --json`
 * with the session id, token and expiry, `list --json` with the same fields the
 * installed CLI prints and no token, and `revoke --session-id` — and keeps its
 * sessions in `T3_CLI_FAKE_STATE/sessions.json`, so a test can see exactly which
 * session the route minted, with which scopes, and which it revoked.
 *
 * Synthetic only: no server, no credential, no live T3 home.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const state = process.env.T3_CLI_FAKE_STATE;
if (!state) {
  console.error('T3_CLI_FAKE_STATE is required');
  process.exit(2);
}
const args = process.argv.slice(2);
const flags = { scopes: [], label: null, subject: null, ttl: null, json: false, sessionId: null, baseDir: null };
for (let index = 0; index < args.length; index++) {
  const argument = args[index];
  if (argument === '--scope') flags.scopes.push(args[++index]);
  else if (argument === '--label') flags.label = args[++index];
  else if (argument === '--subject') flags.subject = args[++index];
  else if (argument === '--ttl') flags.ttl = args[++index];
  else if (argument === '--session-id') flags.sessionId = args[++index];
  else if (argument === '--base-dir') flags.baseDir = args[++index];
  else if (argument === '--json') flags.json = true;
}
const path = join(state, 'sessions.json');
const read = () => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : []);
const write = rows => {
  mkdirSync(state, { recursive: true });
  writeFileSync(path, `${JSON.stringify(rows, null, 2)}\n`, { mode: 0o600 });
};
function durationMs(ttl) {
  const match = /^(\d+)\s*([smhdw])$/.exec(`${ttl ?? ''}`.trim());
  if (!match) return 30 * 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  return amount * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
}
const [verb, noun, action] = [args[0], args[1], args[2]];
// `revoke` takes the session id as its one positional argument, like the installed CLI.
const positional = args.slice(3).find(argument => !argument.startsWith('--') && !['--base-dir', '--session-id'].includes(args[args.indexOf(argument) - 1] ?? ''));
if (verb !== 'auth' || noun !== 'session') {
  console.error(`synthetic t3 CLI: unsupported command ${args.join(' ')}`);
  process.exit(64);
}
if (action === 'issue') {
  const sessionId = `synthetic-session-${randomUUID()}`;
  const expiresAt = new Date(Date.now() + durationMs(flags.ttl)).toISOString();
  const token = `synthetic-${sessionId}`;
  const sessions = read();
  sessions.push({ sessionId, token, scopes: flags.scopes, subject: flags.subject, label: flags.label, ttl: flags.ttl, expiresAt, issuedAt: new Date().toISOString() });
  write(sessions);
  const issued = { sessionId, token, method: 'session', scopes: flags.scopes, subject: flags.subject, client: null, expiresAt };
  console.log(flags.json ? JSON.stringify(issued, null, 2) : token);
} else if (action === 'list') {
  // Only active sessions, like the installed CLI; a revoked one stays in the store
  // so a test can still read which bearer the route minted and when it let it go.
  const rows = read().filter(session => !session.revokedAt)
    .map(({ token, label, ttl, issuedAt, revokedAt, ...session }) => ({ ...session, connected: false, client: null, lastConnectedAt: null }));
  console.log(JSON.stringify(rows, null, 2));
} else if (action === 'revoke') {
  const sessions = read();
  const sessionId = flags.sessionId ?? positional ?? null;
  const target = sessions.find(session => session.sessionId === sessionId && !session.revokedAt);
  if (target) target.revokedAt = new Date().toISOString();
  write(sessions);
  console.log(target ? `Revoked session ${sessionId}.\n` : `No active session found for ${sessionId}.\n`);
} else {
  console.error(`synthetic t3 CLI: unsupported session action ${action}`);
  process.exit(64);
}
