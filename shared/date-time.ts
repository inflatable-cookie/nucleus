/** Local calendar helpers for the date-time field; pure, so they run under plain node too. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
export const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;
export const MINUTES = [0, 15, 30, 45] as const;
export const pad = (n: number) => String(n).padStart(2, "0");
export const DAY_MS = 24 * 60 * 60 * 1000;

/** A stored ISO instant in the operator's local time, for example "Thu 22 Oct 2026, 07:00". */
export function formatLocalDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${WEEKDAYS[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The days of one month as Monday-first weeks; `null` pads the first and last week. */
export function monthGrid(year: number, month: number): (number | null)[][] {
  const lead = (new Date(year, month, 1).getDay() + 6) % 7;
  const days = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, w) => cells.slice(w * 7, w * 7 + 7));
}


/**
 * The same instant moved to `minute` past its local hour by elapsed time, so a
 * repeated DST hour keeps the occurrence it is in.
 */
export function withMinute(instant: Date, minute: number): Date {
  return new Date(instant.getTime() + (minute - instant.getMinutes()) * 60_000 - instant.getSeconds() * 1000 - instant.getMilliseconds());
}

/**
 * The instant moved to another local calendar day at the same wall time. The
 * day already shown is a no-op, so re-selecting it never moves a repeated DST
 * hour to its other occurrence.
 */
export function withDay(instant: Date, year: number, month: number, day: number): Date {
  if (instant.getFullYear() === year && instant.getMonth() === month && instant.getDate() === day) return instant;
  const next = new Date(instant.getTime());
  next.setFullYear(year, month, day);
  return next;
}
