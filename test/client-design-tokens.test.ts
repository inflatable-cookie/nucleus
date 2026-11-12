/**
 * Client screens read the design tokens (nucleus#1134). Every font size, corner
 * radius and colour in a screen file comes from `client/design.ts` or the host
 * theme; a new literal needs a reason in review. The scan below flags a new
 * `fontSize` / `borderRadius` literal or a quoted hex / rgba colour outside the
 * allowlist. Zero stays unflagged: `borderRadius: 0` and per-corner `0` mean
 * square, not a size, and `padding: 0` removes space rather than setting it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SCREEN_DIRS = [join(root, 'client'), join(root, 'hosts/paseo/client')];
/** The token source, the logo assets and the web theme the tokens resolve from. */
const ALLOWLIST = new Set([
  'client/design.ts',
  'client/provider-logo-assets.ts',
  'client/web/app.tsx',
]);

const COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const LITERAL = new RegExp([
  String.raw`(?:^|[^A-Za-z])fontSize\s*:\s*[1-9][0-9]*`,
  String.raw`(?:^|[^A-Za-z])border(?:TopLeft|TopRight|BottomLeft|BottomRight)?Radius\s*:\s*[1-9][0-9]*`,
  String.raw`["']#[0-9a-fA-F]{3,8}\b["']`,
  String.raw`(?:^|[^A-Za-z])rgba?\(`,
  String.raw`(?:^|[^A-Za-z])hsla?\(`,
].join('|'), 'g');

/** Literal token bypasses in one screen source, with the line each sits on. */
export function findTokenLiterals(source: string): Array<{ line: number; text: string }> {
  const stripped = source.replace(COMMENT, match => ' '.repeat(match.length));
  const hits: Array<{ line: number; text: string }> = [];
  for (const match of stripped.matchAll(LITERAL)) {
    const line = stripped.slice(0, match.index).split('\n').length;
    hits.push({ line, text: match[0].trim().slice(0, 60) });
  }
  return hits;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}

test('no screen file carries a font size, radius or colour literal', () => {
  const files = SCREEN_DIRS.flatMap(sourceFiles);
  assert.ok(files.length > 20, 'the scan found the screen sources');
  const offenders: string[] = [];
  for (const file of files) {
    const rel = relative(root, file);
    if (ALLOWLIST.has(rel)) continue;
    const hits = findTokenLiterals(readFileSync(file, 'utf8'));
    for (const hit of hits) offenders.push(`${rel}:${hit.line}: ${hit.text}`);
  }
  assert.deepEqual(offenders, [], 'new literals belong in client/design.ts (or the theme), with a reason in review');
});

test('the scan flags a new literal and passes a token read', () => {
  assert.equal(findTokenLiterals(`<Text style={{ fontSize: 12 }}>hi</Text>`).length, 1, 'a font size literal is flagged');
  assert.equal(findTokenLiterals(`<View style={{ borderRadius: 7 }} />`).length, 1, 'a radius literal is flagged');
  assert.equal(findTokenLiterals(`<View style={{ borderTopLeftRadius: 6 }} />`).length, 1, 'a per-corner radius literal is flagged');
  assert.equal(findTokenLiterals(`style={{ color: "#f1f3f5" }}`).length, 1, 'a quoted hex colour is flagged');
  assert.equal(findTokenLiterals(`style={{ backgroundColor: "rgba(0,0,0,0.68)" }}`).length, 1, 'a quoted scrim colour is flagged');
  assert.deepEqual(findTokenLiterals(`<Text style={{ fontSize: type.body.fontSize, lineHeight: type.body.lineHeight }}>hi</Text>`), [], 'a token read passes');
  assert.deepEqual(findTokenLiterals(`<View style={{ borderRadius: radius.card, borderTopLeftRadius: 0 }} />`), [], 'a token radius and a square corner pass');
  assert.deepEqual(findTokenLiterals(`<View style={{ padding: 0, margin: 0 }} />`), [], 'zero spacing passes');
  assert.deepEqual(findTokenLiterals(`// Queue #665: per-project counts live here\nconst label = \`PR #\${number}\`;`), [], 'issue references and id interpolation pass');
  assert.deepEqual(findTokenLiterals(`/* a #fff swatch in a comment */`), [], 'comments pass');
});

test('the scan covers the token matcher it guards', () => {
  for (const literal of ['fontSize: 11', 'borderRadius: 10', '"#000"', "'#a371f7'", 'rgba(0, 0, 0, 0.68)']) {
    assert.equal(findTokenLiterals(`x{{ ${literal} }}`).length, 1, `${literal} is flagged`);
  }
  for (const clean of ['fontSize: typeScale.metadata.fontSize', 'borderRadius: radius.control', 'color: r.accent', 'backgroundColor: overlay.scrim']) {
    assert.deepEqual(findTokenLiterals(`x{{ ${clean} }}`), [], `${clean} passes`);
  }
});
