/** An installed BB app: the CLI shim an operator runs and the launchers inside the app. */
export interface BbInstall {
  cli: string;
  serverLauncher: string;
  daemonLauncher: string;
}

export const bbCliCandidates: (home?: string) => string[];

export function findBbCli(options?: { home?: string }): {
  cli: string | null;
  tried: string[];
};

export function bbInstallFromCli(cli: string): {
  install: BbInstall | null;
  tried: string[];
};
