```javascript
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ROOT = process.cwd();

const DWG_PATH = path.join(
  ROOT,
  "cad",
  "FINAL DISPATCH - UPDATE.dwg"
);

const OUT_DIR = path.join(
  ROOT,
  "data",
  "feeders"
);

const DXF_PATH = path.join(
  OUT_DIR,
  "FINAL DISPATCH - UPDATE.dxf"
);

await fs.mkdir(OUT_DIR, { recursive: true });

function writeJson(filename, data) {
  return fs.writeFile(
    path.join(OUT_DIR, filename),
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function cleanText(value) {
  return String(value ?? "")
    .replace(/\\P/gi, " ")
    .replace(/\{\\[^;{}]*;?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalize(value) {
  return cleanText(value)
    .toUpperCase()
    .replace(/[‐-‒–—−]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/*
 * أسماء المغذيات:
 *
 * نقبل الأسماء الموجودة فعليًا في الرسم فقط.
 *
 * أمثلة:
 * F-8.13
 * F8.13
 * F 8.13
 * FEEDER 8.13
 * F-333 B
 *
 * لا يتم إنشاء أي اسم جديد.
 */
function isFeederName(text) {
  const s = normalize(text);

  return (
    /^F\s*[-_]?\s*\d+(?:\s*[.-]\s*\d+)?(?:\s*[A-Z])?$/.test(s) ||
    /^FEEDER\s*[-_]?\s*\d+(?:\s*[.-]\s*\d+)?(?:\s*[A-Z])?$/.test(s)
  );
}

/*
 * أسماء المحطات التي تظهر حرفيًا في الرسم.
 */
function isStationName(text) {
  const s = normalize(text);

  return (
    /^(SUB|SS|STATION)\s*[-_]?\s*[A-Z0-9.-]+$/i.test(s) ||
    /^SUB\s*[-_]?\s*\d+$/i.test(s)
  );
}

/*
 * استخراج TEXT و MTEXT من DXF.
 *
 * DXF عبارة عن أزواج:
 *
 * 0
 * TEXT
 * 8
 * LAYER
 * 1
 * النص
 */
function parseDxfText(dxf) {
  const lines = dxf.split(/\r?\n/);

  const entities = [];

  let section = null;
  let entity = null;
  let lastCode = null;

  function finishEntity() {
    if (!entity) return;

    if (
      entity.type === "TEXT" ||
      entity.type === "MTEXT"
    ) {
      entities.push(entity);
    }

    entity = null;
  }

  for (let i = 0; i < lines.length - 1; i += 1) {
    const codeLine = lines[i].trim();
    const valueLine = lines[i + 1];

    if (!codeLine) continue;

    const code = Number(codeLine);

    if (!Number.isFinite(code)) {
      continue;
    }

    const value = valueLine ?? "";

    if (code === 0) {
      finishEntity();

      if (value.trim() === "SECTION") {
        section = "SECTION";
        lastCode = code;
        continue;
      }

      if (value.trim() === "ENDSEC") {
        finishEntity();
        section = null;
        lastCode = code;
        continue;
      }

      if (
        value.trim() === "TEXT" ||
        value.trim() === "MTEXT"
      ) {
        entity = {
          type: value.trim(),
          layer: null,
          text: "",
          x: null,
          y: null
        };
      }

      lastCode = code;
      continue;
    }

    if (!entity) {
      lastCode = code;
      continue;
    }

    if (code === 8) {
      entity.layer = value.trim();
    }

    if (code === 1) {
      entity.text = cleanText(value);
    }

    if (code === 3 && entity.type === "MTEXT") {
      entity.text += cleanText(value);
    }

    if (code === 10) {
      entity.x = Number(value);
    }

    if (code === 20) {
      entity.y = Number(value);
    }

    lastCode = code;
  }

  finishEntity();

  return entities;
}

console.log("");
console.log("========================================");
console.log("FEEDER DATABASE BUILDER");
console.log("========================================");

console.log("DWG:", DWG_PATH);

const stat = await fs.stat(DWG_PATH);

console.log(
  `DWG size: ${stat.size.toLocaleString()} bytes`
);

/*
 * =====================================================
 * تحويل DWG → DXF
 * =====================================================
 */

console.log("");
console.log("Converting DWG to DXF using LibreDWG...");

try {
  await execFileAsync(
    "dwg2dxf",
    [
      "-y",
      "-o",
      DXF_PATH,
      DWG_PATH
    ],
    {
      maxBuffer: 1024 * 1024 * 20
    }
  );
} catch (error) {
  console.error(
    "dwg2dxf stdout:",
    error.stdout ?? ""
  );

  console.error(
    "dwg2dxf stderr:",
    error.stderr ?? ""
  );

  throw new Error(
    `DWG to DXF conversion failed: ${error.message}`
  );
}

const dxfStat = await fs.stat(DXF_PATH);

console.log(
  `DXF created: ${dxfStat.size.toLocaleString()} bytes`
);

if (dxfStat.size === 0) {
  throw new Error(
    "LibreDWG produced an empty DXF file."
  );
}

/*
 * =====================================================
 * قراءة DXF
 * =====================================================
 */

console.log("");
console.log("Reading DXF...");

const dxf = await fs.readFile(
  DXF_PATH,
  "utf8"
);

console.log(
  `DXF text size: ${dxf.length.toLocaleString()} characters`
);

const textEntities = parseDxfText(dxf);

console.log(
  `TEXT/MTEXT entities found: ${textEntities.length}`
);

/*
 * =====================================================
 * استخراج أسماء الطبقات
 * =====================================================
 */

const layers = [
  ...new Set(
    textEntities
      .map((x) => x.layer)
      .filter(Boolean)
  )
].sort();

/*
 * =====================================================
 * استخراج جميع النصوص
 * =====================================================
 */

const allTextEntities = textEntities.map(
  (item, index) => ({
    id: index + 1,
    type: item.type,
    layer: item.layer,
    text: item.text,
    x: item.x,
    y: item.y
  })
);

/*
 * =====================================================
 * استخراج المغذيات
 * =====================================================
 */

const feederCandidates = [];

for (const item of textEntities) {
  if (!item.text) continue;

  if (!isFeederName(item.text)) {
    continue;
  }

  feederCandidates.push({
    name: item.text,
    normalized: normalize(item.text),
    layer: item.layer,
    x: item.x,
    y: item.y,
    source: "DWG_TEXT"
  });
}

/*
 * =====================================================
 * إزالة التكرارات الحرفية
 *
 * نحتفظ بالموقع إذا كان الاسم مكررًا في أماكن
 * مختلفة داخل الرسم.
 * =====================================================
 */

const uniqueFeeders = [];

const feederKeys = new Set();

for (const feeder of feederCandidates) {
  const key = [
    feeder.normalized,
    feeder.layer ?? "",
    feeder.x ?? "",
    feeder.y ?? ""
  ].join("|");

  if (feederKeys.has(key)) {
    continue;
  }

  feederKeys.add(key);

  uniqueFeeders.push(feeder);
}

/*
 * =====================================================
 * استخراج المحطات
 * =====================================================
 */

const stationCandidates = [];

for (const item of textEntities) {
  if (!item.text) continue;

  if (!isStationName(item.text)) {
    continue;
  }

  stationCandidates.push({
    name: item.text,
    normalized: normalize(item.text),
    layer: item.layer,
    x: item.x,
    y: item.y,
    source: "DWG_TEXT"
  });
}

/*
 * =====================================================
 * ترتيب
 * =====================================================
 */

uniqueFeeders.sort((a, b) =>
  a.normalized.localeCompare(
    b.normalized,
    undefined,
    {
      numeric: true,
      sensitivity: "base"
    }
  )
);

stationCandidates.sort((a, b) =>
  a.normalized.localeCompare(
    b.normalized,
    undefined,
    {
      numeric: true,
      sensitivity: "base"
    }
  )
);

/*
 * =====================================================
 * Manifest
 * =====================================================
 */

const manifest = {
  ok: true,

  sourceFile:
    "FINAL DISPATCH - UPDATE.dwg",

  convertedFile:
    "FINAL DISPATCH - UPDATE.dxf",

  reader:
    "LibreDWG dwg2dxf 0.14",

  counts: {
    textEntities:
      allTextEntities.length,

    layers:
      layers.length,

    feederCandidates:
      feederCandidates.length,

    uniqueFeeders:
      uniqueFeeders.length,

    stationCandidates:
      stationCandidates.length
  },

  rules: {
    literalNamesOnly: true,

    noSyntheticFeederNames: true,

    noSyntheticStationNames: true,

    unresolvedRelationshipsAreNotGuessed: true,

    rawDatabaseFileDisabled: true
  }
};

/*
 * =====================================================
 * حفظ النتائج
 * =====================================================
 */

await writeJson(
  "manifest.json",
  manifest
);

await writeJson(
  "layers.json",
  layers
);

await writeJson(
  "all_text_entities.json",
  allTextEntities
);

await writeJson(
  "all_feeder_candidates.json",
  feederCandidates
);

await writeJson(
  "stations.json",
  stationCandidates
);

await writeJson(
  "feeders.json",
  uniqueFeeders
);

/*
 * لا نريد رفع DXF إلى GitHub لأنه قد يكون كبيرًا.
 * نستخدمه مؤقتًا فقط أثناء البناء.
 */

await fs.rm(
  DXF_PATH,
  {
    force: true
  }
);

/*
 * حذف الملف الضخم القديم إن وجد.
 */

await fs.rm(
  path.join(
    OUT_DIR,
    "raw_database.json"
  ),
  {
    force: true
  }
);

/*
 * =====================================================
 * منع النجاح الوهمي
 * =====================================================
 */

if (
  textEntities.length === 0
) {
  throw new Error(
    "No TEXT or MTEXT entities were extracted from the DXF."
  );
}

if (
  uniqueFeeders.length === 0
) {
  throw new Error(
    "DXF was read successfully, but no literal feeder names were found."
  );
}

/*
 * =====================================================
 * النتيجة
 * =====================================================
 */

console.log("");
console.log("========================================");
console.log("FEEDER DATABASE BUILD COMPLETED");
console.log("========================================");

console.log(
  `Layers: ${layers.length}`
);

console.log(
  `Text entities: ${allTextEntities.length}`
);

console.log(
  `Feeder candidates: ${feederCandidates.length}`
);

console.log(
  `Unique feeders: ${uniqueFeeders.length}`
);

console.log(
  `Station candidates: ${stationCandidates.length}`
);

console.log("");
console.log(
  "First feeder names:"
);

for (
  const feeder
  of uniqueFeeders.slice(0, 30)
) {
  console.log(
    `- ${feeder.name}`
  );
}

console.log("");
console.log("========================================");

console.log(
  JSON.stringify(
    manifest,
    null,
    2
  )
);
```
