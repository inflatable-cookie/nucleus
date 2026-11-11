import type { Adapter } from '../../host/adapter';
import type { ResolutionAdapter } from '../../resolution';

/** Machine-owned launch operations, backed by the current adapter for compatibility. */
export type LaunchMachinePorts = Pick<Adapter, 'verifyPr' | 'verifyPrIdentity' | 'verifyResume' | 'readStash' | 'runTemporaryDirectory' | 'purgeReportingFiles'>
  & Pick<Partial<ResolutionAdapter>, 'coveringEvidence' | 'authorCommentEvidence'>;
