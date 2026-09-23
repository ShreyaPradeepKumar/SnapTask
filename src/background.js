// SnapTask background service worker.
// Coordinates everything: takes the page photo, stores temporary captures,
// injects the selection overlay, and hands captures to the popup.

const CAPTURE_KEY = "snaptaskCapture";
const DRAFT_KEY = "snaptaskDraft";

// Tracks which tabs already have a fresh copy of the text helper,
// so we never inject a duplicate. Cleared whenever a tab navigates.
const textModeTabs = new Set();

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading") textModeTabs.delete(tabId);
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("SnapTask installed successfully.");
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.type) return;

  switch (request.type) {
    case "SNAPTASK_START_TEXT_SELECT":
      startTextSelect(sendResponse);
      return true;
    case "SNAPTASK_CAPTURE_SCREENSHOT":
      captureScreenshot(sendResponse);
      return true;
    case "SNAPTASK_OVERLAY_DONE":
      storeArea(request.rect, request.dpr).then(sendResponse);
      return true;
    case "SNAPTASK_TEXT_READY":
      storeText(request.text, request.length).then(sendResponse);
      return true;
    case "SNAPTASK_GET_CAPTURE":
      chrome.storage.session
        .get(CAPTURE_KEY)
        .then((data) =>
          sendResponse({ ok: true, capture: data[CAPTURE_KEY] || null })
        );
      return true;
    case "SNAPTASK_GET_DRAFT":
      chrome.storage.session
        .get(DRAFT_KEY)
        .then((data) =>
          sendResponse({ ok: true, draft: data[DRAFT_KEY] || null })
        );
      return true;
    case "SNAPTASK_SAVE_DRAFT":
      saveDraft(request.key, request.draft).then(sendResponse);
      return true;
    case "SNAPTASK_CLEAR_CAPTURE":
      chrome.storage.session
        .remove([CAPTURE_KEY, DRAFT_KEY])
        .then(() => sendResponse({ ok: true }));
      return true;
  }
});

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function startTextSelect(sendResponse) {
  let tab;
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs[0];
  } catch {
    sendResponse({ ok: false, error: "No active tab found." });
    return;
  }

  if (!tab || tab.id === chrome.tabs.TAB_ID_NONE) {
    sendResponse({ ok: false, error: "No active tab found." });
    return;
  }

  // Ask the helper living on the page to start selection mode.
  // Returns true only if an up-to-date helper confirmed it started.
  async function askPage() {
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, {
        type: "SNAPTASK_START_TEXT_SELECT",
      });
      return !!(reply && reply.started);
    } catch {
      return false;
    }
  }

  let started = await askPage();

  // If the helper is not already running on this page, inject the latest
  // copy (exactly once per page load), then ask again.
  if (!started && !textModeTabs.has(tab.id)) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      textModeTabs.add(tab.id);
      started = await askPage();
    } catch {
      sendResponse({
        ok: false,
        error: "Cannot select text on this page. Try a normal web page.",
      });
      return;
    }
  }

  if (!started) {
    sendResponse({
      ok: false,
      error: "Could not start text mode on this page. Try a normal web page.",
    });
    return;
  }

  sendResponse({ ok: true });
}

async function captureScreenshot(sendResponse) {
  try {
    const tab = await getActiveTab();
    if (!tab || tab.id === chrome.tabs.TAB_ID_NONE || !tab.windowId) {
      sendResponse({ ok: false, error: "No active tab found." });
      return;
    }

    // Photograph the visible part of the page (as a small JPEG).
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 85,
    });

    // Replace any previous capture and keep the photo in temporary memory.
    await chrome.storage.session.remove(CAPTURE_KEY);
    await chrome.storage.session.set({
      [CAPTURE_KEY]: { kind: "image", image: dataUrl },
    });

    // Show the drag-to-select overlay on the page.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content-overlay.js"],
    });

    sendResponse({ ok: true });
  } catch {
    sendResponse({
      ok: false,
      error: "Could not capture this page. Try a normal web page.",
    });
  }
}

async function storeArea(rect, dpr) {
  const data = await chrome.storage.session.get(CAPTURE_KEY);
  const capture = data[CAPTURE_KEY];

  if (!capture || capture.kind !== "image") return { ok: false };

  capture.rect = rect;
  capture.dpr = dpr;
  await chrome.storage.session.set({ [CAPTURE_KEY]: capture });
  return { ok: true };
}

async function storeText(text, length) {
  await chrome.storage.session.set({
    [CAPTURE_KEY]: { kind: "text", text, length },
  });
  return { ok: true };
}

// Keeps the user's edited event across popup opens.
// The draft is tagged with the capture it came from, so a later, different
// capture never inherits stale edits.
async function saveDraft(key, draft) {
  await chrome.storage.session.set({ [DRAFT_KEY]: { key, draft } });
  return { ok: true };
}