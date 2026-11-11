/**
 * Proves moved code didn't change. Given two refs and the moved names, it compares
 * each declaration's tokens (parameters, return type, `async`, body; strings raw;
 * comments and whitespace ignored) and that every name the code reads still comes
 * from the same module. See "Rules for every move PR" in lane `nucleus-simplify`.
 *
 *   effigy check:moves -- <before> <after> [--from <file>] [--rewrite <after=before>]... <move>...
 *
 * A move is `name`, `Class.method` or `old=new`, each side optionally `file:name`.
 * `--from` pins where plain names lived before. `--rewrite this.resolution=this`
 * permits one receiver rewrite: nothing else is forgiven.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface MoveCheck { repo: string; before: string; after: string; moves: string[]; from?: string; rewrites?: string[] }
export interface MoveResult { move: string; ok: boolean; detail: string }
interface Declaration { file: string; source: ts.SourceFile; node: ts.Node }

const sourceRoots = ['server', 'shared', 'host', 'core', 'service', 'hosts'];
const words = (text: string): string[] => text.match(/[\w$]+|\S/g) ?? [];
const withoutExtension = (file: string) => file.replace(/\.tsx?$/, '');

function reader(repo: string, ref: string) {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const files = git('ls-tree', '-r', '--name-only', ref, '--', ...sourceRoots).split('\n').filter(file => /\.tsx?$/.test(file));
  const texts = new Map<string, string>();
  const read = (file: string) => {
    if (!texts.has(file)) texts.set(file, git('show', `${ref}:${file}`));
    return texts.get(file)!;
  };
  return { files, read, commit: git('rev-parse', ref).trim() };
}

function topLevel(source: ts.SourceFile, name: string): ts.Node[] {
  return source.statements.flatMap((statement): ts.Node[] => {
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.filter(item => ts.isIdentifier(item.name) && item.name.text === name);
    const named = ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement);
    return named && statement.name?.text === name && !(ts.isFunctionDeclaration(statement) && !statement.body) ? [statement] : [];
  });
}

function find(tree: ReturnType<typeof reader>, spec: string, pinned?: string): Declaration[] {
  const colon = spec.lastIndexOf(':');
  const file = colon >= 0 ? spec.slice(0, colon) : pinned;
  const [owner, member] = spec.slice(colon + 1).split('.') as [string, string | undefined];
  return (file ? [file] : tree.files).filter(item => tree.files.includes(item) && tree.read(item).includes(member ?? owner)).flatMap(item => {
    const source = ts.createSourceFile(item, tree.read(item), ts.ScriptTarget.Latest, true);
    const nodes = topLevel(source, owner);
    if (!member) return nodes.map(node => ({ file: item, source, node }));
    return nodes.filter(ts.isClassDeclaration).flatMap(node => node.members
      .filter(entry => entry.name?.getText(source) === member && !(ts.isMethodDeclaration(entry) && !entry.body))
      .map(entry => ({ file: item, source, node: entry as ts.Node })));
  });
}

function tokens(node: ts.Node | undefined, source: ts.SourceFile, out: string[] = []): string[] {
  if (!node || ts.isJSDoc(node)) return out;
  const children = node.getChildren(source);
  if (children.length) for (const child of children) tokens(child, source, out);
  else if (node.getText(source)) out.push(node.getText(source));
  return out;
}

/** The parts of a declaration that must survive a move; its name, `export` and `private` may not. */
function fingerprint({ node, source }: Declaration): string[] {
  const value = ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node) ? node.initializer : undefined;
  const isFunction = (item: ts.Node | undefined): item is ts.FunctionLikeDeclaration & { body?: ts.Node } =>
    Boolean(item && (ts.isFunctionDeclaration(item) || ts.isMethodDeclaration(item) || ts.isGetAccessor(item) || ts.isArrowFunction(item) || ts.isFunctionExpression(item)));
  const fn = isFunction(node) ? node : isFunction(value) ? value : null;
  if (fn) {
    const head = [ts.getCombinedModifierFlags(fn) & ts.ModifierFlags.Async ? 'async' : 'sync', fn.asteriskToken ? '*' : ''];
    return [...head, ...fn.typeParameters?.flatMap(item => tokens(item, source)) ?? [], '(', ...fn.parameters.flatMap(item => [...tokens(item, source), ',']), ')', ':', ...tokens(fn.type, source), ...tokens(fn.body, source)];
  }
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) return [...tokens(node.type, source), '=', ...tokens(value, source)];
  return tokens(node, source);
}

