// The AI switchboard. This is the ONLY file to change when a different
// "brain" is used later (for example a free local model).
// Everything else just calls extractEvent().

import { mockExtract } from "./mockExtractor.js";
import { normalizeEvent } from "./schemas.js";

export async function extractEvent(capture) {
  const raw = await mockExtract({
    kind: capture && capture.kind,
    text: capture && capture.text,
    image: capture && capture.image,
  });
  return normalizeEvent(raw);
}