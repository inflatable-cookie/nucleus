/**
 * Nucleus#1543: the date rules a parked lead's recheck uses on the board and the lead screen. A
 * recheck is a calendar day, read in the operator's local time: the default is two weeks out, and a
 * chosen day is checked at 09:00 local, so the stored instant and the day shown agree everywhere.
 */
export const PARK_DEFAULT_DAYS = 14;
const RECHECK_HOUR = 9;
const DAY_MS = 86_400_000;

const pad = (value: number) => String(value).padStart(2, "0");

/** The default recheck day as `YYYY-MM-DD`, two weeks after `now` in local time. */
export function defaultRecheckDate(now: Date = new Date()): string {
  const day = new Date(now.getTime() + PARK_DEFAULT_DAYS * DAY_MS);
  return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
}

/**
 * The stored recheck instant for a chosen `YYYY-MM-DD` day, or null when the text is not a real
 * day or the day is not after `now`. Rolled-over dates (2026-02-31) are refused, not moved.
 */
export function recheckIsoFromDate(
  value: string,
  now: Date = new Date(),
): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const at = new Date(year, month - 1, day, RECHECK_HOUR, 0, 0, 0);
  if (
    at.getFullYear() !== year ||
    at.getMonth() !== month - 1 ||
    at.getDate() !== day
  )
    return null;
  if (at.getTime() <= now.getTime()) return null;
  return at.toISOString();
}

/** A stored recheck instant as the day it is checked, in words: "6 Dec 2026". */
export function recheckDateLabel(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The parked status's detail: "check again 6 Dec 2026", or a plain note when the park has no date. */
export function parkedCheckLabel(revisitAt: string | null): string {
  return revisitAt
    ? `check again ${recheckDateLabel(revisitAt)}`
    : "no recheck date set";
}
