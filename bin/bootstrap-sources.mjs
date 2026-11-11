import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';

export const bootstrapEntries = ['shared/rpc-catalogue.ts', 'shared/schema-refusal.ts', 'shared/service/local-client.ts'];

// Parse syntax rather than matching text: comments, strings and multiline
// imports must not change which local modules the snapshot contains.
export async function bootstrapSources(root, entries = bootstrapEntries) {
  const parserName = 'typescript';
  const { default: ts } = await import(parserName);
  const sources = new Map();
  async function exists(path) {
    try { return (await stat(path)).isFile(); }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  }
  async function visit(path) {
    const key = relative(root, path);
    if (key.startsWith('../') || key === '..') throw new Error(`Bootstrap import escapes checkout: ${path}`);
    if (sources.has(key)) return;
    const bytes = await readFile(path);
    sources.set(key, bytes);
    const source = ts.createSourceFile(path, bytes.toString('utf8'), ts.ScriptTarget.Latest, true);
    const imports = [];
    function scan(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) imports.push(node.arguments[0].text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) imports.push(node.argument.literal.text);
      ts.forEachChild(node, scan);
    }
    scan(source);
    for (const specifier of imports) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(path), specifier);
      const extension = extname(target);
      const candidates = extension
        ? [target, ...(extension === '.js' ? [target.slice(0, -3) + '.ts'] : [])]
        : [target + '.ts', target + '.mjs', target + '.d.ts', join(target, 'index.ts'), join(target, 'index.mjs')];
      let found;
      for (const candidate of candidates) if (await exists(candidate)) { found = candidate; break; }
      if (!found) throw new Error(`Missing bootstrap import ${specifier} from ${key}`);
      await visit(found);
    }
    if (!/\.d\.(?:ts|mts)$/.test(path)) {
      const declaration = path.replace(/\.(?:ts|mjs)$/, path.endsWith('.mjs') ? '.d.mts' : '.d.ts');
      if (declaration !== path && await exists(declaration)) await visit(declaration);
      // This repository also declares .mjs modules with sibling .d.ts files.
      const tsDeclaration = path.replace(/\.mjs$/, '.d.ts');
      if (tsDeclaration !== path && await exists(tsDeclaration)) await visit(tsDeclaration);
    }
  }
  for (const entry of entries) await visit(resolve(root, entry));
  return new Map([...sources].sort(([a], [b]) => a.localeCompare(b)));
}
