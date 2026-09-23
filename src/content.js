// SnapTask content script.
// Injected on demand by the background service worker.
// While text mode is active it:
//   1) Remembers the text you are selecting on the page, and
//   2) Shows a "Done ___ ✕" pill at the center of the screen
//      so you can confirm which text to send back to the popup,
//      or close out of text mode without saving anything.

// Prevent old copies of this script from stacking up in the same page.
if (window.__snaptaskInitDone__) {
  // A copy is already running here — do nothing extra.
} else {
  window.__snaptaskInitDone__ = true;
  main();

  function main() {
    let lastSelection = null; // Your most recent non-empty selection
    let modeActive = false;   // Whether SnapTask text mode is running
    let donePill = null;
    let toast = null;

    const MAX_TEXT_LENGTH = 5000;

    // Remember your selection as you make it.
    document.addEventListener("selectionchange", () => {
      if (!modeActive) return;

      const selection = window.getSelection();
      const text = selection ? selection.toString().trim() : "";

      if (text.length > 0) {
        lastSelection = {
          text: text.slice(0, MAX_TEXT_LENGTH),
          length: text.length,
        };
      }
    });

    // Grab whatever text is already selected on the page right now.
    function captureCurrentSelection() {
      const selection = window.getSelection();
      const text = selection ? selection.toString().trim() : "";

      if (text.length > 0) {
        lastSelection = {
          text: text.slice(0, MAX_TEXT_LENGTH),
          length: text.length,
        };
      }
    }

    // Tiny floating message.
    function showToast(message, durationMs = 2000) {
      if (toast) toast.remove();

      toast = document.createElement("div");
      toast.textContent = message;
      Object.assign(toast.style, {
        position: "fixed",
        top: "16px",
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: "2147483647",
        background: "#111827",
        color: "#ffffff",
        padding: "8px 14px",
        borderRadius: "8px",
        font: "13px/1.4 -apple-system, 'Segoe UI', Roboto, sans-serif",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
        pointerEvents: "none",
      });
      document.body.appendChild(toast);

      setTimeout(() => {
        if (toast) {
          toast.remove();
          toast = null;
        }
      }, durationMs);
    }

    // Show the pill: "Done" to confirm, "✕" to close without saving.
    function showDonePill() {
      donePill = document.createElement("div");
      Object.assign(donePill.style, {
        position: "fixed",
        top: "50%",
        left: "50%",
        transform: "translate(-50%, -50%)",
        zIndex: "2147483647",
        display: "flex",
        alignItems: "center",
        gap: "6px",
        background: "#0f766e",
        padding: "5px 5px 5px 6px",
        borderRadius: "999px",
        boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
      });

      const doneButton = document.createElement("button");
      doneButton.textContent = "Done";
      doneButton.title = "Confirm the selected text";
      Object.assign(doneButton.style, {
        border: "none",
        background: "transparent",
        color: "#ffffff",
        padding: "10px 18px",
        borderRadius: "999px",
        font: "600 14px/1 -apple-system, 'Segoe UI', Roboto, sans-serif",
        cursor: "pointer",
        userSelect: "none",
      });
      doneButton.addEventListener("click", handleDone);

      const closeButton = document.createElement("button");
      closeButton.textContent = "✕";
      closeButton.title = "Close text mode";
      closeButton.setAttribute("aria-label", "Close text mode");
      Object.assign(closeButton.style, {
        border: "none",
        background: "transparent",
        color: "#ffffff",
        width: "34px",
        height: "34px",
        borderRadius: "999px",
        font: "16px/1 -apple-system, 'Segoe UI', Roboto, sans-serif",
        cursor: "pointer",
        userSelect: "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      });
      closeButton.addEventListener("mouseenter", () => {
        closeButton.style.background = "rgba(255, 255, 255, 0.18)";
      });
      closeButton.addEventListener("mouseleave", () => {
        closeButton.style.background = "transparent";
      });
      closeButton.addEventListener("click", teardown);

      donePill.appendChild(doneButton);
      donePill.appendChild(closeButton);
      document.body.appendChild(donePill);
    }

    function handleKeyDown(event) {
      if (event.key === "Escape") teardown();
      if (event.key === "Enter") handleDone();
    }

    function handleDone() {
      if (!lastSelection) {
        showToast(
          "Select some text on this page first, then press Done.",
          3000
        );
        return;
      }

      // Close the pill right away — don't wait for the background to reply.
      chrome.runtime.sendMessage(
        {
          type: "SNAPTASK_TEXT_READY",
          text: lastSelection.text,
          length: lastSelection.length,
        },
        () => {
          if (chrome.runtime.lastError) {
            showToast(
              "Could not reach SnapTask. Reload the extension, then try again."
            );
          } else {
            showToast("Saved! Reopen SnapTask to preview.");
          }
        }
      );
      teardown();
    }

    function teardown() {
      modeActive = false;
      lastSelection = null;

      if (donePill) {
        donePill.remove();
        donePill = null;
      }
      document.removeEventListener("keydown", handleKeyDown);
    }

    // Entry point: the background asks this page to start text selection mode.
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request && request.type === "SNAPTASK_START_TEXT_SELECT") {
        teardown();
        modeActive = true;
        lastSelection = null;
        captureCurrentSelection();
        showDonePill();
        sendResponse({ started: true });
      }
    });
  }
}