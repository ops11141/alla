import fs from "node:fs/promises";
import path from "node:path";
import { createModule } from "@mlightcad/libredwg-web/wasm/libredwg-web.js";

const ROOT = process.cwd();
const DWG_PATH = path.join(ROOT, "cad", "FINAL DISPATCH - UPDATE.dwg");
const OUT_DIR = path.join(ROOT, "data", "feeders");

await fs.mkdir(OUT_DIR, { recursive: true });

function jsonSafe(value) {
  return JSON.stringify(
    value,
    (key, v) => {
      if (typeof v === "bigint") return Number(v);
      if (v instanceof Uint8Array) return Array.from(v);
      return v;
    },
    2
  );
}

function writeJson(name, value) {
  return fs.writeFile(
    path.join(OUT_DIR, name),
    jsonSafe(value),
    "utf8"
  );
}

function extractText(value, out = []) {
  if (value == null) return out;

  if (typeof value === "string") {
    const s = value.trim();
    if (s) out.push(s);
    return out;
  }

  if (Array.isArray(value)) {
    for (const x of value) {
      extractText(x, out);
    }
    return out;
  }

  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (/text|value|name|contents|string/i.test(k)) {
        extractText(v, out);
      }
    }
  }

  return out;
}

function unique(arr) {
  return [...new Set(arr)];
}

const fileContent = await fs.readFile(DWG_PATH);
const bytes = new Uint8Array(fileContent);

console.log("Reading DWG:", DWG_PATH);
console.log("File size:", bytes.length);

const lib = await createModule();

const tempName = "input.dwg";

lib.FS.writeFile(tempName, bytes);

let result;

try {
  result = lib.dwg_read_file(tempName);
} finally {
  try {
    lib.FS.unlink(tempName);
  } catch {}
}

if (!result || result.error) {
  const code = result?.error ?? "unknown";

  const manifest = {
    ok: false,
    sourceFile: "FINAL DISPATCH - UPDATE.dwg",
    reader: "libredwg raw WASM",
    errorCode: code,
    message:
      "DWG reader could not decode the file. No fabricated feeder data was generated."
  };

  await writeJson("manifest.json", manifest);

  throw new Error(
    `DWG read failed with error code ${code}`
  );
}

console.log("DWG read successful.");

const dwgPtr = result.data;

let db = null;

try {
  const wrapperModule =
    await import("@mlightcad/libredwg-web");

  const { LibreDwg } = wrapperModule;

  const wrapper = await LibreDwg.create(
    path.join(
      ROOT,
      "node_modules",
      "@mlightcad",
      "libredwg-web",
      "wasm"
    )
  );

  console.log("Converting DWG database...");

  db = wrapper.convert(dwgPtr);

  const tables = db?.tables ?? {};

  const blockRecords =
    Array.isArray(tables.blockRecords)
      ? tables.blockRecords
      : [];

  const layers =
    Array.isArray(tables.layers)
      ? tables.layers
      : [];

  const allText = [];
  const feederCandidates = [];
  const stationCandidates = [];

  for (const block of blockRecords) {

    const blockName =
      block?.name ??
      block?.id ??
      "";

    const entities =
      Array.isArray(block?.entities)
        ? block.entities
        : [];

    for (const entity of entities) {

      const texts =
        unique(extractText(entity));

      for (const text of texts) {

        allText.push({
          block: blockName,
          entityType:
            entity?.type ??
            entity?.objectType ??
            null,
          text
        });

        const upper =
          text
            .toUpperCase()
            .replace(/\s+/g, " ")
            .trim();

        /*
         * Feeder names are detected literally.
         *
         * Examples:
         * F-8.13
         * F 8.13
         * F-333 B
         * FEEDER 8.13
         */

        if (
          /^F(?:EEDER)?\s*[-_ ]?\s*\d+(?:\s*[.-]\s*\d+)?(?:\s*[A-Z])?$/i.test(
            upper
          )
        ) {

          feederCandidates.push({
            text,
            block: blockName,
            entityType:
              entity?.type ??
              entity?.objectType ??
              null
          });

        }

        /*
         * Station names.
         * No station names are invented.
         */

        if (
          /^(SUB|SS|STATION|محطة)\s*[-_ ]?\S+/i.test(
            upper
          )
        ) {

          stationCandidates.push({
            text,
            block: blockName,
            entityType:
              entity?.type ??
              entity?.objectType ??
              null
          });

        }
      }
    }
  }

  const manifest = {

    ok: true,

    sourceFile:
      "FINAL DISPATCH - UPDATE.dwg",

    reader:
      "libredwg raw WASM + database converter",

    counts: {

      blockRecords:
        blockRecords.length,

      layers:
        layers.length,

      textEntities:
        allText.length,

      feederCandidates:
        feederCandidates.length,

      stationCandidates:
        stationCandidates.length

    },

    rules: {

      literalNamesOnly: true,

      noSyntheticStationNames: true,

      unresolvedRelationshipsAreNotGuessed: true,

      rawDatabaseFileDisabled: true

    }

  };

  /*
   * Save only useful files.
   *
   * raw_database.json is intentionally NOT generated
   * because it exceeded GitHub's 100 MB limit.
   */

  await Promise.all([

    writeJson(
      "manifest.json",
      manifest
    ),

    writeJson(
      "layers.json",
      layers
    ),

    writeJson(
      "all_text_entities.json",
      allText
    ),

    writeJson(
      "all_feeder_candidates.json",
      feederCandidates
    ),

    writeJson(
      "stations.json",
      stationCandidates
    ),

    writeJson(
      "feeders.json",
      feederCandidates
    )

  ]);

  /*
   * Delete old oversized database if it exists.
   */

  await fs.rm(
    path.join(
      OUT_DIR,
      "raw_database.json"
    ),
    { force: true }
  );

  /*
   * Do not accept an empty DWG database as success.
   */

  if (
    !blockRecords.length &&
    !allText.length
  ) {

    throw new Error(
      "DWG was opened but the converted database contains no block/entity/text records."
    );

  }

  console.log(
    JSON.stringify(
      manifest,
      null,
      2
    )
  );

} finally {

  /*
   * Free the DWG pointer only if conversion
   * did not take ownership.
   */

  try {

    if (
      db == null &&
      typeof lib.dwg_free === "function"
    ) {

      lib.dwg_free(dwgPtr);

    }

  } catch {}

}
