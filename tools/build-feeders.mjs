import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import DxfParser from "dxf-parser";

const DWG = "cad/FINAL DISPATCH - UPDATE.dwg";
const OUT = "data/feeders";
const DXF = "/tmp/final-dispatch.dxf";

fs.mkdirSync(OUT, { recursive: true });

console.log("========================================");
console.log("FINAL FEEDER DATABASE BUILDER");
console.log("========================================");

if (!fs.existsSync(DWG)) {
  throw new Error(`DWG file not found: ${DWG}`);
}

// --------------------------------------------------
// Convert DWG -> DXF
// --------------------------------------------------

console.log("Converting DWG to DXF...");

execFileSync("dwg2dxf", ["-o", DXF, DWG], {
  stdio: "inherit"
});

if (!fs.existsSync(DXF)) {
  throw new Error("DXF conversion failed.");
}

const dxfText = fs.readFileSync(DXF, "utf8");

console.log(`DWG size: ${fs.statSync(DWG).size} bytes`);
console.log(`DXF size: ${fs.statSync(DXF).size} bytes`);

// --------------------------------------------------
// Parse DXF
// --------------------------------------------------

console.log("Parsing DXF...");

const parser = new DxfParser();
const dxf = parser.parseSync(dxfText);

const entities = dxf.entities || [];

console.log(`DXF entities: ${entities.length}`);

// --------------------------------------------------
// Clean DXF text
// --------------------------------------------------

function cleanText(value) {
  if (value === undefined || value === null) {
    return "";
  }

  let text = String(value);

  // Remove common AutoCAD MTEXT formatting codes
  text = text
    .replace(/\\P/gi, " ")
    .replace(/\\A\d+;/gi, "")
    .replace(/\\H[^;]+;/gi, "")
    .replace(/\\C\d+;/gi, "")
    .replace(/\\F[^;]+;/gi, "")
    .replace(/\\W[^;]+;/gi, "")
    .replace(/\\T[^;]+;/gi, "")
    .replace(/\\Q[^;]+;/gi, "")
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
// Extract text entities
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

  textEntities.push({
    type,
    text,
    layer: entity.layer || null,
    position: entity.position
      ? {
          x: entity.position.x ?? null,
          y: entity.position.y ?? null,
          z: entity.position.z ?? null
        }
      : null
  });
}

console.log(`Text entities: ${textEntities.length}`);

// --------------------------------------------------
// FEEDER NAME DETECTION
//
// Supported examples:
//
// F-8.13
// F-03
// F-2.20
// FDR#2.20
// QAI.F-05
// BSP.F-15
// D.F-03
// U.F-02
// UNI.F-24
// --------------------------------------------------

function extractFeederNames(text) {
  const results = new Set();

  if (!text) {
    return [];
  }

  // Remove DXF formatting
  const cleaned = cleanText(text);

  // ------------------------------------------------
  // Pattern 1:
  // F-8.13
  // F-03
  // F-2.20
  //
  // Also accepts prefixes:
  // QAI.F-05
  // BSP.F-15
  // D.F-03
  // U.F-02
  // UNI.F-24
  // ------------------------------------------------

  const fPattern =
    /\b(?:[A-Z][A-Z0-9]*\.)*F\s*-\s*\d+(?:\.\d+)?\b/gi;

  for (const match of cleaned.matchAll(fPattern)) {
    const value = match[0]
      .replace(/\s+/g, "")
      .toUpperCase();

    results.add(value);
  }

  // ------------------------------------------------
  // Pattern 2:
  // FDR#2.20
  // FDR#2.07
  // FDR # 2.16
  // ------------------------------------------------

  const fdrPattern =
    /\bFDR\s*#\s*\d+(?:\.\d+)?\b/gi;

  for (const match of cleaned.matchAll(fdrPattern)) {
    const value = match[0]
      .replace(/\s+/g, "")
      .toUpperCase();

    results.add(value);
  }

  return [...results];
}

