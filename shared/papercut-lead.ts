import { leadSchema, papercutSchema, type Lead, type Papercut } from './contracts';

export function papercutBody(cut: Pick<Papercut, 'area' | 'happened' | 'impact' | 'fix'>): string {
  return [cut.area === null ? null : `Area\n\n${cut.area}`, `What happened\n\n${cut.happened}`, `Impact\n\n${cut.impact}`,
    cut.fix === null ? null : `Suggested fix\n\n${cut.fix}`].filter(Boolean).join('\n\n');
}

/** The structured papercut fields remain the source of truth for the old interface. */
export function leadFromPapercut(cut: Papercut): Lead {
  const value = papercutSchema.parse(cut);
  if (value.state === 'closed' && (value.closedReason === null || value.closedAt === null))
    throw new Error(`Papercut ${value.id} has incomplete closure`);
  if (value.state !== 'closed' && (value.closedReason !== null || value.note !== null || value.closedAt !== null))
    throw new Error(`Papercut ${value.id} has closure fields outside the closed state`);
  const at = value.closedAt ?? value.filedAt;
  return leadSchema.parse({
    id: value.id, title: value.title, body: papercutBody(value), repositories: [value.repository], lanes: value.lanes,
    tags: ['papercut'], papercut: { area: value.area, happened: value.happened, impact: value.impact, fix: value.fix,
      source: value.source, draftId: value.draftId },
    closure: value.state === 'closed' ? { reason: value.closedReason, note: value.note, at: value.closedAt } : null,
    author: value.filedBy, state: value.state, version: value.version, dropReason: null,
    targets: value.taskId ? [{ kind: 'task', repository: value.repository.origin, reference: value.taskId, at }] : [],
    source: value.source && { file: value.source.file, contentKey: value.source.contentKey },
    createdAt: value.filedAt, updatedAt: at, closedAt: value.closedAt,
  });
}

export function papercutFromLead(lead: Lead): Papercut {
  if (!lead.tags.includes('papercut') || !lead.papercut || !['open', 'promoted', 'closed'].includes(lead.state))
    throw new Error(`Lead ${lead.id} is not a papercut`);
  const target = lead.targets.find(item => item.kind === 'task');
  return papercutSchema.parse({
    id: lead.id, repository: lead.repositories[0], area: lead.papercut.area, title: lead.title, version: lead.version,
    happened: lead.papercut.happened, impact: lead.papercut.impact, fix: lead.papercut.fix,
    filedBy: lead.author, filedAt: lead.createdAt, state: lead.state, taskId: target?.reference ?? null,
    closedReason: lead.closure?.reason ?? null, draftId: lead.papercut.draftId,
    note: lead.closure?.note ?? null, closedAt: lead.closedAt, source: lead.papercut.source, lanes: lead.lanes,
  });
}
