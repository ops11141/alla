import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import DxfParser from "dxf-parser";

const DWG = "cad/FINAL DISPATCH - UPDATE.dwg";
const OUT = "data/feeders";
const DXF = "/tmp/final-dispatch.dxf";

fs.mkdirSync(OUT, { recursive: true });

console.log("========================================");
console.log("FEEDER DWG DIAGNOSTIC");
console.log("========================================");

if (!fs.existsSync(DWG)) {
  throw new Error(`DWG file not found: ${DWG}`);
}

console.log(`DWG: ${DWG}`);
console.log(`DWG size: ${fs.statSync(DWG).size} bytes`);

// --------------------------------------------------
// 1. Convert DWG -> DXF
// --------------------------------------------------

console.log("");
console.log("Converting DWG to DXF...");

execFileSync("dwg2dxf", ["-o", DXF, DWG], {
  stdio: "inherit"
});

if (!fs.existsSync(DXF)) {
  throw new Error("DXF conversion failed.");
}

const dxfText = fs.readFileSync(DXF, "utf8");

console.log(`DXF size: ${fs.statSync(DXF).size} bytes`);
console.log(`DXF text size: ${dxfText.length} characters`);

// --------------------------------------------------
// 2. Parse DXF
// --------------------------------------------------

console.log("");
console.log("Parsing DXF...");

const parser = new DxfParser();
const dxf = parser.parseSync(dxfText);

const entities = dxf.entities || [];

console.log(`Total DXF entities: ${entities.length}`);

// --------------------------------------------------
// Helpers
// --------------------------------------------------

function cleanText(value) {
  if (value === undefined || value === null) {
    return "";
  }

  let text = String(value);

  // DXF MTEXT formatting
  text = text
    .replace(/\\P/gi, " ")
    .replace(/\\A\d+;/gi, "")
    .replace(/\\H[^;]+;/gi, "")
    .replace(/\\C\d+;/gi, "")
    .replace(/\\F[^;]+;/gi, "")
    .replace(/\\S([^;]+);/gi, "$1")
    .replace(/[{}]/g, " ");

  return text
    .replace(/\s+/g, " ")
    .trim();
}

function getEntityText(entity) {
  const values = [];

  if (typeof entity.text === "string") {
    values.push(entity.text);
  }

  if (typeof entity.textValue === "string") {
    values.push(entity.textValue);
  }

  if (typeof entity.string === "string") {
    values.push(entity.string);
  }

  if (typeof entity.value === "string") {
    values.push(entity.value);
  }

  if (typeof entity.content === "string") {
    values.push(entity.content);
  }

  if (Array.isArray(entity.text)) {
    values.push(...entity.text);
  }

  return values
    .map(cleanText)
    .filter(Boolean)
    .join(" ");
}

// --------------------------------------------------
// 3. Extract TEXT / MTEXT
// --------------------------------------------------

const textEntities = [];

for (const entity of entities) {
  const type = String(entity.type || "").toUpperCase();

  if (
    type !== "TEXT" &&
    type !== "MTEXT" &&
    type !== "ATTRIB" &&
    type !== "ATTDEF"
  ) {
    continue;
  }

  const text = getEntityText(entity);

  if (!text) {
    continue;
  }

  const item = {
    type,
    text,
    layer: entity.layer || null
  };

  if (entity.position) {
    item.position = {
      x: entity.position.x ?? null,
      y: entity.position.y ?? null,
      z: entity.position.z ?? null
    };
  }

  textEntities.push(item);
}

console.log(`TEXT/MTEXT entities found: ${textEntities.length}`);

// --------------------------------------------------
// 4. Count text values
// --------------------------------------------------

const textCounts = new Map();

for (const item of textEntities) {
  const value = item.text;

  textCounts.set(
    value,
    (textCounts.get(value) || 0) + 1
  );
}

const textValueCounts = [...textCounts.entries()]
  .map(([text, count]) => ({
    text,
    count
  }))
  .sort((a, b) => {
    if (b.count !== a.count) {
      return b.count - a.count;
    }

    return a.text.localeCompare(b.text);
  });

console.log(`Unique text values: ${textValueCounts.length}`);

// --------------------------------------------------
// 5. Broad diagnostic candidates
//
// IMPORTANT:
// This does NOT declare these to be feeders.
// It only finds interesting text for inspection.
// --------------------------------------------------

const candidates = [];