// --------------------------------------------------
// Build feeder occurrences
// --------------------------------------------------

const feederMap = new Map();

for (const entity of textEntities) {
  const names = extractFeederNames(entity.text);

  for (const name of names) {
    if (!feederMap.has(name)) {
      feederMap.set(name, {
        name,
        occurrences: 0,
        layers: new Set(),
        positions: []
      });
    }

    const feeder = feederMap.get(name);

    feeder.occurrences++;

    if (entity.layer) {
      feeder.layers.add(entity.layer);
    }

    if (entity.position) {
      feeder.positions.push({
        x: entity.position.x,
        y: entity.position.y,
        z: entity.position.z,
        layer: entity.layer || null,
        type: entity.type
      });
    }
  }
}

// --------------------------------------------------
// Convert Sets to arrays
// --------------------------------------------------

const feeders = [...feederMap.values()]
  .map(feeder => ({
    name: feeder.name,
    occurrences: feeder.occurrences,
    layers: [...feeder.layers].sort(),
    positions: feeder.positions
  }))
  .sort((a, b) =>
    a.name.localeCompare(b.name, undefined, {
      numeric: true,
      sensitivity: "base"
    })
  );

// --------------------------------------------------
// Simple name list
// --------------------------------------------------

const feederNames = feeders.map(feeder => feeder.name);

// --------------------------------------------------
// Statistics
// --------------------------------------------------

const prefixStats = {};

for (const feeder of feeders) {
  let category = "F";

  if (feeder.name.startsWith("FDR#")) {
    category = "FDR";
  } else if (feeder.name.includes(".F-")) {
    category = "PREFIX.F";
  }

  prefixStats[category] =
    (prefixStats[category] || 0) + 1;
}

// --------------------------------------------------
// Manifest
// --------------------------------------------------

const manifest = {
  source: DWG,
  generatedAt: new Date().toISOString(),

  dwgBytes: fs.statSync(DWG).size,
  dxfBytes: fs.statSync(DXF).size,

  dxfEntities: entities.length,
  textEntities: textEntities.length,

  totalFeeders: feeders.length,

  categories: prefixStats,

  description:
    "Feeder database extracted directly from the DWG. Names are taken from actual feeder labels found in the drawing."
};

// --------------------------------------------------
// Save files
// --------------------------------------------------

console.log("");
console.log("Writing feeder database...");

fs.writeFileSync(
  path.join(OUT, "feeders.json"),
  JSON.stringify(feeders, null, 2),
  "utf8"
);

fs.writeFileSync(
  path.join(OUT, "feeder_names.json"),
  JSON.stringify(feederNames, null, 2),
  "utf8"
);

fs.writeFileSync(
  path.join(OUT, "manifest.json"),
  JSON.stringify(manifest, null, 2),
  "utf8"
);

// --------------------------------------------------
// Save all text entities for later equipment matching
// --------------------------------------------------

fs.writeFileSync(
  path.join(OUT, "all_text_entities.json"),
  JSON.stringify(textEntities, null, 2),
  "utf8"
);

// --------------------------------------------------
// Print results
// --------------------------------------------------

console.log("");
console.log("========================================");
console.log("FEEDER DATABASE RESULT");
console.log("========================================");

console.log(`Total feeders: ${feeders.length}`);

console.log("");
console.log("Categories:");
console.log(JSON.stringify(prefixStats, null, 2));

console.log("");
console.log("FEEDER LIST:");
console.log("----------------------------------------");

for (const feeder of feeders) {
  console.log(
    `${feeder.name} | occurrences: ${feeder.occurrences} | layers: ${feeder.layers.join(", ")}`
  );
}

console.log("");
console.log("========================================");
console.log("FEEDER DATABASE BUILD COMPLETED");
console.log("========================================");

// --------------------------------------------------
// Cleanup
// --------------------------------------------------

try {
  fs.unlinkSync(DXF);
} catch {
  // Ignore cleanup errors.
}
