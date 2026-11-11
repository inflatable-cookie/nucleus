import { readFileSync } from 'node:fs';

/**
 * Read a CLI payload. `-` reads JSON from stdin (the documented route: no shared
 * temporary files for concurrent sessions to overwrite); a path reads that file;
 * no argument means `{}`. Stdin is never read implicitly, so a harness that leaves
 * stdin open can't hang the CLI.
 */
export function readPayload(file) {
  if (!file) return {};
  const source = file === '-' ? 'stdin' : file;
  const text = readFileSync(file === '-' ? 0 : file, 'utf8');
  if (!text.trim()) throw new Error(`Empty payload on ${source}; pass a JSON object, or omit the argument for {}`);
  try { return JSON.parse(text); }
  catch (error) { throw new Error(`Payload on ${source} is not valid JSON: ${error.message}`); }
}
