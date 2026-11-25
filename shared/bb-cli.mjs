// Where an installed BB lives, and the launchers inside it.
//
// The private BB sidebar proof uses these launchers to start an isolated server.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** The `bb` command shims an installed app writes, in the order an operator finds them. */
export function bbCliCandidates(home = homedir()) {
  return [
    join(home, '.bb', 'bin', 'bb'),
    join(home, '.local', 'bin', 'bb'),
    '/opt/homebrew/bin/bb',
    '/usr/local/bin/bb',
  ];
}

/**
 * Find the installed `bb` command. Returns every path it tried, so a caller that
 * has none can name them instead of guessing.
 */
export function findBbCli(options = {}) {
  const candidates = bbCliCandidates(options.home ?? homedir());
  const cli = candidates.find(path => existsSync(path)) ?? null;
  return { cli, tried: candidates };
}

/** The server and host-daemon launchers inside the app the CLI shim names. */
export function bbInstallFromCli(cli) {
  const tried = [cli];
  let appDist = null;
  try {
    const source = readFileSync(cli, 'utf8');
    const entry = /^entry='([^']+)'/m.exec(source)?.[1];
    if (entry) appDist = dirname(entry);
  } catch {
    // An executable shim names no entry; the app layout below still applies.
  }
  const candidates = [
    appDist ? join(appDist, 'bb-server.js') : null,
    join(dirname(dirname(cli)), '..', 'Resources', 'app.asar.unpacked', 'node_modules', 'bb-app', 'dist', 'bb-server.js'),
  ]
    .filter(path => typeof path === 'string')
    .map(path => resolve(path));
  tried.push(...candidates);
  const serverLauncher = candidates.find(path => existsSync(path));
  if (!serverLauncher) return { install: null, tried };
  const daemonLauncher = join(dirname(serverLauncher), 'bb-host-daemon.js');
  tried.push(daemonLauncher);
  if (!existsSync(daemonLauncher)) return { install: null, tried };
  return { install: { cli, serverLauncher, daemonLauncher }, tried };
}