for (const item of textValueCounts) {
  const text = item.text;

  if (!text) {
    continue;
  }

  // Ignore extremely long paragraphs.
  if (text.length > 100) {
    continue;
  }

  const upper = text.toUpperCase();

  const hasNumber = /\d/.test(text);
  const hasLetter = /[A-Z\u0600-\u06FF]/i.test(text);

  if (!hasNumber || !hasLetter) {
    continue;
  }

  const keyword =
    /\bFEEDER\b/i.test(text) ||
    /\bFDR\b/i.test(text) ||
    /\bFD\b/i.test(text) ||
    /\bOUTGOING\b/i.test(text) ||
    /\bINCOMING\b/i.test(text) ||
    /\bRMU\b/i.test(text) ||
    /\bSUB\b/i.test(text) ||
    /\bSUB-/i.test(text) ||
    /\b11\s*KV\b/i.test(text) ||
    /\b13\.8\s*KV\b/i.test(text) ||
    /\b33\s*KV\b/i.test(text);

  const compactElectrical =
    /^[A-Z]{1,8}[-_/ ]?\d+[A-Z0-9._/-]*$/i.test(text);

  const mixedNumber =
    /[A-Z]+\s*[-_/]?\s*\d+/i.test(text);

  if (keyword || compactElectrical || mixedNumber) {
    candidates.push({
      text,
      count: item.count
    });
  }
}

// --------------------------------------------------
// 6. Layer statistics
// --------------------------------------------------

const layerCounts = new Map();

for (const item of textEntities) {
  const layer = item.layer || "(NO LAYER)";

  layerCounts.set(
    layer,
    (layerCounts.get(layer) || 0) + 1
  );
}

const layers = [...layerCounts.entries()]
  .map(([layer, count]) => ({
    layer,
    count
  }))
  .sort((a, b) => b.count - a.count);

// --------------------------------------------------
// 7. Candidate entities with positions/layers
// --------------------------------------------------

const candidateSet = new Set(
  candidates.map(item => item.text)
);

const candidateEntities = textEntities
  .filter(item => candidateSet.has(item.text))
  .map(item => ({
    text: item.text,
    type: item.type,
    layer: item.layer,
    position: item.position || null
  }));

// --------------------------------------------------
// 8. Save diagnostic files
// --------------------------------------------------

console.log("");
console.log("Writing diagnostic database...");

fs.writeFileSync(
  path.join(OUT, "text_value_counts.json"),
  JSON.stringify(textValueCounts, null, 2),
  "utf8"
);

fs.writeFileSync(
  path.join(OUT, "keyword_candidates.json"),
  JSON.stringify(candidates, null, 2),
  "utf8"
);

fs.writeFileSync(
  path.join(OUT, "candidate_entities.json"),
  JSON.stringify(candidateEntities, null, 2),
  "utf8"
);

fs.writeFileSync(
  path.join(OUT, "layers.json"),
  JSON.stringify(layers, null, 2),
  "utf8"
);

fs.writeFileSync(
  path.join(OUT, "all_text_entities.json"),
  JSON.stringify(textEntities, null, 2),
  "utf8"
);

// --------------------------------------------------
// 9. Manifest
// --------------------------------------------------

const manifest = {
  source: DWG,
  generatedAt: new Date().toISOString(),
  dwgBytes: fs.statSync(DWG).size,
  dxfBytes: fs.statSync(DXF).size,
  dxfCharacters: dxfText.length,
  totalDxfEntities: entities.length,
  textEntities: textEntities.length,
  uniqueTextValues: textValueCounts.length,
  diagnosticCandidates: candidates.length,
  layers: layers.length,
  note:
    "Diagnostic extraction only. Candidate texts are NOT confirmed feeder names."
};

fs.writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8"
);

// --------------------------------------------------
// 10. Print useful results to GitHub Actions log
// --------------------------------------------------

console.log("");
console.log("========================================");
console.log("DIAGNOSTIC RESULT");
console.log("========================================");

console.log(`TEXT entities       : ${textEntities.length}`);
console.log(`Unique text values  : ${textValueCounts.length}`);
console.log(`Candidate values    : ${candidates.length}`);
console.log(`Layers              : ${layers.length}`);

console.log("");
console.log("TOP POSSIBLE FEEDER / ELECTRICAL TEXT:");
console.log("----------------------------------------");

const preview = candidates.slice(0, 200);

if (preview.length === 0) {
  console.log("No diagnostic candidates found.");
} else {
  for (const item of preview) {
    console.log(`[${item.count}] ${item.text}`);
  }
}

console.log("");
console.log("TOP TEXT VALUES:");
console.log("----------------------------------------");

for (const item of textValueCounts.slice(0, 100)) {
  console.log(`[${item.count}] ${item.text}`);
}

console.log("");
console.log("TOP TEXT LAYERS:");
console.log("----------------------------------------");

for (const item of layers.slice(0, 100)) {
  console.log(`[${item.count}] ${item.layer}`);
}

console.log("");
console.log("========================================");
console.log("DIAGNOSTIC BUILD COMPLETED");
console.log("========================================");

// Remove temporary DXF
try {
  fs.unlinkSync(DXF);
} catch {
  // Ignore cleanup errors.
}
