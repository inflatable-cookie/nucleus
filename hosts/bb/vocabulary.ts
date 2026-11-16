import { sameLevels, type HostVocabulary, type ProviderTranslation } from '../../shared/profile-vocabulary';

/** BB 0.49 provider ids and permission modes, from the isolated provider catalogue. */
const provider = (key: string): ProviderTranslation => ({
  key, thinking: { ...sameLevels('low', 'medium', 'high', 'xhigh', 'max', 'ultra'), off: 'none' },
  modes: { 'accept-edits': { modeId: 'accept-edits' }, auto: { modeId: 'auto' }, 'full-access': { modeId: 'full' } },
});
export const bbVocabulary: HostVocabulary = {
  kind: 'bb', label: 'BB',
  providers: { codex: provider('codex'), claude: provider('claude-code'), pi: provider('pi'),
    cursor: provider('acp-cursor'), opencode: provider('acp-opencode'), omp: provider('acp-omp'), grok: provider('acp-grok') },
};
