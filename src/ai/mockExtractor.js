// The current SnapTask "brain".
// It uses simple word rules to pull event details straight from the text,
// so the rest of the app can be built without paying for an AI service.
// When a real (ideally free/local) model is available, only the
// switchboard in extractor.js needs to change.

import { extractDateTimeInfo } from "./dateParser.js";
import { emptyEvent } from "./schemas.js";

export async function mockExtract({ kind, text }) {
  if (kind === "text" && text) return extractFromText(text);
  if (kind === "image") return extractFromImage();
  return emptyEvent();
}

function extractFromText(text) {
  const dt = extractDateTimeInfo(text);

  const event = emptyEvent();
  event.date = dt.date;
  event.startTime = dt.startTime;
  event.endTime = dt.endTime;
  event.location = findLocation(text);
  event.title = guessTitle(text);
  event.description = guessDescription(text);
  event.isEvent = Boolean(event.date || event.startTime || event.endTime || event.title);
  event.confidence = 0.7;
  return event;
}

// Finds a location like "in Lab 3" or "at the library" (skips times).
function findLocation(text) {
  const pattern = /\b(?:in|at)\s+(?:the\s+)?([A-Za-z][A-Za-z0-9 .,'’-]{1,40})/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const candidate = match[1].trim();
    if (/^[0-9]/.test(candidate)) continue; // e.g. "11 AM"
    if (/\b(?:am|pm)\b/i.test(candidate)) continue; // e.g. "2:00 PM"
    return candidate.replace(/[.,;:]+$/, "").trim(); // drop stray punctuation
  }
  return null;
}

// The title is the part of the sentence before the date/time word.
function guessTitle(text) {
  const cleaned = String(text).replace(/\s+/g, " ").trim();
  const cut = cleaned.search(
    /\b(?:on|at|in|today|tomorrow|next)\b|\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
  );
  if (cut > 0) return cleaned.slice(0, cut).trim();

  const firstSentence = cleaned.split(/[.!?]/)[0];
  return firstSentence.split(" ").slice(0, 6).join(" ");
}

// Extra context = any second sentence.
function guessDescription(text) {
  const sentences = String(text).split(/(?<=[.!?])\s+/);
  if (sentences.length > 1) {
    const rest = sentences.slice(1).join(" ").trim();
    return rest.length > 0 ? rest : null;
  }
  return null;
}

// Without a vision model we cannot read the picture yet.
// Return a clearly-labeled demo so the flow can still be tested.
function extractFromImage() {
  return {
    isEvent: true,
    title: "Demo event (mock brain)",
    date: null,
    startTime: null,
    endTime: null,
    location: null,
    description: "The mock brain cannot read pictures yet. A free, local vision model will be added later.",
    confidence: 0.3,
  };
}