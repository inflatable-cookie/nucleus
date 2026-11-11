import type { Adapter } from '../../core/host';

/**
 * A reviewer reports its checkpoint from inside its own turn, so the wake the
 * receipt schedules sees the reader busy and Queue does not continue it yet
 * (Tom, 2026-10-31: Queue continues a checkpoint once the reader's turn ends).
 * The turn ends when `work` and the wakes it scheduled settle. Fixtures whose reader
 * reads as idle at callback time use this to keep that scenario honest; an
 * observation that is not plainly idle (busy, closed, errored) is left alone.
 * The wrap covers whichever observation the test installed, fixture or native.
 */
export async function whileReaderInTurn<T>(engine: { adapter: Adapter; quiesce(): Promise<void> }, agentId: string | null | undefined, work: () => Promise<T>): Promise<T> {
  const adapter = engine.adapter as { observe: Adapter['observe'] };
  const observe = adapter.observe;
  const inTurn: Adapter['observe'] = async id => {
    const state = await observe.call(adapter, id);
    return id === agentId && state.status === 'idle' && !state.active ? { ...state, status: 'running', active: true } : state;
  };
  adapter.observe = inTurn;
  try {
    const result = await work();
    await engine.quiesce();
    return result;
  } finally {
    // Engine's host proxy binds method reads, so identity comparison with the
    // installed wrapper cannot succeed. Restore after the scheduled wakes end.
    adapter.observe = observe;
  }
}
