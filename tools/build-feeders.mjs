import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

/*
 * تحميل نسخة WASM مباشرة من داخل الحزمة.
 * نستخدم pathToFileURL لتجاوز مشكلة
 * ERR_PACKAGE_PATH_NOT_EXPORTED.
 */
const wasmPath = path.join(
  ROOT,
  "node_modules",
  "@mlightcad",
  "libredwg-web",
  "wasm",
  "libredwg-web.js"
);

console.log("Loading LibreDWG WASM:");
console.log(wasmPath);

const wasmModule = await import(
  pathToFileURL(wasmPath).href
);

const { createModule } = wasmModule;

if (typeof createModule !== "function") {
  throw new Error(
    "createModule was not found in libredwg-web WASM module."
  );
}

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

  if (
    typeof value === "string"
  ) {

    const text =
      value
        .trim();

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

  if (
    typeof value === "object"
  ) {

    for (
      const [key, val]
      of Object.entries(value)
    ) {

      if (
        /text|value|name|contents|string/i
          .test(key)
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

/*
 * -------------------------------------------------------
 * 1. قراءة ملف DWG
 * -------------------------------------------------------
 */

console.log("");
console.log(
  "======================================"
);
console.log(
  "FEEDER DATABASE BUILDER"
);
console.log(
  "======================================"
);
console.log("");

console.log(
  "DWG file:"
);

console.log(
  DWG_PATH
);

const fileBuffer =
  await fs.readFile(
    DWG_PATH
  );

const bytes =
  new Uint8Array(
    fileBuffer
  );

console.log(
  `DWG size: ${bytes.length} bytes`
);

/*
 * إنشاء LibreDWG
 */

const lib =
  await createModule();

console.log(
  "LibreDWG WASM loaded."
);

/*
 * -------------------------------------------------------
 * 2. قراءة DWG باستخدام FS + dwg_read_file
 * -------------------------------------------------------
 */

const tempFile =
  "input.dwg";

console.log(
  "Writing DWG into WASM filesystem..."
);

lib.FS.writeFile(
  tempFile,
  bytes
);

let readResult;

try {

  console.log(
    "Reading DWG..."
  );

  readResult =
    lib.dwg_read_file(
      tempFile
    );

} finally {

  try {
    lib.FS.unlink(
      tempFile
    );
  } catch {}

}

/*
 * فحص نتيجة القراءة
 */

if (
  !readResult ||
  readResult.error
) {

  const errorCode =
    readResult?.error ??
    "unknown";

  const manifest = {

    ok: false,

    sourceFile:
      "FINAL DISPATCH - UPDATE.dwg",

    reader:
      "LibreDWG raw WASM",

    errorCode,

    message:
      "LibreDWG could not decode the DWG file.",

    fileSize:
      bytes.length

  };

  await writeJson(
    "manifest.json",
    manifest
  );

  throw new Error(
    `DWG read failed with error code ${errorCode}`
  );
}

console.log(
  "DWG read successful."
);

const dwgPtr =
  readResult.data;

/*
 * -------------------------------------------------------
 * 3. تحويل DWG إلى Database
 * -------------------------------------------------------
 */

let db = null;

try {

  console.log(
    "Converting DWG database..."
  );

  /*
   * يجب أن تكون convert موجودة داخل
   * نفس WASM module الذي قرأ DWG.
   *
   * لا نستخدم module ثاني حتى لا يحدث
   * تعارض بين pointers الخاصة بالـ WASM.
   */

  if (
    typeof lib.convert !==
    "function"
  ) {

    throw new Error(
      "LibreDWG WASM does not expose convert()."
    );

  }

  db =
    lib.convert(
      dwgPtr
    );

  if (!db) {

    throw new Error(
      "LibreDWG returned an empty database."
    );

  }

  console.log(
    "DWG database conversion successful."
  );

  /*
   * -----------------------------------------------------
   * 4. استخراج الجداول
   * -----------------------------------------------------
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
    "Database information:"
  );

  console.log(
    `Block records: ${blockRecords.length}`
  );

  console.log(
    `Layers: ${layers.length}`
  );

  /*
   * -----------------------------------------------------
   * 5. استخراج النصوص
   * -----------------------------------------------------
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

        /*
         * حفظ جميع النصوص
         */

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
         * ---------------------------------------------
         * Feeder detection
         * ---------------------------------------------
         *
         * أمثلة:
         *
         * F-8.13
         * F 8.13
         * F-333 B
         * F 333 B
         * FEEDER 8.13
         *
         */

        const isFeeder =
          /^F(?:EEDER)?\s*[-_ ]?\s*\d+(?:\s*[.-]\s*\d+)?(?:\s*[A-Z])?$/i
            .test(
              upper
            );

        if (
          isFeeder
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
         * ---------------------------------------------
         * Station detection
         * ---------------------------------------------
         *
         * لا نخترع أي محطة.
         */

        const isStation =
          /^(SUB|SS|STATION|محطة)\s*[-_ ]?\S+/i
            .test(
              upper
            );

        if (
          isStation
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
   * -----------------------------------------------------
   * 6. إزالة التكرارات
   * -----------------------------------------------------
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
   * -----------------------------------------------------
   * 7. إنشاء Manifest
   * -----------------------------------------------------
   */

  const manifest = {

    ok: true,

    sourceFile:
      "FINAL DISPATCH - UPDATE.dwg",

    reader:
      "LibreDWG raw WASM",

    databaseConverter:
      "LibreDWG convert()",

    fileSize:
      bytes.length,

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
   * -----------------------------------------------------
   * 8. حفظ الملفات
   * -----------------------------------------------------
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
   * -----------------------------------------------------
   * 9. حذف قاعدة البيانات الضخمة القديمة
   * -----------------------------------------------------
   *
   * raw_database.json كان حجمه أكثر من 150MB
   * وGitHub يسمح بحد أقصى 100MB للملف.
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
   * -----------------------------------------------------
   * 10. التحقق من النتيجة
   * -----------------------------------------------------
   */

  if (
    blockRecords.length === 0 &&
    allText.length === 0
  ) {

    throw new Error(
      "DWG was read successfully, but no entities or text were found in the converted database."
    );

  }

  console.log("");
  console.log(
    "======================================"
  );

  console.log(
    "BUILD COMPLETED"
  );

  console.log(
    "======================================"
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
    "======================================"
  );

  console.log(
    JSON.stringify(
      manifest,
      null,
      2
    )
  );

} finally {

  /*
   * تحرير DWG pointer
   */

  try {

    if (
      typeof lib.dwg_free ===
      "function"
    ) {

      lib.dwg_free(
        dwgPtr
      );

    }

  } catch (
    error
  ) {

    console.log(
      "DWG cleanup warning:",
      error.message
    );

  }

}
