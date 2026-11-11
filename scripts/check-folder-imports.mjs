import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';

const extensions = ['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js'];
const declarationExtensions = ['.d.ts', '.d.mts', '.d.cts'];
const sourceRoots = ['shared', 'core', 'service', 'hosts', 'server', 'host', 'client', 'bin'];
const hostSdk = /^(?:@getpaseo\/|paseo-provenance-client(?:\/|$))/;

// Legacy locations are classified by responsibility, so moving a file does not
// silently exempt its imports. Exact offending edges live in the ratchet file.
export function area(path) {
  // This executable is a private service process, not a CLI transport client.
  if (['bin/host-run-private-server.mjs', 'bin/queue-service.mjs', 'bin/queue-host-run-supervisor.mjs', 'bin/queue-qa-supervisor.mjs', 'bin/queue-validation-supervisor.mjs', 'bin/queue-effigy-admission-hook.mjs'].includes(path)) return 'service';
  if (path === 'index.server.ts') return 'plugin:paseo';
  if (path === 'index.client.tsx') return 'host-client:paseo';
  const host = path.match(/^hosts?\/([^/]+)\/(.*)$/);
  if (host) return `${host[2].startsWith('plugin/') ? 'plugin' : host[2].startsWith('client/') ? 'host-client' : 'host'}:${host[1]}`;
  if (path.startsWith('server/service/') || path.startsWith('service/') || path === 'service/runtime-owner.ts') return 'service';
  if (path.startsWith('server/') || path.startsWith('core/')) return 'core';
  return path.split('/')[0];
}

function localTarget(root, from, specifier) {
  const base = resolve(root, dirname(from), specifier);
  const candidates = [base, ...[...extensions, ...declarationExtensions].map(ext => base + ext), ...[...extensions, ...declarationExtensions].map(ext => resolve(base, 'index' + ext))];
  // TS source may use the emitted JavaScript extension.
  const emitted = base.match(/\.(js|mjs|cjs)$/);
  if (emitted) {
    const stem = base.slice(0, -emitted[0].length);
    const sources = emitted[1] === 'js' ? ['.ts', '.tsx', '.d.ts']
      : emitted[1] === 'mjs' ? ['.mts', '.d.mts'] : ['.cts', '.d.cts'];
    candidates.push(...sources.map(ext => stem + ext));
  }
  const found = candidates.find(path => existsSync(path) && statSync(path).isFile());
  return relative(root, found ?? base).replaceAll('\\', '/');
}

export function importEdges(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const edges = [];
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) edges.push(node.moduleSpecifier.text);
    if (ts.isExternalModuleReference(node) && node.expression && ts.isStringLiteral(node.expression)) edges.push(node.expression.text);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) edges.push(node.arguments[0].text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) edges.push(node.argument.literal.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return [...new Set(edges)];
}

export function edgeRule(from, target, specifier) {
  const a = area(from), b = area(target);
  if (hostSdk.test(specifier)) return /^hosts\/paseo\//.test(from) ? null : 'host-sdk-location';
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null; // platform/library dependency
  if (a === 'shared') return b === 'shared' ? null : 'shared-neutral';
  if (a === 'core') return b === 'core' || b === 'shared' ? null : 'core-neutral';
  // Only the registration entry binds process actions; the forwarder cannot load them.
  if (from === 'hosts/paseo/plugin/index.ts' && target === 'service/install/bridge-process-actions.ts') return null;
  if (a.startsWith('plugin:')) return b === 'shared' || a === b ? null : 'plugin-forwarder';
  if (a.startsWith('host:')) return b === 'shared' || a === b || /^core\/host\/index\.ts$/.test(target) ? null : 'host-interface';
  if (a.startsWith('host-client:')) return b === 'shared' || a === b || b === 'client' ? null : 'host-client';
  if (a === 'client') return b === 'shared' || b === 'client' ? null : 'client-neutral';
  if (a === 'service') return b.startsWith('host:') && !/^hosts?\/[^/]+\/index\.ts$/.test(target) ? 'host-public-index' : b.startsWith('plugin:') || b.startsWith('host-client:') || b === 'client' ? 'service-process' : null;
  if (from === 'bin/queue-client.mjs' && target === 'hosts/paseo/cli/index.mjs') return null;
  if (a === 'bin') return b === 'bin' || b === 'shared' || /^service\/transport\/(?:index|install|main-channel)\.(?:ts|mjs|js)$/.test(target) ? null : 'cli-transport';
  return null;
}

export function folderViolations(root) {
  root = resolve(root);
  const paths = [];
  function walk(dir) {
    if (!existsSync(resolve(root, dir))) return;
    for (const item of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) walk(path);
      else if (extensions.some(ext => path.endsWith(ext))) paths.push(path);
    }
  }
  for (const dir of sourceRoots) walk(dir);
  for (const path of ['index.server.ts', 'index.client.tsx', 'mcp-report.mjs']) if (existsSync(resolve(root, path))) paths.push(path);
  const violations = [];
  for (const from of paths) {
    for (const specifier of importEdges(from, readFileSync(resolve(root, from), 'utf8'))) {
      const target = specifier.startsWith('.') || specifier.startsWith('/') ? localTarget(root, from, specifier) : specifier;
      const rule = edgeRule(from, target, specifier);
      if (rule) violations.push(`${rule}: ${from} -> ${specifier} [${target}]`);
    }
  }
  return [...new Set(violations)].sort();
}
