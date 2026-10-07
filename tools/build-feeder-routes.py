import json
import re
from pathlib import Path

import ezdxf
from shapely.geometry import LineString, Point
from shapely.ops import unary_union

DXF = Path("/tmp/final-dispatch.dxf")
FEEDERS = Path("data/feeders/feeders.json")
OUT = Path("data/feeders/feeder-routes.geojson")

doc = ezdxf.readfile(DXF)
msp = doc.modelspace()
feeders = json.loads(FEEDERS.read_text(encoding="utf-8"))

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

# These are the CAD layers that can carry electrical route geometry.
# Text/labels are never rendered as feeder geometry.
allowed = re.compile(r"(d_ug cable|d_ug main line|o h main feeder|fdr|fedr)", re.I)
segments = []

for entity in msp:
    layer = str(getattr(entity.dxf, "layer", ""))
    if not allowed.search(layer):
        continue
    for pair in entity_lines(entity):
        try:
            segments.append((LineString(pair), layer))
        except Exception:
            pass

features = []

for feeder in feeders:
    labels = []
    for p in feeder.get("positions") or []:
        try:
            labels.append(Point(float(p["x"]), float(p["y"])))
        except Exception:
            pass
    if not labels:
        continue

    # Seed from actual feeder-label locations, then follow connected CAD route
    # segments. This is deliberately a route layer, not a point-at-label layer.
    selected = []
    for geom, layer in segments:
        if min(geom.distance(p) for p in labels) <= 180:
            selected.append(geom)

    if not selected:
        continue

    for _ in range(4):
        union = unary_union(selected)
        additions = []
        selected_ids = {id(x) for x in selected}
        for geom, layer in segments:
            if id(geom) in selected_ids:
                continue
            if geom.distance(union) <= 80:
                additions.append(geom)
        if not additions:
            break
        selected.extend(additions)

    merged = unary_union(selected).simplify(0.25, preserve_topology=True)
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
            "confidence": feeder.get("stationConfidence") or ""
        }
    })

OUT.write_text(
    json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False, separators=(",", ":")),
    encoding="utf-8"
)
print(f"Generated {len(features)} feeder routes -> {OUT} ({OUT.stat().st_size} bytes)")
