// Copies the non-React extension files into the dist/ folder.
// Vite builds the popup; this script adds the manifest (with the Google
// Client ID injected from .env), background and content scripts, and the
// bundled (offline) OCR engine so the whole extension loads from dist/.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distDir = path.join(rootDir, "dist");

mkdirSync(distDir, { recursive: true });

// 1. Manifest with the Google Client ID injected from .env.
function loadDotEnv() {
  const envPath = path.join(rootDir, ".env");
  if (!existsSync(envPath)) return {};
  const loaded = {};
  for (const rawLine of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = rawLine.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    loaded[match[1]] = value;
  }
  return loaded;
}

const clientId = loadDotEnv().SNAPTASK_GOOGLE_CLIENT_ID || "";

let manifestText = readFileSync(
  path.join(rootDir, "src", "manifest.json"),
  "utf8"
);
manifestText = manifestText.replace(
  "__SNAPTASK_GOOGLE_CLIENT_ID__",
  clientId
);
if (!clientId) {
  console.warn(
    "Warning: SNAPTASK_GOOGLE_CLIENT_ID is not set (.env missing or empty). " +
      "Google sign-in (phase 5) will not work until it is configured."
  );
}
writeFileSync(path.join(distDir, "manifest.json"), manifestText);

// 2. Core extension files.
const files = [
  ["src/background.js", "background.js"],
  ["src/content.js", "content.js"],
  ["src/content-overlay.js", "content-overlay.js"],
];

for (const [from, to] of files) {
  cpSync(path.join(rootDir, from), path.join(distDir, to));
}

// 3. Offline OCR engine (Tesseract.js), shipped inside the extension.
const ocrLibs = [
  ["node_modules/tesseract.js/dist/worker.min.js", "libs/worker.min.js"],
  [
    "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm.js",
    "libs/tesseract-core-simd-lstm.wasm.js",
  ],
  [
    "node_modules/tesseract.js-core/tesseract-core-simd-lstm.wasm",
    "libs/tesseract-core-simd-lstm.wasm",
  ],
];

for (const [from, to] of ocrLibs) {
  const source = path.join(rootDir, from);
  if (!existsSync(source)) {
    throw new Error(`Missing OCR engine file: ${from}. Run "npm install" first.`);
  }
  cpSync(source, path.join(distDir, to));
}

// 4. English language file for the OCR engine.
// Kept in vendor/tessdata/ (downloaded once) so builds stay offline.
const vendorLang = path.join(rootDir, "vendor", "tessdata", "eng.traineddata.gz");
const tessdataUrl =
  "https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz";

if (!existsSync(vendorLang)) {
  console.log("Downloading the OCR language file (one time)…");
  const response = await fetch(tessdataUrl);
  if (!response.ok) {
    throw new Error(
      `Could not download ${tessdataUrl} (status ${response.status}). ` +
        "Download it manually into vendor/tessdata/eng.traineddata.gz."
    );
  }
  mkdirSync(path.dirname(vendorLang), { recursive: true });
  writeFileSync(vendorLang, Buffer.from(await response.arrayBuffer()));
  console.log("OCR language file downloaded into vendor/tessdata/.");
}

cpSync(vendorLang, path.join(distDir, "tessdata", "eng.traineddata.gz"));

console.log("Extension files copied into dist/.");