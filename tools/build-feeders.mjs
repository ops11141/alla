import fs from "node:fs/promises";
import path from "node:path";

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

await fs.mkdir(
  OUT_DIR,
  { recursive: true }
);

function jsonSafe(value) {
  return JSON.stringify(
    value,
    (key, v) => {
      if (typeof v === "bigint") {
        return Number(v);
      }

      if (v instanceof Uint8Array) {
        return Array.from(v);
      }

      return v;
    },
    2
  );
}

async function writeJson(
  filename,
  data
) {
  const filePath = path.join(
    OUT_DIR,
    filename
  );

  await fs.writeFile(
    filePath,
    jsonSafe(data),
    "utf8"
  );

  console.log(
    `Written: ${filename}`
  );
}

function extractText(
  value,
  output = []
) {
  if (value == null) {
    return output;
  }

  if (typeof value === "string") {
    const text = value.trim();

    if (text) {
      output.push(text);
    }

    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      extractText(
        item,
        output
      );
    }

    return output;
  }

  if (typeof value === "object") {
    for (
      const [key, val]
      of Object.entries(value)
    ) {
      if (
        /text|value|name|contents|string/i.test(
          key
        )
      ) {
        extractText(
          val,
          output
        );
      }
    }
  }

  return output;
}

function unique(array) {
  return [
    ...new Set(array)
  ];
}

console.log("");
console.log(
  "========================================"
);
console.log(
  "FEEDER DATABASE BUILDER"
);
console.log(
  "========================================"
);

console.log(
  "DWG:",
  DWG_PATH
);

const fileBuffer =
  await fs.readFile(
    DWG_PATH
  );

console.log(
  `DWG size: ${fileBuffer.length} bytes`
);

/*
 * =====================================================
 * LibreDWG الرسمي
 * =====================================================
 */

const {
  Dwg_File_Type,
  LibreDwg
} = await import(
  "@mlightcad/libredwg-web"
);

console.log(
  "Creating LibreDwg..."
);

const libredwg =
  await LibreDwg.create(
    path.join(
      ROOT,
      "node_modules",
      "@mlightcad",
      "libredwg-web",
      "wasm"
    )
  );

console.log(
  "LibreDwg created successfully."
);

/*
 * =====================================================
 * قراءة DWG
 * =====================================================
 */

console.log(
  "Reading DWG..."
);

const dwg =
  libredwg.dwg_read_data(
    fileBuffer.buffer.slice(
      fileBuffer.byteOffset,
      fileBuffer.byteOffset +
        fileBuffer.byteLength
    ),
    Dwg_File_Type.DWG
  );

if (!dwg) {
  throw new Error(
    "LibreDwg returned an empty DWG pointer."
  );
}

console.log(
  "DWG pointer received."
);

/*
 * =====================================================
 * معلومات DWG
 * =====================================================
 */

let dwgVersion = null;
let codepage = null;

try {
  dwgVersion =
    libredwg.dwg_get_version_type(
      dwg
    );
} catch {}

try {
  codepage =
    libredwg.dwg_get_codepage(
      dwg
    );
} catch {}

console.log(
  "DWG version:",
  dwgVersion
);

console.log(
  "Codepage:",
  codepage
);

/*
 * =====================================================
 * تحويل DWG إلى Database
 * =====================================================
 */

console.log(
  "Converting DWG..."
);

let db;

if (
  typeof libredwg.convertEx ===
  "function"
) {

  console.log(
    "Using convertEx()..."
  );

  const converted =
    libredwg.convertEx(
      dwg
    );

  db =
    converted?.database ??
    converted;

} else {

  console.log(
    "Using convert()..."
  );

  db =
    libredwg.convert(
      dwg
    );
}

if (!db) {
  throw new Error(
    "DWG conversion returned an empty database."
  );
}

console.log(
  "Database conversion completed."
);

/*
 * =====================================================
 * استخراج الجداول
 * =====================================================
 */

const tables =
  db?.tables ?? {};

const blockRecords =
  Array.isArray(
    tables.blockRecords
  )
    ? tables.blockRecords
    : [];