function applyRewrites(list: string[], rewrites: string[]): string[] {
  let current = list;
  for (const rewrite of rewrites) {
    const [from, to] = rewrite.split('=').map(words) as [string[], string[]];
    const next: string[] = [];
    for (let at = 0; at < current.length;) {
      if (from.length && from.every((word, offset) => current[at + offset] === word)) { next.push(...to); at += from.length; }
      else next.push(current[at++]!);
    }
    current = next;
  }
  return current;
}

function firstDifference(before: string[], after: string[]): string | null {
  const length = Math.max(before.length, after.length);
  for (let at = 0; at < length; at++) {
    if (before[at] === after[at]) continue;
    const near = (list: string[]) => list.slice(Math.max(0, at - 5), at + 6).join(' ');
    return `body differs at token ${at}: before \`${near(before)}\`, after \`${near(after)}\``;
  }
  return null;
}

/** Where a file gets a name: the module it imports it from, this file, or `global`. */
function bindings(source: ts.SourceFile) {
  const map = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      const module = specifier.startsWith('.') ? withoutExtension(join(dirname(source.fileName), specifier)) : specifier;
      const clause = statement.importClause;
      if (clause?.name) map.set(clause.name.text, module);
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) map.set(clause.namedBindings.name.text, module);
        else for (const item of clause.namedBindings.elements) map.set(item.name.text, module);
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name)) map.set(item.name.text, withoutExtension(source.fileName));
    } else if ('name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)) {
      map.set((statement.name as ts.Identifier).text, withoutExtension(source.fileName));
    }
  }
  return map;
}

/** Identifiers a declaration reads from outside itself. */
function freeNames({ node }: Declaration): Set<string> {
  const declared = new Set<string>(), read = new Set<string>();
  const memberName = (item: ts.Identifier) => {
    const parent = item.parent;
    return (ts.isPropertyAccessExpression(parent) && parent.name === item) || (ts.isQualifiedName(parent) && parent.right === item)
      || ((ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent) || ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)) && parent.name === item)
      || (ts.isBindingElement(parent) && parent.propertyName === item);
  };
  const walk = (item: ts.Node) => {
    if (ts.isJSDoc(item)) return;
    if ((ts.isVariableDeclaration(item) || ts.isParameter(item) || ts.isBindingElement(item) || ts.isFunctionDeclaration(item)) && item.name && ts.isIdentifier(item.name)) declared.add(item.name.text);
    if (ts.isTypeParameterDeclaration(item)) declared.add(item.name.text);
    if (ts.isIdentifier(item) && !memberName(item)) read.add(item.text);
    ts.forEachChild(item, walk);
  };
  ts.forEachChild(node, walk);
  return new Set([...read].filter(name => !declared.has(name)));
}

function bindingDifference(before: Declaration, after: Declaration, moved: Set<string>): string | null {
  const was = bindings(before.source), is = bindings(after.source);
  for (const name of freeNames(after)) {
    if (moved.has(name)) continue;
    const old = was.get(name) ?? 'global', current = is.get(name) ?? 'global';
    // A name local to the old file left with this move or stays reachable by import; a global must stay global.
    if (old === withoutExtension(before.file) ? current === 'global' : old !== current)
      return `\`${name}\` came from ${old}, now from ${current}`;
  }
  return null;
}

export function checkMoves(input: MoveCheck): { before: string; after: string; results: MoveResult[] } {
  const before = reader(input.repo, input.before), after = reader(input.repo, input.after);
  const moved = new Set(input.moves.map(move => move.split('=').at(-1)!.split(':').at(-1)!));
  const results = input.moves.map((move): MoveResult => {
    const [oldSpec, newSpec = oldSpec] = move.split('=') as [string, string?];
    const fail = (detail: string) => ({ move, ok: false, detail });
    const olds = find(before, oldSpec, input.from);
    if (olds.length !== 1) return fail(`found ${olds.length} declarations at ${input.before}${olds.length ? `: ${olds.map(item => item.file).join(', ')}` : ''}`);
    const old = olds[0]!;
    const candidates = find(after, newSpec);
    if (!candidates.length) return fail(`no declaration at ${input.after}`);
    const elsewhere = newSpec === oldSpec ? candidates.filter(item => item.file !== old.file) : candidates;
    if (!elsewhere.length) return fail(`still in ${old.file}; it did not move`);
    if (elsewhere.length > 1) return fail(`ambiguous at ${input.after}: ${elsewhere.map(item => item.file).join(', ')}; name the file as old=file:new`);
    const current = elsewhere[0]!;
    const difference = firstDifference(fingerprint(old), applyRewrites(fingerprint(current), input.rewrites ?? []))
      ?? bindingDifference(old, current, moved);
    return difference ? fail(difference) : { move, ok: true, detail: `${old.file} -> ${current.file}` };
  });
  return { before: before.commit, after: after.commit, results };
}

