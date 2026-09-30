const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

export function zonedParts(
  timestamp: string | Date,
  timeZone: string,
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  date: string;
} {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  });
  const raw = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value]),
  );
  const year = Number(raw.year);
  const month = Number(raw.month);
  const day = Number(raw.day);
  return {
    year,
    month,
    day,
    hour: Number(raw.hour),
    minute: Number(raw.minute),
    second: Number(raw.second),
    weekday: WEEKDAY_TO_ISO[String(raw.weekday)]!,
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
  };
}

export function localDateTimeToUtc(
  date: { year: number; month: number; day: number },
  clock: string,
  timeZone: string,
): Date {
  const [hour, minute] = clock.split(':').map(Number);
  const desiredAsUtc = Date.UTC(
    date.year,
    date.month - 1,
    date.day,
    hour,
    minute,
    0,
    0,
  );

  let guess = desiredAsUtc;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(guess), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      0,
    );
    const delta = desiredAsUtc - actualAsUtc;
    if (delta === 0) break;
    guess += delta;
  }

  return new Date(guess);
}
