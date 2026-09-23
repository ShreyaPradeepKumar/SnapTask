// The official SnapTask event shape.
// Every extraction result (real or mock) is passed through this file
// so it always arrives on screen in a clean, predictable format.

export function emptyEvent() {
  return {
    isEvent: false,
    title: null,
    date: null,
    startTime: null,
    endTime: null,
    location: null,
    description: null,
    confidence: 0,
  };
}

// Makes a raw result match the official shape.
// Unknown or empty fields become null — we never invent information.
export function normalizeEvent(raw) {
  const event = emptyEvent();

  if (!raw || typeof raw !== "object") return event;

  return {
    ...event,
    isEvent: Boolean(raw.isEvent),
    title: cleanString(raw.title),
    date: raw.date || null,
    startTime: raw.startTime || null,
    endTime: raw.endTime || null,
    location: cleanString(raw.location),
    description: cleanString(raw.description),
    confidence:
      typeof raw.confidence === "number"
        ? Math.max(0, Math.min(1, raw.confidence))
        : 0,
  };
}

function cleanString(value) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}