import { useEffect, useRef, useState } from "react";
import { extractEvent } from "../ai/extractor.js";
import { readTextFromImage } from "../ai/ocr.js";
import {
  addEventToGoogleCalendar,
  deleteCalendarEvent,
  getCalendarEvent,
  googleEventToDraft,
  updateCalendarEvent,
} from "../calendar.js";

const CALENDAR_RECORD_KEY = "snaptaskCalendar";

function App() {
  const [status, setStatus] = useState("Ready. Pick a capture method below.");
  const [busy, setBusy] = useState(false);
  const [capture, setCapture] = useState(null);
  const [imagePreview, setImagePreview] = useState(null);
  const [event, setEvent] = useState(null);
  const [draft, setDraft] = useState(null);
  const [extracting, setExtracting] = useState(false);
  // Screenshot reading states: idle | working | done | empty | error
  const [ocrState, setOcrState] = useState("idle");
  const [ocrText, setOcrText] = useState(null);
  const [ocrError, setOcrError] = useState(null);
  const [rerunToken, setRerunToken] = useState(0);
  const [restoreReady, setRestoreReady] = useState(false);
  const [calendarResult, setCalendarResult] = useState(null);
  const [calendarRecord, setCalendarRecord] = useState(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const extractedKeyRef = useRef(null);
  const restoredDraftRef = useRef(null);
  const liveDraftRef = useRef(null);

  // Remember / forget the Google Calendar event created for this capture.
  async function loadCalendarRecord() {
    const data = await chrome.storage.session.get(CALENDAR_RECORD_KEY);
    return data[CALENDAR_RECORD_KEY] || null;
  }

  async function saveCalendarRecord(record) {
    await chrome.storage.session.set({ [CALENDAR_RECORD_KEY]: record });
  }

  async function clearCalendarRecord() {
    await chrome.storage.session.remove(CALENDAR_RECORD_KEY);
  }

  // Sends a message to the background service worker and waits for a reply.
  function sendMessageToBackground(request) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(request, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          resolve({ ok: false, error: error.message });
        } else {
          resolve(response);
        }
      });
    });
  }

  // A short label matching a capture to the draft it produced.
  function captureKeyOf(cap) {
    if (!cap) return null;
    if (cap.kind === "text") return `text:${cap.text.slice(0, 40)}`;
    return "image";
  }

  // Apply an extraction: show the card, and seed the editable draft.
  // If the popup was reopened with a saved draft for this same capture,
  // restore the edits instead of starting over.
  function applyEvent(key, result) {
    setEvent(result);

    if (result && result.isEvent) {
      // If this capture already has a Google Calendar event, the form
      // mirrors Google's current copy rather than the extraction guess.
      if (liveDraftRef.current) {
        setDraft({ ...liveDraftRef.current });
      } else {
        const saved = restoredDraftRef.current;
        if (saved && saved.key === key && saved.draft) {
          setDraft({ ...saved.draft });
        } else {
          setDraft({ ...result });
        }
      }
    } else {
      setDraft(null);
    }
    restoredDraftRef.current = null;
  }

  // Runs the (mock) AI brain on some plain text.
  async function runExtraction(key, text) {
    setExtracting(true);
    setEvent(null);
    setDraft(null);
    const result = await extractEvent({ kind: "text", text });
    applyEvent(key, result);
    setExtracting(false);
  }

  // On open, ask for anything that was captured or drafted earlier.
  // Extraction waits until both replies arrive (restoreReady).
  useEffect(() => {
    (async () => {
      const [capRes, draftRes] = await Promise.all([
        sendMessageToBackground({ type: "SNAPTASK_GET_CAPTURE" }),
        sendMessageToBackground({ type: "SNAPTASK_GET_DRAFT" }),
      ]);

      if (draftRes && draftRes.ok && draftRes.draft) {
        restoredDraftRef.current = draftRes.draft;
      }
      if (capRes && capRes.ok) {
        setCapture(capRes.capture || null);
        setOcrError(null);
      }
      setCalendarRecord(await loadCalendarRecord());
      setRestoreReady(true);
    })();
  }, []);

  // When a capture appears, decide how to extract an event.
  // Text extracts directly; images wait for the screenshot reader.
  useEffect(() => {
    if (!restoreReady) return;

    if (!capture) {
      setEvent(null);
      setExtracting(false);
      setOcrState("idle");
      setOcrText(null);
      setOcrError(null);
      setDraft(null);
      setCalendarResult(null);
      extractedKeyRef.current = null;
      liveDraftRef.current = null;
      return;
    }

    const key = captureKeyOf(capture);

    // Google's saved copy only applies to the capture it was created for.
    if (!calendarRecord || calendarRecord.key !== key) {
      liveDraftRef.current = null;
    }

    if (extractedKeyRef.current === key) return; // Already handled this one.

    extractedKeyRef.current = key;
    setEvent(null);
    setOcrText(null);
    setOcrError(null);
    setDraft(null);
    setCalendarResult(null);

    if (capture.kind === "text") {
      setOcrState("idle");
      runExtraction(key, capture.text);
    } else {
      // Image: wait for the cropped preview before reading it.
      setOcrState(capture.rect ? "working" : "idle");
    }
  }, [capture, restoreReady, rerunToken]);

  // If the current capture already produced a Google Calendar event,
  // fetch its live details so the form mirrors what's actually on Google.
  useEffect(() => {
    if (!restoreReady || !capture || !calendarRecord) return;
    const key = captureKeyOf(capture);
    if (!key || calendarRecord.key !== key) return;

    let cancelled = false;
    (async () => {
      const live = await getCalendarEvent(calendarRecord.id);
      if (cancelled) return;
      if (live.ok && live.event) {
        liveDraftRef.current = googleEventToDraft(live.event);
        setDraft({ ...liveDraftRef.current });
      } else if (live.notFound) {
        // Gone on Google — forget it and offer to add it again.
        await clearCalendarRecord();
        setCalendarRecord(null);
        liveDraftRef.current = null;
        setStatus("That event no longer exists in Google Calendar.");
        setCalendarResult({
          ok: false,
          message:
            "The event was deleted in Google Calendar, so SnapTask forgot it. You can add it again.",
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [restoreReady, capture, calendarRecord]);

  // When there is a screenshot with a drag box, crop to that box,
  // then read the text out of it.
  useEffect(() => {
    if (!restoreReady) return;
    if (!capture || capture.kind !== "image") return;

    if (!imagePreview) return; // not cropped yet

    let cancelled = false;
    setOcrState("working");
    setExtracting(false);

    (async () => {
      let text = "";
      try {
        text = await readTextFromImage(imagePreview);
      } catch (err) {
        if (!cancelled) {
          setOcrError(err && err.message ? err.message : String(err));
          setOcrState("error");
        }
        return;
      }
      if (cancelled) return;

      if (!text) {
        setOcrState("empty");
        setEvent(null);
        setDraft(null);
        return;
      }

      setOcrState("done");
      setOcrText(text);
      await runExtraction(captureKeyOf(capture), text);
    })();

    return () => {
      cancelled = true;
    };
  }, [capture, imagePreview, restoreReady, rerunToken]);

  // Crop a screenshot with a drag box to that exact area.
  useEffect(() => {
    if (!capture || capture.kind !== "image") return;

    if (!capture.rect) {
      setImagePreview(null);
      return;
    }

    const img = new Image();
    img.onload = () => {
      const dpr = capture.dpr || 1;
      const canvas = document.createElement("canvas");
      canvas.width = capture.rect.width;
      canvas.height = capture.rect.height;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(
        img,
        capture.rect.x * dpr,
        capture.rect.y * dpr,
        capture.rect.width * dpr,
        capture.rect.height * dpr,
        0,
        0,
        capture.rect.width,
        capture.rect.height
      );
      setImagePreview(canvas.toDataURL("image/png"));
    };
    img.src = capture.image;
  }, [capture]);

  // Save the edited draft a short beat after the last keystroke,
  // so it survives closing the popup.
  useEffect(() => {
    if (!draft) return;
    const key = capture ? captureKeyOf(capture) : null;
    if (!key) return;

    const timer = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: "SNAPTASK_SAVE_DRAFT",
        key,
        draft,
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [draft, capture]);

  function updateDraftField(field, value) {
    setDraft((prev) => (prev ? { ...prev, [field]: value } : prev));
  }

  async function handleCaptureScreenshot() {
    setBusy(true);
    setStatus("Taking a screenshot...");

    const response = await sendMessageToBackground({
      type: "SNAPTASK_CAPTURE_SCREENSHOT",
    });

    if (response && response.ok) {
      setStatus("Drag to select an area, then reopen SnapTask to preview.");
    } else {
      setStatus(
        (response && response.error) || "Screenshot capture failed."
      );
    }

    setBusy(false);
  }

  async function handleUseSelectedText() {
    setBusy(true);
    setStatus("Starting text selection mode...");

    const response = await sendMessageToBackground({
      type: "SNAPTASK_START_TEXT_SELECT",
    });

    if (response && response.ok) {
      setStatus("Select text on the page, press Done, then reopen SnapTask.");
    } else {
      setStatus(
        (response && response.error) || "Could not start text selection."
      );
    }

    setBusy(false);
  }

  async function handleClear() {
    await sendMessageToBackground({ type: "SNAPTASK_CLEAR_CAPTURE" });
    await clearCalendarRecord();
    setCapture(null);
    setImagePreview(null);
    setEvent(null);
    setDraft(null);
    setExtracting(false);
    setOcrState("idle");
    setOcrText(null);
    setOcrError(null);
    setCalendarResult(null);
    setCalendarRecord(null);
    setDeleteArmed(false);
    extractedKeyRef.current = null;
    restoredDraftRef.current = null;
    liveDraftRef.current = null;
    setStatus("Cleared. Pick a capture method below.");
  }

  function handleRerun() {
    restoredDraftRef.current = null;
    extractedKeyRef.current = null;
    setRerunToken((token) => token + 1);
  }

  function handleResetDraft() {
    if (event) setDraft({ ...event });
  }

  async function handleAddToCalendar() {
    if (!draft || !draft.title || !String(draft.title).trim()) {
      setCalendarResult({ ok: false, message: "Add a title first." });
      return;
    }

    setBusy(true);
    setStatus("Adding to Google Calendar…");
    setCalendarResult(null);
    setDeleteArmed(false);

    const result = await addEventToGoogleCalendar(draft);

    setBusy(false);
    if (result.ok) {
      setStatus("Added to Google Calendar!");
      const key = capture ? captureKeyOf(capture) : null;
      const record = { key, id: result.id || "", htmlLink: result.htmlLink || "" };
      if (record.id) {
        await saveCalendarRecord(record);
        setCalendarRecord(record);
      }
      setCalendarResult({
        ok: true,
        message: "Added to Google Calendar ✓",
        url: result.htmlLink || "",
      });
    } else {
      const message = result.error || "Could not add the event.";
      setStatus(message);
      setCalendarResult({ ok: false, message });
    }
  }

  // Replaces the details of the event that already exists for this capture.
  async function handleUpdateEvent() {
    if (!draft || !draft.title || !String(draft.title).trim()) {
      setCalendarResult({ ok: false, message: "Add a title first." });
      return;
    }

    setBusy(true);
    setStatus("Updating Google Calendar event…");
    setCalendarResult(null);
    setDeleteArmed(false);

    const result = await updateCalendarEvent(calendarRecord.id, draft);

    setBusy(false);
    if (result.ok) {
      setStatus("Event updated!");
      setCalendarResult({
        ok: true,
        message: "Event updated ✓",
        url: result.htmlLink || calendarRecord.htmlLink || "",
      });
    } else if (result.notFound) {
      await clearCalendarRecord();
      setCalendarRecord(null);
      liveDraftRef.current = null;
      setStatus("That event no longer exists in Google Calendar.");
      setCalendarResult({
        ok: false,
        message:
          "The event was removed in Google Calendar, so SnapTask forgot it. You can add it again.",
      });
    } else {
      const message = result.error || "Could not update the event.";
      setStatus(message);
      setCalendarResult({ ok: false, message });
    }
  }

  // Two clicks to be safe: the first arms, the second really deletes.
  async function handleDeleteEvent() {
    if (!deleteArmed) {
      setDeleteArmed(true);
      setStatus("Click Confirm delete to remove the event.");
      return;
    }

    setBusy(true);
    setStatus("Deleting from Google Calendar…");
    setCalendarResult(null);

    const result = await deleteCalendarEvent(calendarRecord.id);

    setBusy(false);
    setDeleteArmed(false);
    if (result.ok || result.notFound) {
      await clearCalendarRecord();
      setCalendarRecord(null);
      liveDraftRef.current = null;
      setStatus(
        result.notFound
          ? "That event was already removed from Google Calendar."
          : "Event deleted from Google Calendar."
      );
      setCalendarResult({
        ok: result.ok,
        message: result.ok
          ? "Event deleted ✓"
          : "The event was already gone from Google Calendar.",
      });
    } else {
      const message = result.error || "Could not delete the event.";
      setStatus(message);
      setCalendarResult({ ok: false, message });
    }
  }

  const currentKey = capture ? captureKeyOf(capture) : null;
  const managing = !!(
    calendarRecord &&
    currentKey &&
    calendarRecord.key === currentKey
  );

  return (
    <main className="popup">
      <header className="popup__header">
        <svg
          className="popup__logo"
          width="44"
          height="44"
          viewBox="0 0 40 40"
          role="img"
          aria-label="SnapTask logo"
        >
          <rect x="2" y="2" width="36" height="36" rx="9" fill="#0f766e" />
          <path d="M23 8l-9 12h6l-2 10 9-12h-6l2-10z" fill="#ffffff" />
        </svg>
        <h1 className="popup__title">SnapTask</h1>
        <p className="popup__subtitle">Turn information into calendar events.</p>
      </header>

      <p className="popup__status" role="status">
        {status}
      </p>

      <button
        type="button"
        className="btn btn--primary"
        disabled={busy}
        onClick={handleCaptureScreenshot}
      >
        Capture Screenshot
      </button>
      <button
        type="button"
        className="btn btn--secondary"
        disabled={busy}
        onClick={handleUseSelectedText}
      >
        Use Selected Text
      </button>

      {capture && (
        <section className="capture">
          <div className="capture__header">
            <h2 className="capture__title">Current Capture</h2>
            <button
              type="button"
              className="capture__clear"
              onClick={handleClear}
            >
              Clear
            </button>
          </div>

          {capture.kind === "text" && (
            <>
              <p className="capture__meta">{capture.length} characters</p>
              <textarea
                className="capture__text"
                readOnly
                value={capture.text}
              />
            </>
          )}

          {capture.kind === "image" && imagePreview && (
            <img
              className="capture__image"
              src={imagePreview}
              alt="Cropped screenshot preview"
            />
          )}

          {capture.kind === "image" && !capture.rect && (
            <p className="capture__hint">
              Screenshot taken. Finish dragging the selection box on the page,
              then reopen SnapTask.
            </p>
          )}
        </section>
      )}

      {capture && (
        <section className="event">
          <h2 className="capture__title">Extracted Event</h2>

          {extracting && <p className="event__hint">Extracting…</p>}

          {!extracting && ocrState === "working" && (
            <p className="event__hint">
              Reading the photo… (first time is slow: small one-time download)
            </p>
          )}

          {!extracting && ocrState === "empty" && (
            <p className="event__hint">
              No readable text found in this screenshot. Try a clearer, larger
              capture.
            </p>
          )}

          {!extracting && ocrState === "error" && (
            <p className="event__hint">
              Could not read this screenshot. Try again with a clearer capture.
              {ocrError && (
                <span className="capture__hint"> Detail: {ocrError}</span>
              )}
            </p>
          )}

          {!extracting &&
            ocrState === "idle" &&
            capture.kind === "image" &&
            !event && (
              <p className="event__hint">
                Waiting for your selection on the page…
              </p>
            )}

          {!extracting && event && !event.isEvent && (
            <p className="event__hint">No event found in this capture.</p>
          )}

          {!extracting && event && event.isEvent && (
            <>
              {ocrState === "done" && ocrText && (
                <p className="event__hint">
                  Read {ocrText.length} characters from the screenshot.
                </p>
              )}
              <ul className="event__list">
                <li className="event__row">
                  <span className="event__label">Title</span>
                  <strong className="event__value">
                    {event.title || "—"}
                  </strong>
                </li>
                <li className="event__row">
                  <span className="event__label">Date</span>
                  <strong className="event__value">{event.date || "—"}</strong>
                </li>
                <li className="event__row">
                  <span className="event__label">Start</span>
                  <strong className="event__value">
                    {event.startTime || "—"}
                  </strong>
                </li>
                <li className="event__row">
                  <span className="event__label">End</span>
                  <strong className="event__value">
                    {event.endTime || "—"}
                  </strong>
                </li>
                <li className="event__row">
                  <span className="event__label">Location</span>
                  <strong className="event__value">
                    {event.location || "—"}
                  </strong>
                </li>
                <li className="event__row">
                  <span className="event__label">Description</span>
                  <strong className="event__value">
                    {event.description || "—"}
                  </strong>
                </li>
              </ul>
              <p className="event__confidence">
                Confidence: {Math.round(event.confidence * 100)}%
              </p>

              <div className="event-form">
                <h3 className="capture__title">Edit Event</h3>

                <div className="event-form__body">
                  <label className="event-form__field">
                    <span className="event-form__label">Title</span>
                    <input
                      className="event-form__input"
                      type="text"
                      value={draft.title || ""}
                      onChange={(e) => updateDraftField("title", e.target.value)}
                    />
                  </label>

                  <div className="event-form__row">
                    <label className="event-form__field">
                      <span className="event-form__label">Date</span>
                      <input
                        className="event-form__input"
                        type="date"
                        value={draft.date || ""}
                        onChange={(e) =>
                          updateDraftField("date", e.target.value)
                        }
                      />
                    </label>
                    <label className="event-form__field">
                      <span className="event-form__label">Start</span>
                      <input
                        className="event-form__input"
                        type="time"
                        value={draft.startTime || ""}
                        onChange={(e) =>
                          updateDraftField("startTime", e.target.value)
                        }
                      />
                    </label>
                  </div>

                  <div className="event-form__row">
                    <label className="event-form__field">
                      <span className="event-form__label">End</span>
                      <input
                        className="event-form__input"
                        type="time"
                        value={draft.endTime || ""}
                        onChange={(e) =>
                          updateDraftField("endTime", e.target.value)
                        }
                      />
                    </label>
                    <label className="event-form__field">
                      <span className="event-form__label">Location</span>
                      <input
                        className="event-form__input"
                        type="text"
                        value={draft.location || ""}
                        onChange={(e) =>
                          updateDraftField("location", e.target.value)
                        }
                      />
                    </label>
                  </div>

                  <label className="event-form__field">
                    <span className="event-form__label">Description</span>
                    <textarea
                      className="event-form__textarea"
                      value={draft.description || ""}
                      onChange={(e) =>
                        updateDraftField("description", e.target.value)
                      }
                    />
                  </label>
                </div>
              </div>

              <div className="event__actions">
                {managing ? (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={handleUpdateEvent}
                  >
                    Update event
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    disabled={busy}
                    onClick={handleAddToCalendar}
                  >
                    Add to Google Calendar
                  </button>
                )}
                <div className="event__actions-row">
                  <button
                    type="button"
                    className="btn btn--secondary btn--small"
                    onClick={handleRerun}
                  >
                    Re-run extraction
                  </button>
                  <button
                    type="button"
                    className="btn btn--secondary btn--small"
                    onClick={handleResetDraft}
                  >
                    Reset to extracted
                  </button>
                  {managing && (
                    <button
                      type="button"
                      className="btn btn--danger btn--small"
                      disabled={busy}
                      onClick={handleDeleteEvent}
                    >
                      {deleteArmed ? "Confirm delete" : "Delete event"}
                    </button>
                  )}
                </div>
                {calendarResult && (
                  <div
                    className={
                      calendarResult.ok
                        ? "calendar-result calendar-result--ok"
                        : "calendar-result calendar-result--error"
                    }
                  >
                    {calendarResult.ok ? (
                      <>
                        <span>{calendarResult.message || "Done ✓"}</span>
                        {calendarResult.url && (
                          <a
                            className="calendar-result__link"
                            href={calendarResult.url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            Open event
                          </a>
                        )}
                      </>
                    ) : (
                      <span>{calendarResult.message}</span>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      )}
    </main>
  );
}

export default App;