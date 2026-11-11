import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';

// Keep this walk aligned with the bridge boundary checked by layout.test.ts.
//
// The bridge runs inside the plugin host, so its import graph must never load
// a runtime module (Store, engine, Git, hook or routing runtime, SQLite). The
// build erases type-only imports, so `import type …`, `export type … from`
// and named import/export lists whose every specifier is `type …` are skipped:
// they can never load the forbidden module at runtime. Every remaining (value)
// import is still refused when forbidden and still followed when relative.
export function checkIsolatedImports(root, entry) {
  const forbidden = ['service/runtime-owner', 'service/callbacks/callback', 'core/runtime', 'core/hooks', 'core/git', 'core/store', 'server/store', 'server/runtime', 'server/runtime-owner', 'server/engine', 'server/git', 'server/hooks', 'server/callback', 'server/hook-recovery', 'node:sqlite'];
  const seen = new Set();

  // Strip line and block comments so a commented-out import is not mistaken
  // for a real one. String literals are respected (including escapes), so a
  // `from "…"` inside a string keeps working as before.
  function stripComments(source) {
    let out = '';
    let i = 0;
    let quote = null;
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      if (quote) {
        out += ch;
        if (ch === '\\') {
          out += next ?? '';
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i++;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        out += ch;
        i++;
        continue;
      }
      if (ch === '/' && next === '/') {
        while (i < source.length && source[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && next === '*') {
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i += 2;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  }

  // `import { type A, type B } from …` (and the same `export { … } from`
  // shape) erases to nothing when every specifier carries its own `type`
  // modifier, so it is skipped like a bare `import type`.
  function isAllTypeSpecifiers(clause) {
    const match = clause.match(/^\{([\s\S]*)\}$/);
    if (!match) return false;
    const parts = match[1].split(',').map(part => part.trim()).filter(Boolean);
    return parts.length > 0 && parts.every(part => /^type\s+/.test(part));
  }

  // A forbidden specifier, whether imported for value or re-exported for
  // value, fails the gate the same way.
  function refuses(specifier, file) {
    const modulePath = specifier.startsWith('.')
      ? relative(resolve(root), resolve(root, dirname(file), specifier)).replace(/\\/g, '/')
      : specifier;
    if (forbidden.some(name => modulePath === name || modulePath.startsWith(`${name}.`) || modulePath.startsWith(`${name}/`))) {
      throw Error(`${file} imports forbidden module ${specifier}`);
    }
  }

  function follow(specifier, file) {
    if (!specifier.startsWith('.')) return;
    const base = resolve(root, dirname(file), specifier);
    for (const candidate of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, base]) {
      if (existsSync(candidate) && !candidate.endsWith('/')) {
        visit(candidate.slice(resolve(root).length + 1));
        break;
      }
    }
  }

  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    const source = stripComments(readFileSync(resolve(root, file), 'utf8'));
    // Side-effect imports (`import "…"`): no binding, but the module loads.
    for (const match of source.matchAll(/(?<![\w$])import(?![\w$])\s*["']([^"']+)["']/g)) {
      const specifier = match[1];
      refuses(specifier, file);
      follow(specifier, file);
    }
    for (const match of source.matchAll(/(?<![\w$])(import|export)(?![\w$])\s*([\s\S]*?)\s+from\s*["']([^"']+)["']/g)) {
      const clause = match[2].trim();
      const specifier = match[3];
      // `import type …` / `export type … from …` erases to nothing.
      if (/^type(?:\s|$)/.test(clause)) continue;
      // `import { type A } from …` erases to nothing when every specifier is type-only.
      if (isAllTypeSpecifiers(clause)) continue;
      refuses(specifier, file);
      follow(specifier, file);
    }
  }
  visit(entry);
  return seen;
}

export function checkBridgeImports(root) {
  const seen = checkIsolatedImports(root, 'index.server.ts');
  if (![...seen].some(file => file.startsWith('hosts/paseo/plugin/'))) throw Error('Bridge import walk did not reach plugin modules');
}
