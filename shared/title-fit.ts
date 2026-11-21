/**
 * Host-neutral title fitting: truncate a title to a host's bound on a word
 * boundary, keeping the cut Unicode-safe (code points, never UTF-16 halves)
 * and marking it with an ellipsis. Each host adapter selects its own bound
 * and caps at its boundary; this module owns only the shared algorithm.
 */
export function fitTitle(title: string, maxLength: number) {
  if (title.length <= maxLength) return title;
  let prefix = '';
  for (const character of title) {
    if (prefix.length + character.length > maxLength - 1) break;
    prefix += character;
  }
  const boundary = [...prefix.matchAll(/\s/g)].at(-1)?.index ?? -1;
  if (boundary > 0) prefix = prefix.slice(0, boundary);
  return `${prefix.trimEnd()}…`;
}
