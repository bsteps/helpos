const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** A timestamp from the API, in the reader's own locale and time zone. */
export function formatDateTime(iso: string): string {
  return dateTime.format(new Date(iso));
}
