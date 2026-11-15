/**
 * Task 560: what a proof run's timeline proves about the one declared selector.
 * One owner of the shell-command reading: a terminal shell tool call whose
 * command invokes the selector is evidence it ran, and a mention inside text,
 * a quote, an echo, an expansion or a comment never is.
 */
import { TERMINAL_TOOL_STATUSES, type TimelineEntry } from '../recovery/stall';

/**
 * The timeline evidence that one declared proof selector ran: a terminal shell
 * tool call whose command invokes the selector. Callers asking only whether it
 * started may include a running call; that never proves a result. A non-shell
 * entry is not the selector's execution, and a command that does not invoke the
 * selector proves nothing about it; callers supply only histories read with
 * positive coverage, so an unreadable or partial timeline never reaches here.
 */
export function timelineSelectorEvidence(entries: TimelineEntry[], selector: string, includeRunning = false): { command: string; at: string } | null {
  for (const entry of entries) {
    const item = entry?.item;
    if (item?.type !== 'tool_call' || item.detail?.type !== 'shell') continue;
    if (!TERMINAL_TOOL_STATUSES.has(String(item.status ?? '')) && !(includeRunning && item.status === 'running')) continue;
    const command = String(item.detail.command ?? '');
    if (!shellCommandInvokesSelector(command, selector)) continue;
    const at = String(entry.timestamp ?? '');
    if (!Number.isFinite(Date.parse(at))) continue;
    return { command: command.slice(0, 300), at };
  }
  return null;
}

/** One shell word (with its quoting fact) or one connector between commands. */
type ShellItem = { kind: 'word'; text: string; quoted: boolean } | { kind: 'connector'; text: string };

/**
 * Split one shell command into words and connectors. Quotes are read as
 * literal text and stay marked quoted (a quoted selector is a mention, never
 * a command word); unquoted `#` at a word boundary comments out the rest of
 * its line; backslash escapes join the next character into the word;
 * parameter and arithmetic expansions are opaque quoted words, while a
 * command substitution opens a connector so its body parses as commands.
 */
function shellCommandItems(command: string): ShellItem[] {
  const items: ShellItem[] = [];
  let word = '', quoted = false, inWord = false;
  const flush = () => {
    if (!inWord) return;
    items.push({ kind: 'word', text: word, quoted });
    word = ''; quoted = false; inWord = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (ch === '\\') { word += command[i + 1] ?? ''; i++; inWord = true; continue; }
    if (ch === '\'') {
      const end = command.indexOf('\'', i + 1);
      word += end === -1 ? command.slice(i + 1) : command.slice(i + 1, end);
      i = end === -1 ? command.length : end;
      quoted = true; inWord = true; continue;
    }
    if (ch === '"') {
      let j = i + 1;
      for (; j < command.length; j++) {
        if (command[j] === '\\') { word += command[j + 1] ?? ''; j++; continue; }
        if (command[j] === '"') break;
        word += command[j];
      }
      i = j;
      quoted = true; inWord = true; continue;
    }
    if (/\s/.test(ch)) { flush(); continue; }
    if (ch === '#' && !inWord) {
      const nl = command.indexOf('\n', i);
      i = nl === -1 ? command.length : nl;
      continue;
    }
    if (ch === '$') {
      const next = command[i + 1];
      if (next === '{' || next === '(') {
        // Parameter `${...}` and arithmetic `$((...))` expansions execute
        // nothing: they are one opaque, quoted word (quoted words never match
        // a selector and close any launcher chain). A command substitution
        // `$(` really runs its contents, so it opens a connector instead and
        // the substitution body parses as ordinary commands.
        flush();
        if (next === '{') {
          const end = shellClosing(command, i + 1, '{', '}');
          items.push({ kind: 'word', text: command.slice(i, end + 1), quoted: true });
          i = end;
          continue;
        }
        if (command[i + 2] === '(') {
          const end = shellClosing(command, i + 1, '(', ')');
          items.push({ kind: 'word', text: command.slice(i, end + 1), quoted: true });
          i = end;
          continue;
        }
        items.push({ kind: 'connector', text: '(' });
        i++;
        continue;
      }
      word += ch; inWord = true; continue;
    }
    if (ch === '&' || ch === '|' || ch === ';') {
      flush();
      const two = command.slice(i, i + 2);
      const connector = two === '&&' || two === '||' || two === ';;' ? two : ch;
      items.push({ kind: 'connector', text: connector });
      i += connector.length - 1;
      continue;
    }
    if (ch === '\n' || (!inWord && (ch === '(' || ch === ')' || ch === '{' || ch === '}'))) {
      flush();
      items.push({ kind: 'connector', text: ch });
      continue;
    }
    word += ch; inWord = true;
  }
  flush();
  return items;
}

