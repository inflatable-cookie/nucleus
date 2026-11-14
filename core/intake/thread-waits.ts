/**
 * The lifecycle wait texts one launched run records and its report clears. The
 * launcher and the report intake both read them from here, so a reword cannot
 * leave a report waiting on a sentence nothing writes any more.
 */
export function threadRunningReason(role: string): string {
  return `${role} thread running`;
}

export function threadReleasePendingReason(role: string): string {
  return `${role} result received; waiting for thread release`;
}
