// Internal implementation; agents use the installed `nucleus` command.
// T3Code host install route: connect, report and remove this integration's
// `nucleus` ACP provider in a running T3Code environment.
//
// The work lives in `bin/t3-install.ts` (one owner for the `t3` commands and
// their refusals, beside the other CLI commands); this file only names the
// command word and prints the answer.
import { compiledIdentity } from '../shared/runtime.mjs';

// `nucleus t3 …` arrives through this file's own import from `bin/nucleus.mjs`, so
// the command word may still be in argv; running this file directly omits it.
const argv = process.argv.slice(2);
const [command, ...args] = argv[0] === 't3' ? argv.slice(1) : argv;
if (!compiledIdentity) await import('tsx');
const { t3Command } = await import('./t3-install.ts');

const answer = await t3Command(command ?? '', args);
console.log(typeof answer === 'string' ? answer : JSON.stringify(answer, null, 2));
