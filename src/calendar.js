// Creates, reads, updates, and deletes Google Calendar events.
//
// This intentionally runs in the popup, not the service worker:
// MV3 workers can be shut down while the Google consent window is open,
// which kills the pending request. A popup page stays alive while open,
// so the sign-in and the API calls are reliable.

const CALENDAR_ENDPOINT =
  "https://www.googleapis.com/calendar/v3/calendars/primary/events";

function localDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// "2026-09-25" + 1 → "2026-09-26"
function addDaysISO(iso, days) {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function totalMinutes(time) {
  const [hours, minutes] = String(time).split(":").map(Number);
  return hours * 60 + minutes;
}

// "14:30" + 60 → "15:30" (clamped to end of day).
function minutesLater(time, minutes) {
  const total = totalMinutes(time) + minutes;
  if (total >= 24 * 60) return "23:59";
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60
  ).padStart(2, "0")}`;
}

// Turns the edited draft into a Google Calendar API request body.
// Date only → all-day event; any time given → a timed event in the
// user's own timezone (missing date = today, missing end = +1 hour).
function buildEventBody(draft, timeZone) {
  const body = { summary: String(draft.title).trim() };

  if (draft.description && String(draft.description).trim()) {
    body.description = String(draft.description).trim();
  }
  if (draft.location && String(draft.location).trim()) {
    body.location = String(draft.location).trim();
  }

  const hasDate = Boolean(draft.date);
  const hasStart = Boolean(draft.startTime);

  if (!hasStart && hasDate) {
    // All-day event.
    body.start = { date: draft.date };
    body.end = { date: addDaysISO(draft.date, 1) };
  } else if (!hasStart && !hasDate) {
    // No date or time given — all-day for today.
    const date = localDateString(new Date());
    body.start = { date };
    body.end = { date: addDaysISO(date, 1) };
  } else {
    // Timed event.
    const date = hasDate ? draft.date : localDateString(new Date());
    const start = draft.startTime;
    body.start = { dateTime: `${date}T${start}:00`, timeZone };

    if (draft.endTime) {
      if (totalMinutes(draft.endTime) <= totalMinutes(start)) {
        body.end = {
          dateTime: `${addDaysISO(date, 1)}T${draft.endTime}:00`,
          timeZone,
        };
      } else {
        body.end = { dateTime: `${date}T${draft.endTime}:00`, timeZone };
      }
    } else {
      body.end = { dateTime: `${date}T${minutesLater(start, 60)}:00`, timeZone };
    }
  }

  return body;
}

// Turns a Google Calendar event back into the draft form values.
export function googleEventToDraft(ev) {
  const draft = {
    title: ev.summary || "",
    description: ev.description || "",
    location: ev.location || "",
    date: "",
    startTime: "",
    endTime: "",
  };

  const pad2 = (n) => String(n).padStart(2, "0");
  const start = ev.start || {};

  if (start.date) {
    // All-day event.
    draft.date = start.date;
  } else if (start.dateTime) {
    // Timed event — split the date and time in the user's local timezone.
    const local = new Date(start.dateTime);
    draft.date = localDateString(local);
    draft.startTime = `${pad2(local.getHours())}:${pad2(local.getMinutes())}`;

    const end = ev.end || {};
    if (end.dateTime) {
      const endLocal = new Date(end.dateTime);
      draft.endTime = `${pad2(endLocal.getHours())}:${pad2(endLocal.getMinutes())}`;
    }
  }

  return draft;
}

// Signs in (if needed) and hands back { token } or { error }.
async function getToken() {
  try {
    // Modern Chrome resolves this to an object ({ token, grantedScopes });
    // older versions resolve to a plain string. Handle both.
    const result = await chrome.identity.getAuthToken({ interactive: true });
    const token = typeof result === "string" ? result : result && result.token;
    if (!token) return { error: "Google sign-in returned no token." };
    return { token };
  } catch (err) {
    const detail = err && err.message ? err.message : String(err);
    if (/OAuth2|not properly set up/i.test(detail)) {
      return {
        error:
          "Google Calendar isn't configured yet. Add your Client ID to .env and rebuild.",
      };
    }
    return { error: "Google sign-in couldn't be completed (" + detail + ")." };
  }
}

// Reads the error message Google put in a failed response body.
async function errorDetail(response) {
  try {
    const body = await response.json();
    return (body && body.error && body.error.message) || "";
  } catch {
    return "";
  }
}

// Maps a Google API response to either null (success) or a failed result
// object. An expired permission refreshes the token cache so the next
// attempt re-prompts the user.
async function responseResult(response, token) {
  if (response.status === 401) {
    try {
      await chrome.identity.removeCachedAuthToken({ token });
    } catch {}
    return {
      ok: false,
      error:
        "Your Google permission expired — press the button again to re-authorize.",
    };
  }
  if (!response.ok) {
    const detail = await errorDetail(response);
    return {
      ok: false,
      notFound: response.status === 404,
      error:
        "Google Calendar refused the request (" + response.status + "). " + detail,
    };
  }
  return null;
}

// A rejected request here is almost always a browser-level block (CSP,
// CORS, host permissions) — not the user's internet. Show the real reason
// so it can be diagnosed instead of guessing.
function browserError(err) {
  const name = err && err.name ? err.name : "Error";
  const detail = err && err.message ? err.message : String(err);
  console.error("SnapTask could not reach Google Calendar:", err);
  return {
    ok: false,
    error:
      "The browser could not reach Google (" +
      name +
      ": " +
      detail +
      "). This is usually a browser-level block, not your internet — try refreshing the extension, or check the browser console.",
  };
}

function draftTitleError(draft) {
  const title = draft && draft.title ? String(draft.title).trim() : "";
  if (!title) return { error: "Event needs a title." };
  return { title };
}

function eventUrl(id) {
  return CALENDAR_ENDPOINT + "/" + encodeURIComponent(id);
}

// Creates the event. Resolves to:
//   { ok: true, id, htmlLink }  or  { ok: false, error }
export async function addEventToGoogleCalendar(draft) {
  const checked = draftTitleError(draft);
  if (checked.error) return { ok: false, error: checked.error };

  const auth = await getToken();
  if (auth.error) return { ok: false, error: auth.error };

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = buildEventBody(draft, timeZone);

  try {
    const response = await fetch(CALENDAR_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + auth.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const failure = await responseResult(response, auth.token);
    if (failure) return failure;

    const created = await response.json();
    return { ok: true, id: created.id || "", htmlLink: created.htmlLink || "" };
  } catch (err) {
    return browserError(err);
  }
}

// Fetches the current copy of an event. Resolves to:
//   { ok: true, event }  or  { ok: false, error, notFound }
export async function getCalendarEvent(id) {
  const auth = await getToken();
  if (auth.error) return { ok: false, error: auth.error };

  try {
    const response = await fetch(eventUrl(id), {
      headers: { Authorization: "Bearer " + auth.token },
    });

    const failure = await responseResult(response, auth.token);
    if (failure) return failure;

    const event = await response.json();
    return { ok: true, event };
  } catch (err) {
    return browserError(err);
  }
}

// Replaces the details of an existing event. Empty optional fields are
// sent as empty strings so a cleared description/location is actually
// cleared on Google too. Resolves to:
//   { ok: true, htmlLink }  or  { ok: false, error, notFound }
export async function updateCalendarEvent(id, draft) {
  const checked = draftTitleError(draft);
  if (checked.error) return { ok: false, error: checked.error };

  const auth = await getToken();
  if (auth.error) return { ok: false, error: auth.error };

  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const body = buildEventBody(draft, timeZone);
  // On update, empty optional fields clear the previous value instead of
  // being skipped (skipping would keep the old value on the event).
  body.description = draft.description
    ? String(draft.description).trim()
    : "";
  body.location = draft.location ? String(draft.location).trim() : "";

  try {
    const response = await fetch(eventUrl(id), {
      method: "PATCH",
      headers: {
        Authorization: "Bearer " + auth.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const failure = await responseResult(response, auth.token);
    if (failure) return failure;

    const updated = await response.json();
    return { ok: true, htmlLink: updated.htmlLink || "" };
  } catch (err) {
    return browserError(err);
  }
}

// Removes the event. Resolves to:
//   { ok: true }  or  { ok: false, error, notFound }
export async function deleteCalendarEvent(id) {
  const auth = await getToken();
  if (auth.error) return { ok: false, error: auth.error };

  try {
    const response = await fetch(eventUrl(id), {
      method: "DELETE",
      headers: { Authorization: "Bearer " + auth.token },
    });

    const failure = await responseResult(response, auth.token);
    if (failure) return failure;

    return { ok: true };
  } catch (err) {
    return browserError(err);
  }
}