const layers =
  Array.isArray(
    tables.layers
  )
    ? tables.layers
    : [];

console.log("");
console.log(
  "Database:"
);

console.log(
  "Block records:",
  blockRecords.length
);

console.log(
  "Layers:",
  layers.length
);

/*
 * =====================================================
 * استخراج النصوص
 * =====================================================
 */

const allText = [];

const feederCandidates = [];

const stationCandidates = [];

for (
  const block
  of blockRecords
) {

  const blockName =
    block?.name ??
    block?.id ??
    "";

  const entities =
    Array.isArray(
      block?.entities
    )
      ? block.entities
      : [];

  for (
    const entity
    of entities
  ) {

    const texts =
      unique(
        extractText(
          entity
        )
      );

    for (
      const text
      of texts
    ) {

      const entityType =
        entity?.type ??
        entity?.objectType ??
        null;

      allText.push({
        block:
          blockName,

        entityType,

        text
      });

      const upper =
        text
          .toUpperCase()
          .replace(
            /\s+/g,
            " "
          )
          .trim();

      /*
       * ===============================================
       * Feeder names
       * ===============================================
       */

      if (
        /^F(?:EEDER)?\s*[-_ ]?\s*\d+(?:\s*[.-]\s*\d+)?(?:\s*[A-Z])?$/i.test(
          upper
        )
      ) {

        feederCandidates.push({

          text,

          normalized:
            upper,

          block:
            blockName,

          entityType

        });

      }

      /*
       * ===============================================
       * Station names
       * ===============================================
       */

      if (
        /^(SUB|SS|STATION|محطة)\s*[-_ ]?\S+/i.test(
          upper
        )
      ) {

        stationCandidates.push({

          text,

          normalized:
            upper,

          block:
            blockName,

          entityType

        });

      }
    }
  }
}

/*
 * =====================================================
 * إزالة التكرارات
 * =====================================================
 */

const uniqueFeeders = [];

const feederSeen =
  new Set();

for (
  const feeder
  of feederCandidates
) {

  const key =
    [
      feeder.normalized,
      feeder.block
    ].join(
      "|"
    );

  if (
    feederSeen.has(
      key
    )
  ) {
    continue;
  }

  feederSeen.add(
    key
  );

  uniqueFeeders.push(
    feeder
  );
}

/*
 * =====================================================
 * Manifest
 * =====================================================
 */

const manifest = {

  ok: true,

  sourceFile:
    "FINAL DISPATCH - UPDATE.dwg",

  reader:
    "@mlightcad/libredwg-web",

  dwgVersion,

  codepage,

  counts: {

    blockRecords:
      blockRecords.length,

    layers:
      layers.length,

    textEntities:
      allText.length,

    feederCandidates:
      feederCandidates.length,

    uniqueFeeders:
      uniqueFeeders.length,

    stationCandidates:
      stationCandidates.length

  },

  rules: {

    literalNamesOnly:
      true,

    noSyntheticStationNames:
      true,

    unresolvedRelationshipsAreNotGuessed:
      true,

    rawDatabaseFileDisabled:
      true

  }

};

/*
 * =====================================================
 * حفظ البيانات
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
  allText
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
 * =====================================================
 * حذف الملف الضخم القديم
 * =====================================================
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
 * منع نجاح وهمي
 * =====================================================
 */

if (
  blockRecords.length === 0 &&
  allText.length === 0
) {

  throw new Error(
    "DWG was opened but the converted database contains no entities or text."
  );

}

/*
 * =====================================================
 * النتيجة
 * =====================================================
 */

console.log("");

console.log(
  "========================================"
);

console.log(
  "FEEDER DATABASE BUILD COMPLETED"
);

console.log(
  "========================================"
);

console.log(
  `Blocks: ${blockRecords.length}`
);

console.log(
  `Layers: ${layers.length}`
);

console.log(
  `Text entities: ${allText.length}`
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

console.log(
  "========================================"
);

console.log(
  JSON.stringify(
    manifest,
    null,
    2
  )
);

/*
 * =====================================================
 * تحرير الذاكرة
 * =====================================================
 */

try {

  libredwg.dwg_free(
    dwg
  );

} catch {}
