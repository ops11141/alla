#!/usr/bin/env python3
from pathlib import Path
import json
import re

ROOT = Path("data")
OUT = ROOT / "equipment-index.json"

def norm(v):
    s = str(v or "").strip().upper()
    return re.sub(r"[\s\-_/.,:;()[\]{}]+", "", s)

records = {}
files = sorted(ROOT.glob("part-*.json"), key=lambda p: int(re.search(r"(\d+)", p.stem).group(1)))
for path in files:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        continue
    for row in data:
        if not isinstance(row, dict):
            continue
        tf = str(row.get("TF", "")).strip()
        lat = row.get("Y")
        lon = row.get("X")
        try:
            lat = float(lat)
            lon = float(lon)
        except (TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lon <= 180):
            continue
        key = norm(tf)
        if not key:
            continue
        records.setdefault(key, []).append([tf, lat, lon, str(row.get("COORDIATE", "")).strip()])

# Deduplicate exact equipment/location records.
out = {}
for key, rows in records.items():
    seen = set()
    clean = []
    for row in rows:
        sig = (row[0].upper(), row[1], row[2])
        if sig in seen:
            continue
        seen.add(sig)
        clean.append(row)
    out[key] = clean

payload = {
    "version": 1,
    "source": "data/part-*.json",
    "equipmentCount": sum(len(v) for v in out.values()),
    "keys": len(out),
    "records": out,
}

OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print(f"Created {OUT}: {OUT.stat().st_size} bytes, {sum(len(v) for v in out.values())} records, {len(out)} keys")
