// Turns human words for days and times into plain values, using the
// user's local clock. Unknown things return null — we never guess.

const WEEKDAYS = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function addDays(date, days) {
  const out = new Date(date);
  out.setDate(out.getDate() + days);
  return out;
}

// Returns "YYYY-MM-DD" using the computer's local date.
function toDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// "today" → today, "tomorrow" → +1, "friday" → the coming Friday,
// "next monday" → next week's Monday, "weekend" → this Saturday.
export function parseDayExpression(raw, now = new Date()) {
  const word = String(raw || "").toLowerCase().trim().replace(/\s+/g, " ");

  if (word === "today") return toDateString(now);
  if (word === "tomorrow") return toDateString(addDays(now, 1));
  if (word === "weekend" || word === "this weekend") {
    return toDateString(addDays(now, (6 - now.getDay() + 7) % 7));
  }

  const nextOnly = word.startsWith("next ");
  const weekdayName = nextOnly ? word.slice(5).trim() : word;
  if (!(weekdayName in WEEKDAYS)) return null;

  let days = (WEEKDAYS[weekdayName] - now.getDay() + 7) % 7;
  if (nextOnly && days === 0) days = 7; // "next monday" from a Monday = +7
  return toDateString(addDays(now, days));
}

// "2 pm" / "2:30 PM" / "at 14:00" → "HH:MM" (24-hour), or null.
export function parseTimeString(text) {
  const source = String(text || "").trim();
  if (!source) return null;

  const patterns = [
    /(\d{1,2}):(\d{2})\s*(am|pm)?/i,
    /(?:at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
    /\b(\d{1,2})\s*(am|pm)\b/i,
  ];

  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (!match) continue;

    let hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2] || "0", 10);
    const meridiem = (match[3] || "").toLowerCase();

    if (meridiem) {
      if (meridiem === "pm" && hours < 12) hours += 12;
      if (meridiem === "am" && hours === 12) hours = 0;
    } else if (hours > 23) {
      continue; // Not a valid 24-hour time.
    }

    if (hours > 23 || minutes > 59) continue;

    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  return null;
}

// Scans a whole sentence and pulls out date, start time and end time.
export function extractDateTimeInfo(text, now = new Date()) {
  const info = { date: null, startTime: null, endTime: null };
  if (!text) return info;
  const source = String(text);

  // 1. A day word: today, tomorrow, weekend, friday, next monday...
  const dayMatch = source.toLowerCase().match(
    /\b((?:next\s+)?(?:today|tomorrow|(?:this\s+)?weekend|sunday|monday|tuesday|wednesday|thursday|friday|saturday))\b/
  );
  if (dayMatch) info.date = parseDayExpression(dayMatch[1], now);

  // 2. A range like "from 2 to 3 pm" or "2 - 3:30 pm".
  const rangeMatch = source.match(
    /\b(?:from\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\s*(?:-|to)\s*(\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i
  );
  if (rangeMatch) {
    info.startTime = parseTimeString(rangeMatch[1]);
    info.endTime = parseTimeString(rangeMatch[2]);
  }

  // 3. Otherwise a single time word.
  if (!info.startTime) info.startTime = parseTimeString(source);

  return info;
}