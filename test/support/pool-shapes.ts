import type { PoolEntry } from '../../shared/contracts';

/**
 * The installed nightly's provider snapshot as `server.getConfig` reports it
 * (0.1.10-nightly.20261111.4529): the option descriptors each model carries, and
 * the runtime modes each provider restricts itself to. Codex and Claude report
 * no `supportedRuntimeModes`, so the nightly passes any of the four through
 * (`providerRuntimeMode`); Grok and Pi report a subset, and a request outside it
 * silently runs as `approval-required`. Copied, never connected: identifiers are
 * synthetic and the shapes are the contract.
 */
export const nightlyProviders = () => [
  { instanceId: 'codex', displayName: 'Codex', enabled: true, status: 'ready', models: [
    { slug: 'gpt-6-luna', name: 'Luna', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'medium', options: ['low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id, label: id })) },
      { id: 'serviceTier', label: 'Service Tier', type: 'select', currentValue: 'default', options: [{ id: 'default', label: 'Default', isDefault: true }, { id: 'priority', label: 'Priority' }] },
    ] } },
    { slug: 'gpt-6.1-sol', name: 'Sol', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'low', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({ id, label: id })) },
    ] } },
    { slug: 'gpt-6.1-terra', name: 'Terra', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'low', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'claudeAgent', displayName: 'Claude', enabled: true, status: 'ready', models: [
    { slug: 'claude-haiku-5-5', name: 'Haiku', capabilities: { optionDescriptors: [
      { id: 'effort', label: 'Effort', type: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'].map(id => ({ id, label: id })) },
    ] } },
    { slug: 'claude-opus-5-5', name: 'Opus', capabilities: { optionDescriptors: [
      { id: 'effort', label: 'Effort', type: 'select', options: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'grok', displayName: 'Grok', enabled: true, status: 'ready', supportedRuntimeModes: ['approval-required', 'auto', 'full-access'], models: [
    { slug: 'grok-4.6', name: 'Grok 4.6', capabilities: { optionDescriptors: [
      { id: 'reasoningEffort', label: 'Reasoning', type: 'select', currentValue: 'high', options: ['low', 'medium', 'high', 'xhigh'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'pi', displayName: 'Pi', enabled: true, status: 'ready', supportedRuntimeModes: ['approval-required', 'auto-accept-edits', 'full-access'], models: [
    { slug: 'opencode-go/muse-spark-1.3-contributor', name: 'Muse 1.3', capabilities: { optionDescriptors: [
      { id: 'thinking', label: 'Thinking', type: 'select', options: ['minimal', 'low', 'medium', 'high', 'xhigh'].map(id => ({ id, label: id })) },
    ] } },
    { slug: 'opencode-go/deepseek-v4.1-flash', name: 'Deepseek 4.1 Flash', capabilities: { optionDescriptors: [
      { id: 'thinking', label: 'Thinking', type: 'select', options: ['low', 'high', 'max'].map(id => ({ id, label: id })) },
    ] } },
  ] },
  { instanceId: 'cursor', displayName: 'Cursor', enabled: false, status: 'disabled', models: [] },
];

/**
 * Synthetic copies of the live profile pool's shapes (read once, read-only),
 * in Nucleus's canonical vocabulary (task 1158): provider, model, thinking level,
 * runtime mode, roles, capability, cost and whether the pool enables it. The
 * ids and names are synthetic so the fixture carries no live identity.
 */
export type ShapeProfile = { label: string; provider: string; model: string; modeId?: string; thinkingOptionId?: string; featureValues?: Record<string, unknown> };
export const poolShapes: Array<{ entry: Omit<PoolEntry, 'profileId'>; profile: ShapeProfile }> = [
  { entry: { enabled: true, group: 'codex', roles: ['worker', 'coordinator', 'reviewer'], capability: 'mechanical', weight: "more", scopes: ['general', 'mechanical'] },
    profile: { label: 'Codex grind (full-access)', provider: 'codex', model: 'gpt-6-luna', modeId: 'full-access', thinkingOptionId: 'xhigh' } },
  { entry: { enabled: true, group: 'codex', roles: ['reviewer', 'worker'], capability: 'heavyweight', weight: "default", scopes: ['complex', 'general'] },
    profile: { label: 'Codex oracle (full-access)', provider: 'codex', model: 'gpt-6.1-sol', modeId: 'full-access', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'codex', roles: ['worker'], capability: 'worker', weight: "default", scopes: ['general'] },
    profile: { label: 'Codex worker (full-access)', provider: 'codex', model: 'gpt-6.1-terra', modeId: 'full-access', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'claude', roles: ['worker', 'reviewer'], capability: 'worker', weight: "default", scopes: ['general', 'mechanical'] },
    profile: { label: 'Claude haiku (auto)', provider: 'claude', model: 'claude-haiku-5-5', modeId: 'auto', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'claude', roles: ['reviewer', 'worker'], capability: 'frontier', weight: "default", scopes: ['general', 'complex'] },
    profile: { label: 'Claude opus (full-access)', provider: 'claude', model: 'claude-opus-5-5', modeId: 'full-access', thinkingOptionId: 'medium' } },
  { entry: { enabled: false, group: 'claude', roles: ['worker'], capability: 'heavyweight', weight: "default", scopes: ['general'] },
    profile: { label: 'Claude sonnet (full-access, disabled)', provider: 'claude', model: 'claude-haiku-5-5', modeId: 'full-access', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'grok', roles: ['worker', 'reviewer'], capability: 'worker', weight: "default", scopes: ['general', 'complex'] },
    profile: { label: 'Grok (full-access)', provider: 'grok', model: 'grok-4.6', modeId: 'full-access', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'meta', roles: ['worker', 'reviewer', 'coordinator'], capability: 'mechanical', weight: "default", scopes: ['general', 'mechanical', 'complex'] },
    profile: { label: 'Pi muse (no mode)', provider: 'pi', model: 'opencode-go/muse-spark-1.3-contributor', thinkingOptionId: 'high' } },
  { entry: { enabled: true, group: 'deepseek', roles: ['worker', 'reviewer'], capability: 'worker', weight: "more", scopes: ['general', 'mechanical', 'complex'] },
    profile: { label: 'Pi deepseek (no mode)', provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'high', featureValues: {} } },
  { entry: { enabled: false, group: 'glm', roles: ['worker', 'reviewer', 'coordinator'], capability: 'worker', weight: "more", scopes: ['general', 'mechanical', 'complex'] },
    profile: { label: 'Pi glm (no mode, disabled)', provider: 'pi', model: 'opencode-go/deepseek-v4.1-flash', thinkingOptionId: 'high' } },
  // The mode fence itself: one canonical mode Codex cannot express and one it can.
  { entry: { enabled: true, group: 'codex', roles: ['worker'], capability: 'worker', weight: "default", scopes: ['general'] },
    profile: { label: 'Mode-only (plan)', provider: 'codex', model: 'gpt-6-luna', modeId: 'plan' } },
  { entry: { enabled: true, group: 'codex', roles: ['reviewer'], capability: 'worker', weight: "default", scopes: ['general'] },
    profile: { label: 'Mode-only (auto)', provider: 'codex', model: 'gpt-6-luna', modeId: 'auto' } },
];
