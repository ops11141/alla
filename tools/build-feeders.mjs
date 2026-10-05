import fs from 'node:fs/promises';
import path from 'node:path';
import { Dwg_File_Type, LibreDwg } from '@mlightcad/libredwg-web';

const ROOT = process.cwd();
const DWG_PATH = path.join(ROOT, 'cad', 'FINAL DISPATCH - UPDATE.dwg');
const OUT = path.join(ROOT, 'data', 'feeders');
await fs.mkdir(OUT, { recursive: true });

const cleanText = (value) => String(value ?? '')
  .replace(/\\P/g, ' ')
  .replace(/\\A[^;]+;/g, '')
  .replace(/\\[A-Za-z][^;]*;/g, ' ')
  .replace(/[{}]/g, '')
  .replace(/\\~/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function jsonReplacer() {
  const seen = new WeakSet();
  return (key, value) => {
    if (typeof value === 'bigint') return value.toString();
    if (value instanceof Uint8Array) return Array.from(value);
    if (value && typeof value === 'object') {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  };
}
function writeJson(file, value) {
  return fs.writeFile(path.join(OUT, file), JSON.stringify(value, jsonReplacer(), 2));
}
function pointFrom(entity) {
  const p = entity?.startPoint ?? entity?.insertionPoint ?? entity?.position ?? entity?.insertPoint ?? entity?.alignmentPoint ?? entity?.text?.startPoint;
  if (!p) return null;
  const x = Number(p.x), y = Number(p.y);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}
function entityText(entity) {
  if (!entity || typeof entity !== 'object') return '';
  if (typeof entity.text === 'string') return cleanText(entity.text);
  if (entity.text && typeof entity.text.text === 'string') return cleanText(entity.text.text);
  if (typeof entity.contents === 'string') return cleanText(entity.contents);
  if (typeof entity.content === 'string') return cleanText(entity.content);
  if (typeof entity.value === 'string') return cleanText(entity.value);
  return '';
}
function isTextEntity(type) {
  return /^(TEXT|MTEXT|ATTRIB|ATTDEF|MULTILEADER|LEADER|DIMENSION)$/i.test(type);
}
function feederCandidate(text) {
  // This is ONLY a candidate detector. The original text is preserved exactly in rawText/displayName.
  return /(^|[^A-Z0-9])F\s*[._-]\s*\d+(?:\s*[._-]\s*\d+)*(?=$|[^A-Z0-9])/i.test(text);
}
function normalizeForSearch(text) {
  return cleanText(text).replace(/\s+/g, ' ').toLowerCase();
}
function isLikelyStation(text, entity) {
  const t = cleanText(text);
  if (!t) return false;
  // Never invent station names. Only explicit station-like text is a candidate.
  if (/\bSUB\b/i.test(t) || /\bSTATION\b/i.test(t) || /محطة/i.test(t)) return true;
  // Some drawings use a station/container name without the word SUB. Large heading text is kept as a candidate,
  // but it is not promoted to a station unless spatial grouping supports it.
  const h = Number(entity?.textHeight ?? entity?.text?.textHeight ?? entity?.height);
  return Number.isFinite(h) && h > 5 && !feederCandidate(t) && t.length <= 80;
}

const file = await fs.readFile(DWG_PATH);
const arrayBuffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
const lib = await LibreDwg.create(path.join(ROOT, 'node_modules', '@mlightcad', 'libredwg-web', 'wasm'));
const ptr = lib.dwg_read_data(arrayBuffer, Dwg_File_Type.DWG);
if (!ptr) throw new Error('LibreDWG could not read the DWG file.');

const version = lib.dwg_get_version_type(ptr);
const codepage = lib.dwg_get_codepage(ptr);
const converted = typeof lib.convertEx === 'function' ? lib.convertEx(ptr) : { database: lib.convert(ptr), stats: {} };
const db = converted.database;
const stats = converted.stats || {};
if (!db) throw new Error('DWG was read, but database conversion returned no database.');

const blockRecords = Array.isArray(db?.tables?.blockRecords) ? db.tables.blockRecords : [];
const layers = Array.isArray(db?.tables?.layers) ? db.tables.layers : [];
const objects = Array.isArray(db?.objects) ? db.objects : [];
const allEntities = [];

for (const block of blockRecords) {
  const blockName = String(block?.name ?? '');
  for (let i = 0; i < (block?.entities?.length || 0); i++) {
    const entity = block.entities[i];
    allEntities.push({ entity, blockName, index: i });
  }
}

const entityTypes = new Map();
const textEntities = [];
const feederCandidates = [];
const stationCandidates = [];

for (const item of allEntities) {
  const e = item.entity || {};
  const type = String(e.type || 'UNKNOWN');
  entityTypes.set(type, (entityTypes.get(type) || 0) + 1);
  const text = entityText(e);
  const point = pointFrom(e);
  const layer = String(e.layer || '');
  const row = {
    type,
    block: item.blockName,
    index: item.index,
    layer,
    rawText: text,
    displayName: text,
    x: point?.x ?? null,
    y: point?.y ?? null,
    textHeight: Number(e.textHeight ?? e.text?.textHeight ?? NaN),
    handle: e.handle ?? null,
    isInPaperSpace: !!e.isInPaperSpace
  };
  if (isTextEntity(type) || text) textEntities.push(row);
  if (text && feederCandidate(text)) feederCandidates.push(row);
  if (text && isLikelyStation(text, e)) stationCandidates.push(row);
}

// Literal station labels: only text found in the drawing. No SUB1/SUB2/etc. are created.
const explicitStationNames = [...new Set(stationCandidates
  .filter(r => /\bSUB\b/i.test(r.rawText) || /\bSTATION\b/i.test(r.rawText) || /محطة/i.test(r.rawText))
  .map(r => r.rawText))];

// Keep all candidate headings separately. They are evidence, not asserted station names.
const headingCandidates = stationCandidates
  .filter(r => !feederCandidate(r.rawText))
  .map(r => ({ ...r, candidateReason: /\bSUB\b|\bSTATION\b|محطة/i.test(r.rawText) ? 'explicit-station-token' : 'heading-by-text-height' }));

// Conservative spatial association. A feeder is assigned only when a station label exists above it in the same local column.
// If no reliable label exists, stationName stays null. We never synthesize a station.
const stations = headingCandidates.filter(r => /\bSUB\b/i.test(r.rawText) || /\bSTATION\b/i.test(r.rawText) || /محطة/i.test(r.rawText));
const distance = (a,b) => {
  if (![a?.x,a?.y,b?.x,b?.y].every(Number.isFinite)) return Infinity;
  return Math.hypot(a.x-b.x, a.y-b.y);
};
const associatedFeeders = feederCandidates.map(f => {
  let best = null;
  let bestScore = Infinity;
  for (const s of stations) {
    if (!Number.isFinite(f.x) || !Number.isFinite(f.y) || !Number.isFinite(s.x) || !Number.isFinite(s.y)) continue;
    // CAD Y generally increases upward. Prefer headings above the feeder and nearby in X.
    if (s.y <= f.y) continue;
    const dx = Math.abs(s.x - f.x);
    const dy = s.y - f.y;
    if (dx > Math.max(500, dy * 2 + 200)) continue;
    const score = dy + dx * 0.35;
    if (score < bestScore) { bestScore = score; best = s; }
  }
  return {
    ...f,
    stationName: best?.rawText ?? null,
    stationMatch: best ? 'spatial-explicit-label' : 'unresolved',
    stationEvidence: best ? { rawText: best.rawText, x: best.x, y: best.y, layer: best.layer, block: best.block } : null
  };
});

// Group ONLY by literal stationName + literal feeder name. Same feeder name in different stations is preserved.
const grouped = new Map();
for (const f of associatedFeeders) {
  const key = `${f.stationName ?? '[غير محدد]'}\u0000${f.rawText}`;
  if (!grouped.has(key)) grouped.set(key, {
    stationName: f.stationName,
    feederName: f.rawText,
    match: f.stationMatch,
    occurrences: []
  });
  grouped.get(key).occurrences.push(f);
}
const feeders = [...grouped.values()];

let svg = '';
try { svg = lib.dwg_to_svg(db) || ''; } catch (err) { svg = `<!-- SVG conversion failed: ${cleanText(err?.message || err)} -->`; }

const manifest = {
  ok: true,
  sourceFile: 'FINAL DISPATCH - UPDATE.dwg',
  generatedAt: new Date().toISOString(),
  reader: '@mlightcad/libredwg-web 0.7.14',
  dwgVersion: version ?? null,
  codepage: codepage ?? null,
  conversionStats: stats,
  counts: {
    blockRecords: blockRecords.length,
    entities: allEntities.length,
    textEntities: textEntities.length,
    feederCandidates: feederCandidates.length,
    explicitStationLabels: explicitStationNames.length,
    stationHeadingCandidates: headingCandidates.length,
    groupedFeeders: feeders.length,
    layers: layers.length,
    objects: objects.length,
    entityTypes: entityTypes.size
  },
  rules: {
    literalNamesOnly: true,
    noSyntheticStationNames: true,
    duplicateFeederNamesKeptPerStation: true,
    unresolvedRelationshipsAreNotGuessed: true
  }
};

await writeJson('manifest.json', manifest);
await writeJson('stations.json', { explicitStationNames, stationLabels: stations, headingCandidates });
await writeJson('feeders.json', { feeders });
await writeJson('all_text_entities.json', textEntities);
await writeJson('all_feeder_candidates.json', feederCandidates);
await writeJson('layers.json', layers);
await writeJson('blocks.json', blockRecords.map(b => ({ name: b?.name ?? '', entityCount: Array.isArray(b?.entities) ? b.entities.length : 0 })));
await writeJson('entity_types.json', [...entityTypes.entries()].map(([type,count]) => ({type,count})).sort((a,b)=>b.count-a.count));
await writeJson('database_tables.json', { layers, blockRecords: blockRecords.map(b => ({ name: b?.name ?? '', entityCount: Array.isArray(b?.entities) ? b.entities.length : 0 })), ltypes: db?.tables?.ltypes ?? [], styles: db?.tables?.styles ?? [], dimStyles: db?.tables?.dimStyles ?? [], vports: db?.tables?.vports ?? [] });
await writeJson('raw_database.json', db);
await writeJson('full_analysis.json', { manifest, stations: { explicitStationNames, stationLabels: stations, headingCandidates }, feeders, textEntities, feederCandidates, layers, blocks: blockRecords.map(b => ({ name:b?.name ?? '', entityCount:b?.entities?.length ?? 0 })), entityTypes: [...entityTypes.entries()].map(([type,count]) => ({type,count})) });
await fs.writeFile(path.join(OUT, 'drawing.svg'), svg, 'utf8');

try { lib.dwg_free(ptr); } catch {}
console.log(JSON.stringify(manifest, null, 2));
