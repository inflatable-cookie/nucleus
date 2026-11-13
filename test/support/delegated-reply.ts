import { ANSWERING_WINDOW_MS } from './budgets';

/** Model the delegate repeating the ask line from its prompt in fixture replies. */
export function fixtureReply(prompt: string, reply: string | null): string | null {
  if (reply === null || reply.startsWith('Ask: ')) return reply;
  const ask = prompt.split('\n').find(line => line.startsWith('Ask: '));
  return ask ? `${ask}\n${reply}` : reply;
}

/** Simulate the recipient executing question.answer; returned chat is not an answer. */
export async function answerFixturePrompt(
  resolution: { answerDelegatedQuestion: (input: { questionId: string; answer?: string; choice?: string; reason: string; decision?: 'operator'; overtakes?: string[] }, caller: string) => unknown },
  recipient: string, prompt: string, legacyText: string | null,
): Promise<null> {
  if (!legacyText) return null;
  const questionId = prompt.match(/^Question id: (.+)$/m)?.[1];
  if (!questionId) return null;
  keepWindowOpenForMock(resolution, questionId);
  const lines = legacyText.split(/\r?\n/).map(line => line.trim());
  const field = (key: string) => lines.filter(line => line.toLowerCase().startsWith(`${key.toLowerCase()}:`)).at(-1)?.slice(key.length + 1).trim();
  const decision = field('Decision') === 'operator' ? 'operator' as const : undefined;
  const choice = field('Choice');
  const answer = field('Answer') ?? (!choice && !decision ? legacyText.trim() : undefined);
  const reason = field('Reason') ?? 'Fixture reviewer advice';
  const overtakes = field('Overtakes')?.split(',').map(id => id.trim()).filter(Boolean);
  await resolution.answerDelegatedQuestion({ questionId, ...(decision ? { decision } : choice ? { choice } : { answer }), reason, ...(overtakes ? { overtakes } : {}) }, recipient);
  return null;
}

/**
 * A mock answers during its own send, so it never models a missed window. The
 * short window silent rungs use can still pass before the mock gets the CPU, and
 * refusing the answer then fails the test on host load alone. Only an expired
 * deadline moves; a closed window stays closed.
 */
function keepWindowOpenForMock(resolution: unknown, questionId: string): void {
  const { store } = resolution as { store: { eventsAll(key: string): { kind: string; detail: string }[]; event(key: string, kind: string, detail: string): unknown } };
  const key = `delegation:${questionId}`;
  const delivery = store.eventsAll(key).findLast(event => event.kind === 'delegated_delivery');
  if (!delivery) return;
  const authority = JSON.parse(delivery.detail) as { deadline: number };
  if (Date.now() > authority.deadline)
    store.event(key, 'delegated_delivery', JSON.stringify({ ...authority, deadline: Date.now() + ANSWERING_WINDOW_MS }));
}
