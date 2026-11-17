// Internal implementation; agents use the installed `nucleus` command.
// BB host install route: install, report and remove this integration's BB plugin.
//
// The work lives in `service/bb-install.ts` (one owner for the `bb` commands and
// their refusals); this file only names the package root the built plugin is looked
// up beside and prints the answer.
import { compiledIdentity } from '../shared/runtime.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// `nucleus bb …` arrives through this file's own import from `bin/nucleus.mjs`, so the
// command word may still be in argv; running this file directly omits it.
const argv = process.argv.slice(2);
const [command, ...args] = argv[0] === 'bb' ? argv.slice(1) : argv;
if (!compiledIdentity) await import('tsx');
const { bbCommand } = await import('../service/bb-install.ts');

const answer = bbCommand(command, args, {
  packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
});
console.log(typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2));
