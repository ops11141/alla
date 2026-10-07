import json
import math
import re
from pathlib import Path

import ezdxf
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

DXF = Path("/tmp/final-dispatch.dxf")
FEEDERS = Path("data/feeders/feeders.json")
STATIONS = Path("data/feeders/stations.json")
OUT_DIR = Path("data/feeders/routes")
MANIFEST = Path("data/feeders/feeder-routes-manifest.json")

# اختبار أولي: نبني مسار مغذٍ واحد فقط من هندسة CAD الأصلية.
TEST_FEEDER = "F-8.13"

doc = ezdxf.readfile(DXF)
msp = doc.modelspace()
feeders = json.loads(FEEDERS.read_text(encoding="utf-8"))
stations = json.loads(STATIONS.read_text(encoding="utf-8"))

def entity_lines(entity):
    try:
        t = entity.dxftype()
        if t == "LINE":
            a, b = entity.dxf.start, entity.dxf.end
            return [[(float(a.x), float(a.y)), (float(b.x), float(b.y))]]
        if t == "LWPOLYLINE":
            pts = [(float(p[0]), float(p[1])) for p in entity.get_points("xy")]
            return [list(pair) for pair in zip(pts, pts[1:]) if pair[0] != pair[1]]
        if t == "POLYLINE":
            pts = [(float(v.dxf.location.x), float(v.dxf.location.y)) for v in entity.vertices]
            return [list(pair) for pair in zip(pts, pts[1:]) if pair[0] != pair[1]]
    except Exception:
        pass
    return []

# نستخدم خطوط المسار الحقيقية فقط. fedr no طبقة نصوص/تسميات وليست مسارًا.
def is_route_layer(layer):
    s = layer.lower().strip()
    return (
        "d_ug cable" in s
        or "d_ug main line" in s
        or "o h main feeder" in s
        or re.search(r"^fdr\b", s, re.I) is not None
        or re.search(r"^d fdr\b", s, re.I) is not None
    )

segments = []
for entity in msp:
    layer = str(getattr(entity.dxf, "layer", ""))
    if not is_route_layer(layer):
        continue
    for pair in entity_lines(entity):
        try:
            geom = LineString(pair)
            if geom.length > 0.5:
                segments.append((geom, layer))
        except Exception:
            pass

def norm(s):
    return re.sub(r"[^a-z0-9]", "", str(s or "").lower())

station_points = []
for s in stations:
    try:
        station_points.append((str(s.get("name", "")), Point(float(s["x"]), float(s["y"]))))
    except Exception:
        pass

def station_anchor(feeder):
    target = norm(feeder.get("station"))
    candidates = [(n, p) for n, p in station_points if norm(n) == target]
    if not candidates:
        return None
    labels = []
    for p in feeder.get("positions") or []:
        try:
            labels.append(Point(float(p["x"]), float(p["y"])))
        except Exception:
            pass
    if not labels:
        return candidates[0][1]
    # اختر نسخة المحطة الأقرب إلى إحدى تسميات المغذي في الرسم.
    return min(candidates, key=lambda item: min(item[1].distance(lp) for lp in labels))[1]

def choose_label(feeder, anchor):
    labels = []
    for p in feeder.get("positions") or []:
        try:
            labels.append(Point(float(p["x"]), float(p["y"])))
        except Exception:
            pass
    if not labels:
        return None
    # نختار تسمية المغذي الأقرب للمحطة، لا كل النسخ المتكررة للاسم في الرسم.
    return min(labels, key=lambda p: p.distance(anchor))

def connected_component(seed_ids, tolerance=6.0):
    selected = set(seed_ids)
    changed = True
    while changed:
        changed = False
        current = [segments[i][0] for i in selected]
        union = unary_union(current)
        for i, (geom, _) in enumerate(segments):
            if i in selected:
                continue
            # الاتصال الهندسي الحقيقي أو فجوة صغيرة جدًا في CAD.
            if geom.distance(union) <= tolerance:
                selected.add(i)
                changed = True
    return selected

features = []
for feeder in feeders:
    if str(feeder.get("name", "")).strip().upper() != TEST_FEEDER.upper():
        continue

    anchor = station_anchor(feeder)
    label = choose_label(feeder, anchor) if anchor else None
    if label is None:
        continue

    # البداية تكون قرب تسمية F-8.13، ثم نربطها فقط بخطوط CAD الأصلية.
    seed = [
        i for i, (geom, _) in enumerate(segments)
        if geom.distance(label) <= 30
    ]
    if not seed:
        continue

    component = connected_component(seed, tolerance=6.0)
    selected = [segments[i][0] for i in sorted(component)]

    # لا نضيف أي خطوط تخمينية: كل جزء هنا موجود أصلًا في DWG.
    merged = unary_union(selected)
    geoms = list(merged.geoms) if hasattr(merged, "geoms") else [merged]
    coords = []
    for geom in geoms:
        if geom.geom_type == "LineString" and len(geom.coords) >= 2:
            coords.append([[round(x, 3), round(y, 3)] for x, y in geom.coords])

    if not coords:
        continue

    features.append({
        "type": "Feature",
        "geometry": {"type": "MultiLineString", "coordinates": coords},
        "properties": {
            "name": feeder.get("name", ""),
            "station": feeder.get("station") or "",
            "mode": "original-cad-geometry",
            "source": "FINAL DISPATCH - UPDATE.dwg"
        }
    })

OUT_DIR.mkdir(parents=True, exist_ok=True)
for path in OUT_DIR.glob("part-*.json"):
    path.unlink()

chunk_name = "part-01.json"
(OUT_DIR / chunk_name).write_text(
    json.dumps({"type": "FeatureCollection", "features": features},
               ensure_ascii=False, separators=(",", ":")),
    encoding="utf-8"
)

MANIFEST.write_text(
    json.dumps({
        "type": "feeder-route-manifest",
        "test": TEST_FEEDER,
        "totalFeatures": len(features),
        "chunkSize": 1,
        "chunks": [{"file": f"routes/{chunk_name}",
                    "features": len(features),
                    "bytes": (OUT_DIR / chunk_name).stat().st_size}]
    }, ensure_ascii=False, separators=(",", ":")),
    encoding="utf-8"
)

print(f"Generated {len(features)} exact CAD route feature(s) for {TEST_FEEDER}.")
