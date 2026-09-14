import { Schema } from "effect";

const ISO_INSTANT_PATTERN =
  /^(\d{4}|[+-]\d{6})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):(\d{2}))$/;

function isValidIsoInstant(value: string): boolean {
  const match = ISO_INSTANT_PATTERN.exec(value);
  if (match === null) return false;

  const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = match;
  const year = Number(rawYear);
  const month = Number(rawMonth);
  const day = Number(rawDay);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    Number(rawHour) <= 23 &&
    Number(rawMinute) <= 59 &&
    Number(rawSecond ?? 0) <= 59 &&
    Number(match[7] ?? 0) <= 23 &&
    Number(match[8] ?? 0) <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

/** A validated ISO 8601 instant decoded to a Date. */
export const IsoInstant = Schema.String.pipe(
  Schema.filter(isValidIsoInstant),
  Schema.compose(Schema.Date),
);
