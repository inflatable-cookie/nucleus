import { dataHome } from "../data-home.mjs";

/** The data directory this environment resolves to; the same resolver every consumer uses. */
let cachedDefaultDataDir: string | undefined;
export const defaultDataDir = (env: NodeJS.ProcessEnv = process.env) =>
  env === process.env ? (cachedDefaultDataDir ??= dataHome(env)) : dataHome(env);
