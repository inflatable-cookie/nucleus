import { sameLevels, type HostVocabulary, type NativeMode, type ProviderTranslation, type RuntimeMode } from '../../shared/profile-vocabulary';

/**
 * T3Code's spelling of Nucleus's profile vocabulary (Tom, 2026-11-12), read from
 * the nightly's `server.getConfig`. T3 names Claude's instance `claudeAgent`; it
 * carries Claude's thinking as the `effort` option (its top level `ultrathink`),
 * Pi's as `thinking` and FX's as `effort`; the rest ride the reasoning option.
 * Its four runtime modes are the same for every provider; a provider that reports
 * a subset narrows them through the catalog.
 */
const t3Modes: Partial<Record<RuntimeMode, NativeMode>> = {
  supervised: { modeId: 'approval-required' }, 'accept-edits': { modeId: 'auto-accept-edits' },
  auto: { modeId: 'auto' }, 'full-access': { modeId: 'full-access' },
};
const allLevels = sameLevels('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra');
const reasoning = (key: string): ProviderTranslation => ({ key, thinking: allLevels, modes: t3Modes });

export const t3codeVocabulary: HostVocabulary = {
  kind: 't3code',
  label: 'T3Code',
  providers: {
    codex: reasoning('codex'),
    claude: {
      key: 'claudeAgent', thinkingOption: 'effort',
      thinking: { ...sameLevels('low', 'medium', 'high', 'xhigh', 'max'), ultra: 'ultrathink' },
      modes: t3Modes,
    },
    pi: { key: 'pi', thinkingOption: 'thinking', thinking: sameLevels('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'), modes: t3Modes },
    grok: reasoning('grok'),
    fx: { key: 'fx', thinkingOption: 'effort', thinking: sameLevels('low', 'medium', 'high', 'xhigh', 'max'), modes: t3Modes },
    cursor: reasoning('cursor'), opencode: reasoning('opencode'), antigravity: reasoning('antigravity'),
    muse: reasoning('muse'), kiro: reasoning('kiro'),
  },
};
