// SnapTask screenshot area selector.
// This is injected into a webpage after the popup takes the screenshot.
// The user drags a box over the area they want; the box coordinates are
// sent back so the popup can crop the photo to exactly that area.
// A "✕ Close" button (and Escape) cancel the selection and discard the
// stored screenshot.

(function () {
  let drawing = false;
  let startX = 0;
  let startY = 0;

  const overlay = document.createElement("div");
  const selector = document.createElement("div");

  Object.assign(overlay.style, {
    position: "fixed",
    inset: "0",
    zIndex: "2147483646",
    background: "rgba(0, 0, 0, 0.35)",
    cursor: "crosshair",
  });

  Object.assign(selector.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: "0",
    height: "0",
    border: "2px dashed #22c55e",
    background: "rgba(34, 197, 94, 0.15)",
    pointerEvents: "none",
  });

  // Visible close button (top-right), so the user can bail out without
  // needing the keyboard.
  const closeButton = document.createElement("button");
  closeButton.textContent = "✕ Close";
  closeButton.title = "Cancel screenshot selection";
  closeButton.setAttribute("aria-label", "Cancel screenshot selection");
  Object.assign(closeButton.style, {
    position: "fixed",
    top: "18px",
    right: "18px",
    zIndex: "2147483647",
    background: "#111827",
    color: "#ffffff",
    border: "none",
    padding: "10px 16px",
    borderRadius: "999px",
    font: "600 13px/1 -apple-system, 'Segoe UI', Roboto, sans-serif",
    cursor: "pointer",
    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.25)",
  });
  closeButton.addEventListener("mouseenter", () => {
    closeButton.style.background = "#1f2937";
  });
  closeButton.addEventListener("mouseleave", () => {
    closeButton.style.background = "#111827";
  });
  // Don't let the drag-to-select handlers swallow the button press.
  closeButton.addEventListener("mousedown", (event) => event.stopPropagation());
  closeButton.addEventListener("click", cancel);

  overlay.appendChild(selector);
  overlay.appendChild(closeButton);
  document.documentElement.appendChild(overlay);

  function showToast(message) {
    const toast = document.createElement("div");
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
    setTimeout(() => toast.remove(), 2000);
  }

  function updateSelector(x, y, width, height) {
    selector.style.left = `${x}px`;
    selector.style.top = `${y}px`;
    selector.style.width = `${width}px`;
    selector.style.height = `${height}px`;
  }

  function onMouseDown(event) {
    if (event.button !== 0) return;
    drawing = true;
    startX = event.clientX;
    startY = event.clientY;
    updateSelector(startX, startY, 0, 0);
  }

  function onMouseMove(event) {
    if (!drawing) return;
    const x = Math.min(startX, event.clientX);
    const y = Math.min(startY, event.clientY);
    const width = Math.abs(event.clientX - startX);
    const height = Math.abs(event.clientY - startY);
    updateSelector(x, y, width, height);
  }

  function onMouseUp(event) {
    if (!drawing) return;
    drawing = false;

    const width = Math.abs(event.clientX - startX);
    const height = Math.abs(event.clientY - startY);

    if (width < 10 || height < 10) {
      cancel(); // Too small to matter — treat as a cancel.
      return;
    }

    const rect = {
      x: Math.round(Math.min(startX, event.clientX)),
      y: Math.round(Math.min(startY, event.clientY)),
      width: Math.round(width),
      height: Math.round(height),
    };

    chrome.runtime.sendMessage(
      {
        type: "SNAPTASK_OVERLAY_DONE",
        rect,
        dpr: window.devicePixelRatio || 1,
      },
      () => {
        showToast("Area saved! Reopen SnapTask to preview.");
        setTimeout(removeOverlay, 1500);
      }
    );
  }

  function onKeyDown(event) {
    if (event.key === "Escape") cancel();
  }

  // Cancel the selection: close the overlay and discard the stored
  // screenshot so the popup does not show a stale "waiting" state.
  function cancel() {
    showToast("Screenshot cancelled.");
    chrome.runtime.sendMessage({ type: "SNAPTASK_CLEAR_CAPTURE" });
    removeOverlay();
  }

  function removeOverlay() {
    overlay.remove();
    document.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("keydown", onKeyDown);
  }

  document.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", onKeyDown);
})();