/** The index of the character closing the opener at `start` (nesting counted), or the command's end when never closed. */
function shellClosing(command: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let i = start; i < command.length; i++) {
    if (command.startsWith(open, i)) { depth++; i += open.length - 1; }
    else if (command.startsWith(close, i)) { depth -= close.length; if (depth <= 0) return i; }
  }
  return command.length - 1;
}

/** Launchers that consume themselves and still start the next word's command. */
const SHELL_LAUNCHER_WORDS = new Set(['time', 'nohup', 'env', 'command', 'exec', 'sudo', 'nice', 'do', 'then', 'timeout', 'xargs']);
/** A leading variable assignment launches the command after it, like `env`. */
const isAssignmentWord = (text: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(text);

/**
 * The item indices where a command may start: at the command's beginning,
 * right after a connector, or after the transparent launcher words just
 * consumed (`timeout` also consumes its duration; `nice` its optional
 * `-n N`; `env` and bare assignments their `VAR=value` words; `xargs` its
 * immediately following option words). Quoted text is never a command word
 * and closes any launcher chain.
 */
function shellInvocationStarts(items: ShellItem[]): Set<number> {
  const starts = new Set<number>();
  let invocable = true;
  let pending: 'timeout' | 'nice-flag' | 'nice-value' | 'env' | 'xargs-options' | null = null;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.kind === 'connector') { invocable = true; pending = null; continue; }
    if (item.quoted) { pending = null; invocable = false; continue; }
    if (pending === 'timeout') { pending = null; invocable = true; continue; }
    if (pending === 'nice-flag') { if (item.text === '-n') { pending = 'nice-value'; continue; } pending = null; }
    else if (pending === 'nice-value') { pending = null; invocable = true; continue; }
    else if (pending === 'env') {
      if (isAssignmentWord(item.text)) continue;
      pending = null;
    } else if (pending === 'xargs-options') {
      if (item.text.startsWith('-')) continue;
      pending = null;
    }
    if (invocable) starts.add(i);
    if (item.text === 'timeout') { pending = 'timeout'; invocable = false; }
    else if (item.text === 'nice') { pending = 'nice-flag'; invocable = false; }
    else if (item.text === 'env') { pending = 'env'; invocable = false; }
    else if (item.text === 'xargs') { pending = 'xargs-options'; invocable = false; }
    else if (!SHELL_LAUNCHER_WORDS.has(item.text) && !isAssignmentWord(item.text)) invocable = false;
  }
  return starts;
}

/**
 * Whether one shell command invokes the declared selector, rather than merely
 * mentioning its text: the selector must appear as an unquoted run of whole
 * words at an invocation position (the command's start, after a connector,
 * or behind transparent launchers and assignments). `echo effigy test ...`,
 * any quoted mention, an `echo ${selector}` parameter expansion, an arithmetic
 * expansion, a comment and fragmentary matches inside larger words are not
 * invocations. A command this rule cannot read as an invocation — unknown
 * wrappers, variables holding the selector — is a miss, never a guess: a
 * missed settlement leaves the record to the report path, while a wrong one
 * would invent history.
 */
export function shellCommandInvokesSelector(command: string, selector: string): boolean {
  const selectorWords = selector.trim().split(/\s+/).filter(Boolean);
  if (!selectorWords.length) return false;
  const items = shellCommandItems(command);
  const starts = shellInvocationStarts(items);
  for (let i = 0; i < items.length; i++) {
    if (!starts.has(i)) continue;
    let cursor = i;
    const matched = selectorWords.every(expected => {
      const item = items[cursor];
      cursor++;
      return item?.kind === 'word' && !item.quoted && item.text === expected;
    });
    if (matched) return true;
  }
  return false;
}
