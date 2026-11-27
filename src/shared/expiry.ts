// The expiry of checked items (#112). A checked item that nobody unchecks
// for EXPIRE_AFTER_DAYS is deleted. In the last OLDER_DAYS, the list page
// shows it in "Older items" with a badge. This file imports nothing.

export const DAY_MS = 24 * 60 * 60 * 1000;

/** A checked item is deleted this many days after its check. */
export const EXPIRE_AFTER_DAYS = 30;

/** In the last days before the delete, the item is in "Older items". */
export const OLDER_DAYS = 15;

/** The time of the delete of an item that was checked at `checkedAt`. */
export function expiresAt(checkedAt: number): number {
  return checkedAt + EXPIRE_AFTER_DAYS * DAY_MS;
}

/** Midnight at the start of the local day of `time`. */
function startOfDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * The local calendar days from `now` to `at`: 0 for today, 1 for tomorrow.
 * Not 24-hour periods: a delete on Wednesday at 11 pm is 1 day away for all
 * of Tuesday. A time in the past gives 0.
 */
export function daysLeft(at: number, now: number): number {
  // Round: a day with a DST change has 23 or 25 hours.
  const days = Math.round((startOfDay(at) - startOfDay(now)) / DAY_MS);
  return Math.max(0, days);
}

/** True if a checked item goes in "Older items" now. */
export function isOlder(checkedAt: number, now: number): boolean {
  return daysLeft(expiresAt(checkedAt), now) <= OLDER_DAYS;
}

export type ExpiryVariant = "brand" | "warning" | "danger";

/** The badge variant for the days that are left. */
export function expiryVariant(days: number): ExpiryVariant {
  if (days <= 1) return "danger";
  if (days <= 7) return "warning";
  return "brand";
}
