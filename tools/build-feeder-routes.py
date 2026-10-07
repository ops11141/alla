import json
import math
import re
import heapq
from pathlib import Path
import ezdxf
from shapely.geometry import LineString, Point

DXF = Path("/tmp/final-dispatch.dxf")
FEEDERS = Path("data/feeders/feeders.json")
STATIONS = Path("data/feeders/stations.json")
OUT_DIR = Path("data/feeders/routes")
MANIFEST = Path("data/feeders/feeder-routes-manifest.json")
TEST_FEEDER = "F-8.13"

doc = ezdxf.readfile(DXF)
msp = doc.modelspace()
feeders = json.loads(FEEDERS.read_text(encoding="utf-8"))
stations = json.loads(STATIONS.read_text(encoding="utf-8"))

def entity_lines(entity):
    try:
        t = entity.dxftype()
        if t == "LINE":
            a,b=entity.dxf.start,entity.dxf.end
            return [[(float(a.x),float(a.y)),(float(b.x),float(b.y))]]
        if t == "LWPOLYLINE":
            pts=[(float(p[0]),float(p[1])) for p in entity.get_points("xy")]
            return [[pts[i],pts[i+1]] for i in range(len(pts)-1) if pts[i]!=pts[i+1]]
        if t == "POLYLINE":
            pts=[(float(v.dxf.location.x),float(v.dxf.location.y)) for v in entity.vertices]
            return [[pts[i],pts[i+1]] for i in range(len(pts)-1) if pts[i]!=pts[i+1]]
    except Exception:
        pass
    return []

def is_route_layer(layer):
    s=layer.lower().strip()
    return (
        "d_ug cable" in s or
        "d_ug main line" in s or
        "o h main feeder" in s or
        re.match(r"^fdr\b",s,re.I) or
        re.match(r"^d fdr\b",s,re.I)
    )

segments=[]
for entity in msp:
    layer=str(getattr(entity.dxf,"layer",""))
    if not is_route_layer(layer):
        continue
    for pair in entity_lines(entity):
        try:
            g=LineString(pair)
            if g.length>0.5:
                segments.append(g)

def norm(s):
    return re.sub(r"[^a-z0-9]","",str(s or "").lower())

station_points=[]
for s in stations:
    try:
        station_points.append((str(s.get("name","")),Point(float(s["x"]),float(s["y"]))))
    except Exception:
        pass

feeder=next((f for f in feeders if str(f.get("name","")).strip().upper()==TEST_FEEDER.upper()),None)
if not feeder:
    raise SystemExit("F-8.13 not found")

target_station=norm(feeder.get("station"))
station_candidates=[(n,p) for n,p in station_points if norm(n)==target_station]
if not station_candidates:
    raise SystemExit("station not found")

labels=[]
for p in feeder.get("positions") or []:
    try: labels.append(Point(float(p["x"]),float(p["y"])))
    except Exception: pass
if not labels:
    raise SystemExit("feeder label positions not found")

# Use the station copy closest to the feeder's label.
anchor=min(station_candidates,key=lambda item:min(item[1].distance(lp) for lp in labels))[1]
label=min(labels,key=lambda p:p.distance(anchor))

# Build a graph from ORIGINAL CAD route segments only.
# Segment endpoints are snapped into nodes with a small CAD tolerance.
TOL=12.0
nodes=[]
node_xy=[]
def node_for(pt):
    best=-1; bd=TOL
    for i,q in enumerate(node_xy):
        d=math.hypot(pt[0]-q[0],pt[1]-q[1])
        if d<=bd:
            best=i; bd=d
    if best>=0:
        return best
    node_xy.append(pt)
    return len(node_xy)-1

edges=[]
for g in segments:
    a,b=list(g.coords)[0],list(g.coords)[-1]
    u=node_for(a); v=node_for(b)
    if u!=v:
        w=g.length
        edges.append((u,v,w,g))

adj=[[] for _ in node_xy]
for u,v,w,g in edges:
    adj[u].append((v,w,g))
    adj[v].append((u,w,g))

def nearest_node(point,maxdist):
    best=None; bd=maxdist
    for i,q in enumerate(node_xy):
        d=math.hypot(point.x-q[0],point.y-q[1])
        if d<=bd:
            best=i; bd=d
    return best,bd

start,start_d=nearest_node(anchor,80)
goal,goal_d=nearest_node(label,80)
features=[]

if start is not None and goal is not None:
    dist={start:0.0}
    prev={}
    pq=[(0.0,start)]
    while pq:
        d,u=heapq.heappop(pq)
        if d!=dist.get(u): continue
        if u==goal: break
        for v,w,g in adj[u]:
            nd=d+w
            if nd<dist.get(v,float("inf")):
                dist[v]=nd
                prev[v]=(u,g)
                heapq.heappush(pq,(nd,v))
    if goal in prev or goal==start:
        path=[]
        cur=goal
        while cur!=start:
            u,g=prev[cur]
            coords=[[round(x,3),round(y,3)] for x,y in g.coords]
            # Orient every segment in station -> feeder-label direction.
            a=node_xy[u]; b=node_xy[cur]
            if math.hypot(coords[0][0]-a[0],coords[0][1]-a[1]) > math.hypot(coords[-1][0]-a[0],coords[-1][1]-a[1]):
                coords.reverse()
            path.append(coords)
            cur=u
        path.reverse()
        features=[{"type":"Feature","geometry":{"type":"MultiLineString","coordinates":path},
                   "properties":{"name":TEST_FEEDER,"station":feeder.get("station",""),
                                 "mode":"original-cad-shortest-path",
                                 "source":"FINAL DISPATCH - UPDATE.dwg"}}]

OUT_DIR.mkdir(parents=True,exist_ok=True)
for p in OUT_DIR.glob("part-*.json"): p.unlink()
part=OUT_DIR/"part-01.json"
part.write_text(json.dumps({"type":"FeatureCollection","features":features},ensure_ascii=False,separators=(",",":")),encoding="utf-8")
MANIFEST.write_text(json.dumps({
    "type":"feeder-route-manifest","test":TEST_FEEDER,"totalFeatures":len(features),
    "diagnostics":{"routeSegments":len(segments),"graphNodes":len(node_xy),"graphEdges":len(edges),
                   "stationSnapDistance":start_d,"labelSnapDistance":goal_d},
    "chunks":[{"file":"routes/part-01.json","features":len(features),"bytes":part.stat().st_size}]
},ensure_ascii=False,separators=(",",":")),encoding="utf-8")
print("Generated",len(features),"original-CAD path(s) for",TEST_FEEDER)
