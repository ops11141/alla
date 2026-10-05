from pathlib import Path
import json
import math
import re

import ezdxf
from ezdxf import bbox
from ezdxf.addons.drawing import matplotlib

DXF = Path("/tmp/final-dispatch.dxf")
FEEDERS = Path("data/feeders/feeders.json")
OUT = Path("data/feeders/test-drawings-v2")
OUT.mkdir(parents=True, exist_ok=True)

TEST_FEEDERS = ["F-8.13"]

doc = ezdxf.readfile(DXF)
msp = doc.modelspace()
feeders = {x["name"]: x for x in json.loads(FEEDERS.read_text(encoding="utf-8"))}

cache = bbox.Cache()

# Index all drawable entities once.
indexed = []
for entity in msp:
    try:
        box = bbox.extents([entity], cache=cache)
        if box.has_data:
            indexed.append((entity, box))
    except Exception:
        pass

def is_rectangular_closed_polyline(e):
    """Return bbox for closed LWPOLYLINE/POLYLINE that looks like a rectangle."""
    try:
        t = e.dxftype()
        if t == "LWPOLYLINE":
            if not e.closed:
                return None
            pts = [(p[0], p[1]) for p in e.get_points("xy")]
        elif t == "POLYLINE":
            if not e.is_closed:
                return None
            pts = [(v.dxf.location.x, v.dxf.location.y) for v in e.vertices]
        else:
            return None

        if len(pts) < 4:
            return None

        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        minx, maxx, miny, maxy = min(xs), max(xs), min(ys), max(ys)

        w, h = maxx-minx, maxy-miny
        if w <= 0 or h <= 0:
            return None

        # Rectangle-like: vertices should lie close to the four bbox edges.
        tol = max(w, h) * 0.01
        ok = all(
            min(abs(x-minx), abs(x-maxx)) <= tol or
            min(abs(y-miny), abs(y-maxy)) <= tol
            for x, y in pts
        )
        if not ok:
            return None

        return (minx, miny, maxx, maxy)
    except Exception:
        return None

# Detect rectangular drawing frames.
frames = []
for entity, box in indexed:
    r = is_rectangular_closed_polyline(entity)
    if r:
        minx, miny, maxx, maxy = r
        area = (maxx-minx) * (maxy-miny)
        if area > 1e5:
            frames.append((minx, miny, maxx, maxy, area))

# Also detect rectangles made from 4 LINE entities sharing corners.
# Build horizontal/vertical segments and assemble exact-ish boxes.
lines = []
for entity, box in indexed:
    if entity.dxftype() != "LINE":
        continue
    try:
        a, b = entity.dxf.start, entity.dxf.end
        x1,y1,x2,y2 = float(a.x),float(a.y),float(b.x),float(b.y)
        if abs(x1-x2) < 1e-6 or abs(y1-y2) < 1e-6:
            lines.append((x1,y1,x2,y2))
    except Exception:
        pass

# Conservative frame detection from axis-aligned line pairs.
tol = 2.0
for i, (x1,y1,x2,y2) in enumerate(lines):
    # horizontal only
    if abs(y1-y2) >= 1e-6:
        continue
    hx1,hx2 = sorted((x1,x2))
    for x3,y3,x4,y4 in lines:
        if abs(x3-x4) >= 1e-6:
            continue
        vx = x3
        vy1,vy2 = sorted((y3,y4))
        if abs(vx-hx1) > tol and abs(vx-hx2) > tol:
            continue
        if abs(vx-hx1) <= tol:
            left = vx
            right = hx2
        else:
            left = hx1
            right = vx
        if right-left <= 100:
            continue
        # Need a second horizontal at another y and the matching verticals.
        for x5,y5,x6,y6 in lines:
            if abs(y5-y6) >= 1e-6 or abs(y5-y1) <= tol:
                continue
            yb = y5
            lo,hi = sorted((y1,yb))
            if hi-lo <= 100:
                continue
            has_left = any(
                abs(a-c) <= tol and abs(b-c) <= tol
                for a,b,c,d in []
            )
            def has_v(x):
                for a,b,c,d in lines:
                    if abs(a-c) < 1e-6 and abs(a-x) <= tol:
                        yy1,yy2 = sorted((b,d))
                        if yy1 <= lo+tol and yy2 >= hi-tol:
                            return True
                return False
            if has_v(left) and has_v(right):
                frames.append((left,lo,right,hi,(right-left)*(hi-lo)))

# Deduplicate frames.
uniq=[]
seen=set()
for r in sorted(frames, key=lambda z:z[4]):
    key=tuple(round(v,1) for v in r[:4])
    if key not in seen:
        seen.add(key); uniq.append(r)
frames=uniq

print(f"Indexed entities: {len(indexed)}")
print(f"Detected drawing frames: {len(frames)}")

def inside_or_intersects(box, lo_x, lo_y, hi_x, hi_y):
    return not (
        box.extmax.x < lo_x or box.extmin.x > hi_x or
        box.extmax.y < lo_y or box.extmin.y > hi_y
    )

def safe(s):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", s)

for name in TEST_FEEDERS:
    data=feeders.get(name)
    if not data:
        print(f"NOT FOUND: {name}")
        continue

    positions=data.get("positions", [])
    matched=[]

    # Find the smallest drawing frame containing each feeder label.
    for p in positions:
        x=float(p["x"]); y=float(p["y"])
        candidates=[
            f for f in frames
            if f[0] <= x <= f[2] and f[1] <= y <= f[3]
        ]
        if candidates:
            # Prefer a reasonably sized frame, but not a tiny symbol box.
            f=min(candidates, key=lambda z:z[4])
            if f not in matched:
                matched.append(f)

    # If no frame was found, fall back to one combined bounding box of ALL positions.
    if not matched and positions:
        xs=[float(p["x"]) for p in positions]
        ys=[float(p["y"]) for p in positions]
        w=max(xs)-min(xs); h=max(ys)-min(ys)
        pad=max(1500.0, max(w,h)*0.25)
        matched=[(min(xs)-pad,min(ys)-pad,max(xs)+pad,max(ys)+pad,0)]

    print(f"{name}: {len(positions)} labels -> {len(matched)} drawing frame(s)")

    for idx, f in enumerate(matched,1):
        minx,miny,maxx,maxy,_=f
        # Small margin outside the frame for readability.
        w=maxx-minx; h=maxy-miny
        pad=max(150.0,min(1200.0,max(w,h)*0.025))
        lo_x,lo_y=maxx*0+minx-pad,miny-pad
        hi_x,hi_y=maxx+pad,maxy+pad

        def visible(entity, lo_x=lo_x, lo_y=lo_y, hi_x=hi_x, hi_y=hi_y):
            try:
                b=bbox.extents([entity],cache=cache)
                return b.has_data and inside_or_intersects(b,lo_x,lo_y,hi_x,hi_y)
            except Exception:
                return False

        aspect=max(w,1)/max(h,1)
        if aspect >= 1:
            size=(14, max(7,14/aspect))
        else:
            size=(max(7,10*aspect),10)

        out=OUT/f"{safe(name)}__full__{idx:02d}.svg"
        print("  ",out)
        matplotlib.qsave(
            msp,
            str(out),
            dpi=180,
            bg="#FFFFFF",
            fg="#111111",
            filter_func=visible,
            size_inches=size,
        )

print("DONE")
