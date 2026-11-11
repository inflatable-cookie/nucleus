/** Exhaustion stays distinct from daemon transport so it cannot enter an unlimited retry loop. */
export const SSH_AUTH_EXHAUSTED = 'SSH authentication retry budget exhausted';
export const isSshAuthExhausted = (value: unknown) => String(value instanceof Error ? value.message : value).includes(SSH_AUTH_EXHAUSTED);

/** Git/SSH diagnostics before repository access; remote hook output is not an authentication refusal. */
export function isSshAuthenticationFailure(stderr: string): boolean {
  if (/^remote:/m.test(stderr)) return false;
  // Git ends a missing-repository failure with the same "Could not read from remote repository" line.
  if (/does not appear to be a git repository|Repository not found/i.test(stderr)) return false;
  return /Permission denied \(publickey(?:,[^)]+)?\)|Could not read from remote repository|Could not open a connection to your authentication agent|Error connecting to agent:|sign_and_send_pubkey: signing failed[^\n]*agent|SSH_AUTH_SOCK[^\n]*(?:unreadable|No such file|Permission denied)/i.test(stderr);
}
