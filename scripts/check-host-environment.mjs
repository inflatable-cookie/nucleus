import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import ts from 'typescript';

const roots = ['shared', 'core', 'service', 'hosts', 'server', 'host', 'client', 'bin'];
const extension = /\.(?:[cm]?[jt]sx?)$/;
const environmentName = /\b(?:PASEO|T3)_[A-Z0-9_]*/g;

/** Host vocabulary is allowed only in its owning integration. Constants are not environment reads. */
export function hostEnvironmentNames(path, source) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const names = [];
  const record = text => {
    for (const match of text.matchAll(environmentName)) {
      const host = match[0].startsWith('PASEO_') ? 'paseo' : 't3code';
      if (!path.startsWith(`hosts/${host}/`)) names.push(match[0]);
    }
  };
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) record(scanner.getTokenText());
  }
  function visit(node) {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node)) record(node.text);
    else if (ts.isIdentifier(node) && (
      (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || (ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      || (ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node)
      || ts.isBindingElement(node.parent)
    )) record(node.text);
    ts.forEachChild(node, visit);
  }
  visit(file);
  return names.sort();
}

export function hostEnvironmentViolations(root) {
  const findings = [];
  function inspect(path) {
    const counts = new Map();
    for (const name of hostEnvironmentNames(path, readFileSync(resolve(root, path), 'utf8'))) counts.set(name, (counts.get(name) ?? 0) + 1);
    for (const [name, count] of counts) findings.push({ path, name, count });
  }
  function walk(directory) {
    if (!existsSync(resolve(root, directory))) return;
    for (const item of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${item.name}`;
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && extension.test(path)) inspect(path);
    }
  }
  for (const directory of roots) walk(directory);
  for (const path of ['index.server.ts', 'index.client.tsx', 'mcp-report.mjs']) if (existsSync(resolve(root, path))) inspect(path);
  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
}

/** Exact occurrence counts ratchet down; a resolved exception must be removed. */
export function checkHostEnvironment(root) {
  const path = resolve(root, 'scripts/host-environment-exceptions.json');
  const known = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  const actual = hostEnvironmentViolations(root);
  const failures = actual.filter(row => !known.some(exception => exception.path === row.path && exception.name === row.name && exception.count === row.count))
    .map(row => `${row.path}: host environment ${row.name} belongs in its host integration (${row.count} occurrences)`);
  for (const exception of known) {
    if (!actual.some(row => row.path === exception.path && row.name === exception.name && row.count === exception.count)) failures.push(`${exception.path}: remove or reduce the resolved host environment exception for ${exception.name}`);
  }
  return failures;
}
