// Reads text out of a screenshot — entirely on the user's computer.
// Uses Tesseract.js, a free, open-source text-reader (OCR library).
// Every engine file is bundled locally (dist/libs and dist/tessdata),
// so nothing is downloaded at runtime and the screenshot never leaves.

import { createWorker } from "tesseract.js";

let workerPromise = null;

export async function readTextFromImage(imageDataUrl) {
  if (!workerPromise) {
    // Point Tesseract at the files we ship inside the extension.
    // workerBlobURL must be false: the recognition engine locates its
    // .wasm by looking in the worker's own folder, which only works
    // with a real worker file, not a blob URL.
    workerPromise = createWorker("eng", 1, {
      logger: () => {}, // keep the popup console quiet
      workerPath: chrome.runtime.getURL("libs/worker.min.js"),
      workerBlobURL: false,
      corePath: chrome.runtime.getURL(
        "libs/tesseract-core-simd-lstm.wasm.js"
      ),
      langPath: chrome.runtime.getURL("tessdata"),
    });
  }

  const worker = await workerPromise;
  const { data } = await worker.recognize(imageDataUrl);
  const text = (data && data.text ? data.text : "").trim();
  return text;
}