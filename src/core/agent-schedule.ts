import type { AgentSchedule, AgentScheduleInterval } from "../types/agent";
import { isValidIanaTimeZone } from "../types/preferences";

interface LocalDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const DAY_SCHEDULE_COARSE_LOOKBACK_INTERVALS = 8;
const DAY_SCHEDULE_FINAL_LOOP_GUARD = 1000;

function parseLocalDateTime(value: string): LocalDateParts {
  const match = value.trim().match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?$/,
  );
  if (match) {
    return {
      year: Number(match[1]),
      month: Number(match[2]),
      day: Number(match[3]),
      hour: Number(match[4] ?? "0"),
      minute: Number(match[5] ?? "0"),
      second: Number(match[6] ?? "0"),
    };
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid local date/time: ${value}`);
  }
  return {
    year: parsed.getUTCFullYear(),
    month: parsed.getUTCMonth() + 1,
    day: parsed.getUTCDate(),
    hour: parsed.getUTCHours(),
    minute: parsed.getUTCMinutes(),
    second: parsed.getUTCSeconds(),
  };
}

function getTimeZoneOffsetMs(utcDate: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(utcDate);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values["year"]),
    Number(values["month"]) - 1,
    Number(values["day"]),
    Number(values["hour"]),
    Number(values["minute"]),
    Number(values["second"]),
  );
  return asUtc - utcDate.getTime();
}

export function localDateTimeToUtc(value: string, timezone: string): Date {
  if (!isValidIanaTimeZone(timezone)) {
    throw new Error(`Invalid scheduler timezone: ${timezone}`);
  }
  const parts = parseLocalDateTime(value);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  let utcTime = localAsUtc - getTimeZoneOffsetMs(new Date(localAsUtc), timezone);
  utcTime = localAsUtc - getTimeZoneOffsetMs(new Date(utcTime), timezone);
  return new Date(utcTime);
}

function addCalendarDays(date: Date, days: number, timezone: string): Date {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const localNoon = new Date(Date.UTC(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"]) + days,
    Number(parts["hour"]),
    Number(parts["minute"]),
    Number(parts["second"]),
  ));
  const localValue = [
    String(localNoon.getUTCFullYear()).padStart(4, "0"),
    String(localNoon.getUTCMonth() + 1).padStart(2, "0"),
    String(localNoon.getUTCDate()).padStart(2, "0"),
  ].join("-")
    + "T"
    + [
      String(localNoon.getUTCHours()).padStart(2, "0"),
      String(localNoon.getUTCMinutes()).padStart(2, "0"),
      String(localNoon.getUTCSeconds()).padStart(2, "0"),
    ].join(":");
  return localDateTimeToUtc(localValue, timezone);
}

function addInterval(date: Date, interval: AgentScheduleInterval, timezone: string): Date {
  if (interval.unit === "minutes") {
    return new Date(date.getTime() + interval.value * MINUTE_MS);
  }
  if (interval.unit === "hours") {
    return new Date(date.getTime() + interval.value * HOUR_MS);
  }

  return addCalendarDays(date, interval.value, timezone);
}

function advanceDurationSchedule(start: Date, intervalMs: number, after: Date): Date {
  if (start.getTime() > after.getTime()) {
    return start;
  }
  const elapsedIntervals = Math.floor((after.getTime() - start.getTime()) / intervalMs) + 1;
  return new Date(start.getTime() + elapsedIntervals * intervalMs);
}

function advanceDaySchedule(start: Date, interval: AgentScheduleInterval, timezone: string, after: Date): Date {
  let next = start;
  if (next.getTime() > after.getTime()) {
    return next;
  }

  const intervalMs = interval.value * DAY_MS;
  const coarseIntervals = Math.max(
    0,
    Math.floor((after.getTime() - next.getTime()) / intervalMs) - DAY_SCHEDULE_COARSE_LOOKBACK_INTERVALS,
  );
  if (coarseIntervals > 0) {
    next = addCalendarDays(next, coarseIntervals * interval.value, timezone);
  }

  let guard = 0;
  while (next.getTime() <= after.getTime()) {
    next = addInterval(next, interval, timezone);
    guard += 1;
    if (guard > DAY_SCHEDULE_FINAL_LOOP_GUARD) {
      throw new Error("Unable to calculate next agent run; day schedule did not converge");
    }
  }
  return next;
}

export function calculateNextRunAt(
  schedule: Omit<AgentSchedule, "nextRunAt"> | AgentSchedule,
  after: Date = new Date(),
): string {
  const start = localDateTimeToUtc(schedule.startAtLocal, schedule.timezone);
  if (schedule.interval.unit === "minutes") {
    return advanceDurationSchedule(start, schedule.interval.value * MINUTE_MS, after).toISOString();
  }
  if (schedule.interval.unit === "hours") {
    return advanceDurationSchedule(start, schedule.interval.value * HOUR_MS, after).toISOString();
  }
  return advanceDaySchedule(start, schedule.interval, schedule.timezone, after).toISOString();
}