/** Check that a shard family still registers the same cases exactly once. */
export function checkShardMoves(repo: string, before: string, after: string, families: string[]): string[] {
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const show = (ref: string, file: string) => git('show', `${ref}:${file}`);
  const helper = 'test/support/sharded-test.ts';
  if (show(before, helper) !== show(after, helper)) throw new Error('shard registration helper changed');
  const registrations = (ref: string, family: string) => {
    const source = ts.createSourceFile(`${family}.ts`, show(ref, `test/${family}.cases.ts`), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const walk = (node: ts.Node) => {
      if (ts.isCallExpression(node)) {
        const target = node.expression;
        if ((ts.isIdentifier(target) && target.text === 'test') ||
            (ts.isCallExpression(target) && ts.isIdentifier(target.expression) && ['weighted', 'weightedTiming'].includes(target.expression.text))) {
          found.push([...tokens(target, source), ...tokens(node.arguments[0], source)].join(' '));
          return;
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
    return found;
  };
  const layout = (ref: string, family: string) => {
    const names = git('ls-tree', '-r', '--name-only', ref, '--', 'test').split('\n')
      .filter(file => new RegExp(`^test/${family}(?:-\\d+)?\\.test\\.ts$`).test(file));
    const indexes = names.map(file => {
      const source = show(ref, file);
      const match = source.match(/useShard\((\d+),\s*(\d+)\)/);
      if (!match || !source.includes(`require('./${family}.cases')`)) throw new Error(`invalid shard entry ${file}`);
      return [Number(match[1]), Number(match[2])];
    });
    if (!indexes.length || indexes.some(([, count]) => count !== indexes.length) ||
        new Set(indexes.map(([index]) => index)).size !== indexes.length ||
        indexes.some(([index]) => index < 0 || index >= indexes.length)) throw new Error(`incomplete shard layout for ${family} at ${ref}`);
    return indexes.length;
  };
  return families.map(family => {
    const old = registrations(before, family), current = registrations(after, family);
    if (JSON.stringify(old) !== JSON.stringify(current)) throw new Error(`case registrations changed for ${family}`);
    return `${family}: ${old.length} registration sites, ${layout(before, family)} -> ${layout(after, family)} files`;
  });
}

function main(argv: string[]): number {
  if (argv[0] === '--shards') {
    const [, before, after, ...families] = argv;
    if (!before || !after || !families.length) throw new Error('Usage: check:moves -- --shards <before> <after> <family>...');
    for (const line of checkShardMoves(process.cwd(), before, after, families)) console.log(line);
    return 0;
  }
  const positional: string[] = [], rewrites: string[] = [];
  let from: string | undefined;
  for (let at = 0; at < argv.length; at++) {
    if (argv[at] === '--from') from = argv[++at];
    else if (argv[at] === '--rewrite') rewrites.push(argv[++at]!);
    else positional.push(argv[at]!);
  }
  const [before, after, ...moves] = positional;
  if (!before || !after || !moves.length) {
    console.error('Usage: effigy check:moves -- <before> <after> [--from <file>] [--rewrite <after=before>]... <move>...');
    return 2;
  }
  const report = checkMoves({ repo: process.cwd(), before, after, moves, from, rewrites });
  for (const result of report.results) console.log(`${result.ok ? 'same' : 'DIFF'}  ${result.move}  ${result.detail}`);
  const failed = report.results.filter(result => !result.ok).length;
  console.log(`${report.before.slice(0, 12)}..${report.after.slice(0, 12)}: ${report.results.length - failed} of ${report.results.length} moves match${rewrites.length ? `, modulo ${rewrites.join(', ')}` : ''}`);
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
