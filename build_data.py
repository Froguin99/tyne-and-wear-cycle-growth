"""
Build the data files for the workshop growth dashboard.

Read-only with respect to the main project: this reads the growth pickles,
analysis JSONs and context GeoPackages from ../bikenwgrowth_external and writes
ONLY into ./dashboard/data (plus ./dashboard/config.js and ./cache).

Each run (scenario x strategy) becomes one small JS file that sets
window.WD.runs[...], so the dashboard works straight from file:// (no server,
no fetch()).

Usage (growbikenet env):
    python build_data.py                                   # all Tyne & Wear places, current LTN scenario
    python build_data.py --places newcastle gateshead      # a subset (manifest keeps every place already built)
    python build_data.py --scenarios no_ltn_scenario current_ltn_scenario more_ltn_scenario
"""
import argparse
import json
import os
import pickle
import re
from pathlib import Path

import geopandas as gpd
import numpy as np
import osmnx as ox
from pyproj import Transformer
from shapely.geometry import Point

HERE = Path(__file__).resolve().parent
UNFORKED = HERE.parent
EXTERNAL = UNFORKED / "bikenwgrowth_external"
CODE_REPO = UNFORKED / "ltn-bikenetwork-growth"
OUT = HERE / "dashboard" / "data"
CARTO_KEY_FILE = UNFORKED.parent.parent / "cycleNodes" / "Cycle-node-network-feasibility" / "carto_api_key.txt"

# placeid -> (display name, geocoding string used by the pipeline in parameters/cities*.csv)
PLACES = {
    "newcastle": ("Newcastle upon Tyne", "Newcastle upon Tyne"),
    "gateshead": ("Gateshead", "Gateshead"),
    "north_tyneside": ("North Tyneside", "North Tyneside"),
    "south_tyneside": ("South Tyneside", "South Tyneside"),
    "sunderland": ("Sunderland", "Sunderland"),
}
POI_SOURCE = "LTNs_tessellation"
N_DP = 5  # coordinate decimals (~1 m)

# (key, pickle prune measure, analysis-json prefix, path-LTS key, label, colour, dashed)
# Colours match plot_growth_panels_publication.py so the workshop matches the paper.
STRATEGIES = [
    ("betweenness", "betweenness", "Betweenness Growth", "Betweenness", "Betweenness", "#3377BB", False),
    ("demand", "demand", "Demand Growth", "Demand", "Demand", "#EE6677", False),
    ("betweenness_ltn_priority", "betweenness_ltn_priority", "Betweenness LTN Priority Growth",
     "Betweenness LTN Priority", "Betweenness, LTN priority", "#228833", True),
    ("demand_ltn_priority", "demand_ltn_priority", "Demand LTN Priority Growth",
     "Demand LTN Priority", "Demand, LTN priority", "#AA3377", True),
]
SCENARIO_LABELS = {
    "no_ltn_scenario": "No LTNs",
    "current_ltn_scenario": "Current LTNs",
    "more_ltn_scenario": "More LTNs",
}

# Chart metrics = exactly the per-stage metrics reported in the paper (Results 4.1), from the same sources the
# publication panels use (plot_growth_panels_publication.py / notebook 06), but for this place only.
#   ("analysis", <suffix in *_analysis_results.json>)  or  ("data", <key in *_data.json>)  or  ("lts", <key in *_path_lts_data.json>)
# deviation=True -> the paper shows it as deviation from the random baseline; the dashboard offers both views.
PAPER_METRICS = [
    dict(id="components", src=("analysis", "Num Components"), label="Disconnected components",
         group="Network structure", unit="", scale=1, deviation=True, lower_better=True),
    dict(id="lcc", src=("analysis", "Composite LCC Length"), label="Largest connected component",
         group="Network structure", unit="km", scale=1e-3, deviation=True),
    dict(id="investment", src=("analysis", "Total Investment Length"), label="Investment required",
         group="Network structure", unit="km", scale=1e-3, deviation=True, lower_better=True),
    dict(id="global_eff", src=("analysis", "Global Efficiency"), label="Global efficiency",
         group="Network structure", unit="", scale=1),
    dict(id="local_eff", src=("analysis", "Local Efficiency"), label="Local efficiency",
         group="Network structure", unit="", scale=1),
    dict(id="demand_met", src=("data", "results_demand_met_pct", "random_demand_pct_mean"), label="Potential demand met",
         group="Network demand", unit="%", scale=1),
    dict(id="cyclable_trips", src=("data", "results_lts_cutoff_pct", "random_lts_cutoff_pct_mean"), label="Cyclable trips",
         group="Network demand", unit="%", scale=1,
         note="Trips with a safe route (LTS 2 or below) within 3 km perceived distance."),
    dict(id="mean_lts", src=("lts", "results_avg_lts", "random_avg_mean"), label="Mean path LTS",
         group="Network comfort", unit="LTS", scale=1, ref=2, lower_better=True),
    dict(id="max_lts", src=("lts", "results_max_lts", "random_max_mean"), label="Maximum path LTS",
         group="Network comfort", unit="LTS", scale=1, ref=2, lower_better=True),
]
EXISTING_INFRA_HIGHWAYS = {k for k, v in json.load(open(CODE_REPO / "parameters" / "distance_cost.json")).items() if v == 0}


def first_existing(*paths):
    for p in paths:
        if p.exists():
            return p
    return None


def r(x):
    return round(float(x), N_DP)


def clean(v):
    """JSON-safe number (None for NaN / missing)."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if not np.isfinite(f) else round(f, 6)


def haversine_m(lon1, lat1, lon2, lat2):
    lon1, lat1, lon2, lat2 = map(np.radians, (lon1, lat1, lon2, lat2))
    h = np.sin((lat2 - lat1) / 2) ** 2 + np.cos(lat1) * np.cos(lat2) * np.sin((lon2 - lon1) / 2) ** 2
    return 6371008.8 * 2 * np.arcsin(np.sqrt(h))


def hw_str(h):
    return h if isinstance(h, str) else (h[0] if isinstance(h, (list, tuple)) and h else "unknown")


def write_js(path, assign, obj):
    with open(path, "w", encoding="utf-8") as f:
        f.write("window.WD = window.WD || {runs: {}, metrics: {}, context: {}, boundary: {}};\n")
        f.write(f"{assign} = ")
        json.dump(obj, f, separators=(",", ":"))
        f.write(";\n")
    print(f"  wrote {path.name} ({path.stat().st_size / 1e6:.2f} MB)")


# ── context layers ─────────────────────────────────────────────────────────
def gdf_lines(gdf, props):
    out = []
    for _, row in gdf.iterrows():
        geom = row.geometry
        parts = getattr(geom, "geoms", [geom])
        for g in parts:
            out.append({"c": [[r(x), r(y)] for x, y in g.coords], **{k: f(row) for k, f in props.items()}})
    return out


def gdf_polys(gdf, props):
    out = []
    for _, row in gdf.iterrows():
        geom = row.geometry.simplify(0.00002)
        for g in getattr(geom, "geoms", [geom]):
            out.append({"c": [[[r(x), r(y)] for x, y in g.exterior.coords]], **{k: f(row) for k, f in props.items()}})
    return out


def build_context(place, scenario):
    d_scen = EXTERNAL / "data" / place / scenario
    d_place = EXTERNAL / "data" / place
    ctx = {}

    ltn_file = first_existing(d_scen / f"scored_neighbourhoods_{place}.gpkg")
    if ltn_file:
        ltns = gpd.read_file(ltn_file).to_crs(4326)
        ctx["ltns"] = gdf_polys(ltns, {"score": lambda row: clean(row.get("overall_score"))})
    else:
        ctx["ltns"] = []

    bt_file = first_existing(d_scen / f"{place}_biketrack_no_ltn.gpkg", d_place / f"{place}_biketrack_no_ltn.gpkg")
    bt = gpd.read_file(bt_file, layer="edges").to_crs(4326)
    bt["geometry"] = bt.geometry.simplify(0.00001)
    ctx["biketrack"] = gdf_lines(bt, {"hw": lambda row: hw_str(row.get("highway"))})

    ex_file = first_existing(EXTERNAL / "exports_gpkg" / place / scenario / f"{place}_exit_points.gpkg")
    ctx["exits"] = ([[r(g.x), r(g.y)] for g in gpd.read_file(ex_file).to_crs(4326).geometry] if ex_file else [])

    seeds_file = first_existing(d_scen / f"{place}_combined_points.gpkg", d_place / f"{place}_combined_points.gpkg")
    seeds = gpd.read_file(seeds_file).to_crs(4326)
    ctx["seeds_raw"] = seeds  # matched to abstract nodes per run below
    return ctx


def build_boundary(place, place_query):
    ox.settings.cache_folder = str(HERE / "cache")
    ox.settings.use_cache = True
    b = ox.geocode_to_gdf(place_query).to_crs(4326)
    return gdf_polys(b, {})


# ── growth runs ────────────────────────────────────────────────────────────
def build_run(place, scenario, strat, ltn_union, seeds, ltn_polys):
    key, measure = strat[0], strat[1]
    pf = EXTERNAL / "results" / place / scenario / f"{place}_poi_{POI_SOURCE}_{measure}_weighted_{scenario}.pickle"
    if not pf.exists():
        print(f"  [skip] {place}/{scenario}/{key}: no pickle")
        return None
    with open(pf, "rb") as f:
        res = pickle.load(f)
    GTs, GAs = res["GTs"], res["GT_abstracts"]
    n = len(GTs)

    # Stage at which each undirected routed edge first appears (graphs are cumulative).
    first = {}
    for s, G in enumerate(GTs, start=1):
        for u, v, d in G.edges(data=True):
            k = (u, v) if u <= v else (v, u)
            if k not in first:
                first[k] = (s, d)
    Gl = GTs[-1]
    segs = []
    for (u, v), (s, d) in first.items():
        a, b = Gl.nodes[u], Gl.nodes[v]
        hw = hw_str(d.get("highway"))
        mid = Point((a["x"] + b["x"]) / 2, (a["y"] + b["y"]) / 2)
        segs.append([r(a["x"]), r(a["y"]), r(b["x"]), r(b["y"]), s, hw, round(d.get("length", 0), 1),
                     0 if hw in EXISTING_INFRA_HIGHWAYS else 1,
                     1 if (ltn_union is not None and ltn_union.contains(mid)) else 0])
    segs.sort(key=lambda x: x[4])

    # Seed positions, keyed by node ID.
    # NB: the abstract graphs' node x/y attributes do NOT match their IDs (stale after gdf_to_nx_graph), so they are
    # never used here. Instead:
    #   - tessellation seeds are routed from their OSM node -> use that node's position in the routed graph
    #   - LTN seeds are routed from their LTN's exit points -> use the LTN point (combined_points.nearest_node)
    # The abstract edges' own geometry (what the GIFs draw) is used to verify every position below.
    Al = GAs[-1]
    pos, seed_type, nbhd_of = {}, {}, {}
    for _, row in seeds.iterrows():
        nn = row.get("nearest_node")
        if nn is not None and not (isinstance(nn, float) and np.isnan(nn)):
            pos[int(nn)] = (row.geometry.x, row.geometry.y); seed_type[int(nn)] = "ltn"
            nbhd_of[int(nn)] = int(row["neighbourhood_id"])
        else:
            pos[int(row["osmid"])] = (row.geometry.x, row.geometry.y); seed_type[int(row["osmid"])] = "tess"
    for nd in Al.nodes:
        if seed_type.get(nd) != "ltn" and nd in Gl.nodes:
            pos[nd] = (Gl.nodes[nd]["x"], Gl.nodes[nd]["y"])
    missing = [nd for nd in Al.nodes if nd not in pos]
    if missing:
        raise RuntimeError(f"{scenario}/{key}: no position for abstract nodes {missing[:5]}")
    to4326 = Transformer.from_crs(3857, 4326, always_xy=True)
    worst = 0.0
    for u, v, d in Al.edges(data=True):
        g = d.get("geometry")
        if g is None:
            continue
        a = to4326.transform(*g.coords[0]); b = to4326.transform(*g.coords[-1])
        err = min(max(haversine_m(*a, *pos[u]), haversine_m(*b, *pos[v])),
                  max(haversine_m(*a, *pos[v]), haversine_m(*b, *pos[u])))
        worst = max(worst, err)
    if worst > 400:
        raise RuntimeError(f"{scenario}/{key}: seed positions disagree with abstract edge geometry by {worst:.0f} m")

    # LTN seed -> its neighbourhood polygon (metric CRS), to flag LTN-LTN links between touching LTNs:
    # those need no new street, so they legitimately have no routed links.
    # neighbourhood_id is the row of scored_neighbourhoods_<place>.gpkg (checked for all five places); matching by ID
    # rather than by distance matters where a snapped LTN seed sits just outside its own polygon (e.g. Gateshead).
    poly_of = {}
    if ltn_polys is not None and len(ltn_polys):
        for nd, i in nbhd_of.items():
            if 0 <= i < len(ltn_polys):
                poly_of[nd] = ltn_polys.geometry.iloc[i]

    # Abstract links
    afirst = {}
    for s, A in enumerate(GAs, start=1):
        for u, v, d in A.edges(data=True):
            k = (u, v) if u <= v else (v, u)
            if k not in afirst:
                afirst[k] = (s, d)
    abstract = []
    for (u, v), (s, d) in afirst.items():
        (ax_, ay_), (bx_, by_) = pos[u], pos[v]
        abstract.append({"c": [r(ax_), r(ay_), r(bx_), r(by_)], "s": s,
                         "t": [seed_type.get(u, "tess"), seed_type.get(v, "tess")],
                         "adj": 1 if (u in poly_of and v in poly_of and poly_of[u].distance(poly_of[v]) < 5) else 0,
                         "eucl": clean(haversine_m(ax_, ay_, bx_, by_)),
                         "route": clean(d.get("sp_true_distance")), "lts": clean(d.get("sp_lts_distance"))})
    abstract.sort(key=lambda x: x["s"])

    # Seeds: stage each abstract node is first connected
    nfirst = {}
    for s, A in enumerate(GAs, start=1):
        for nd in A.nodes:
            nfirst.setdefault(nd, s)
    seed_out = [{"c": [r(pos[nd][0]), r(pos[nd][1])], "s": nfirst.get(nd), "t": seed_type.get(nd, "tess")}
                for nd in Al.nodes]
    print(f"  {scenario}/{key}: seed positions verified against abstract edge geometry (worst {worst:.0f} m)")

    # Per-stage physical stats (undirected, so two-way streets count once)
    stats = {k: [0.0] * (n + 1) for k in ("len_km", "new_km", "existing_km", "ltn_km", "added_km", "added_links",
                                          "n_abstract", "added_abstract", "seeds")}
    for sg in segs:
        s, L = sg[4], sg[6] / 1000
        stats["added_km"][s] += L
        stats["added_links"][s] += 1
        for t in range(s, n + 1):
            stats["len_km"][t] += L
            stats["new_km" if sg[7] else "existing_km"][t] += L
            if sg[8]:
                stats["ltn_km"][t] += L
    for ab in abstract:
        stats["added_abstract"][ab["s"]] += 1
        for t in range(ab["s"], n + 1):
            stats["n_abstract"][t] += 1
    for sd in seed_out:
        if sd["s"]:
            for t in range(sd["s"], n + 1):
                stats["seeds"][t] += 1
    stats = {k: [round(x, 3) for x in v] for k, v in stats.items()}

    hw_list = sorted({sg[5] for sg in segs})
    for sg in segs:
        sg[5] = hw_list.index(sg[5])

    print(f"  {scenario}/{key}: {n} stages, {len(segs)} routed links, {len(abstract)} abstract links, "
          f"{len(seed_out)} seeds, final {stats['len_km'][-1]:.1f} km")
    return {"scenario": scenario, "strategy": key, "n": n,
            "budget_km": [round(q / 1000, 3) for q in res.get("prune_quantiles", [])],
            "hw": hw_list, "segs": segs, "abstract": abstract, "seeds": seed_out, "stats": stats,
            "seg_fields": ["x1", "y1", "x2", "y2", "stage", "hw", "length_m", "new_investment", "in_ltn"]}


# ── metrics ────────────────────────────────────────────────────────────────
def build_metrics(place, scenario):
    d_res = EXTERNAL / "results" / place / scenario
    sources = {
        "analysis": d_res / f"{place}_{scenario}_analysis_results.json",
        "data": d_res / f"{place}_{scenario}_data.json",
        "lts": d_res / f"{place}_{scenario}_path_lts_data.json",
    }
    loaded = {k: json.load(open(v, encoding="utf-8")) for k, v in sources.items() if v.exists()}
    analysis_prefix = {s[2]: s[0] for s in STRATEGIES}   # "Betweenness Growth" -> betweenness
    short_key = {s[3]: s[0] for s in STRATEGIES}         # "Betweenness" -> betweenness

    def sc(arr, scale):
        return [clean(v * scale) if v is not None else None for v in arr]

    out = []
    for m in PAPER_METRICS:
        kind = m["src"][0]
        if kind not in loaded:
            print(f"  [skip] {m['label']}: no {kind} file")
            continue
        data, scale = loaded[kind], m["scale"]
        series, rand, band, n_rand = {}, None, None, 0
        if kind == "analysis":
            suf = m["src"][1]
            for p, k in analysis_prefix.items():
                if f"{p} - {suf}" in data:
                    series[k] = sc(data[f"{p} - {suf}"], scale)
            run_key = re.compile(rf"^Random Run \d+ - {re.escape(suf)}$")  # exact: not the "... Deviation from Random" keys
            runs = [data[k] for k in data if run_key.match(k)]
            if runs:
                arr = np.array([[np.nan if x is None else x for x in run] for run in runs], dtype=float) * scale
                band = [[clean(x) for x in np.nanpercentile(arr, 5, axis=0)], [clean(x) for x in np.nanpercentile(arr, 95, axis=0)]]
                n_rand = len(runs)
            rm = data.get(f"Random Growth (mean) - {suf}")
            rand = sc(rm, scale) if rm is not None else ([clean(x) for x in np.nanmean(arr, axis=0)] if runs else None)
        else:
            res_key, rnd_key = m["src"][1], m["src"][2]
            series = {short_key[k]: sc(v, scale) for k, v in data.get(res_key, {}).items() if k in short_key}
            rand = sc(data[rnd_key], scale) if rnd_key in data else None
        if not series:
            print(f"  [skip] {m['label']}: no series")
            continue
        out.append({"id": m["id"], "label": m["label"], "group": m["group"], "unit": m["unit"], "series": series,
                    "random": rand, "band": band, "nRandom": n_rand, "note": m.get("note"),
                    "deviation": m.get("deviation", False), "ref": m.get("ref"), "lowerBetter": m.get("lower_better", False)})
    print(f"  metrics for {scenario}: {len(out)} ({', '.join(x['label'] for x in out)})")
    return out


def build_place(place, scenarios):
    label, query = PLACES[place]
    out = OUT / place
    out.mkdir(parents=True, exist_ok=True)
    print(f"#### {label}")
    write_js(out / "boundary.js", f'window.WD.boundary["{place}"]', build_boundary(place, query))
    part = {"key": place, "label": label, "boundary": f"{place}/boundary.js", "scenarios": []}
    for scenario in scenarios:
        print(f"== {place} / {scenario}")
        ctx = build_context(place, scenario)
        ltn_union, ltn_polys = None, None
        ltn_file = EXTERNAL / "data" / place / scenario / f"scored_neighbourhoods_{place}.gpkg"
        if ltn_file.exists():
            ltn_gdf = gpd.read_file(ltn_file)
            ltn_union = ltn_gdf.to_crs(4326).geometry.unary_union
            ltn_polys = ltn_gdf.to_crs(27700)
        runs = []
        for strat in STRATEGIES:
            run = build_run(place, scenario, strat, ltn_union, ctx["seeds_raw"], ltn_polys)
            if run:
                fn = f"{place}/run__{scenario}__{strat[0]}.js"
                write_js(OUT / fn, f'window.WD.runs["{place}/{scenario}/{strat[0]}"]', run)
                runs.append({"key": strat[0], "file": fn})
        write_js(out / f"metrics__{scenario}.js", f'window.WD.metrics["{place}/{scenario}"]', build_metrics(place, scenario))
        write_js(out / f"context__{scenario}.js", f'window.WD.context["{place}/{scenario}"]',
                 {"ltns": ctx["ltns"], "biketrack": ctx["biketrack"], "exits": ctx["exits"]})
        part["scenarios"].append({"key": scenario, "label": SCENARIO_LABELS.get(scenario, scenario), "runs": runs,
                                  "metrics": f"{place}/metrics__{scenario}.js", "context": f"{place}/context__{scenario}.js"})
    with open(out / "manifest_part.json", "w", encoding="utf-8") as f:
        json.dump(part, f, indent=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--places", nargs="+", default=list(PLACES), choices=list(PLACES))
    ap.add_argument("--scenarios", nargs="+", default=["current_ltn_scenario"])
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    for place in args.places:
        build_place(place, args.scenarios)

    # Manifest = every place built so far (in PLACES order), so a partial rebuild keeps the others
    parts = [json.load(open(OUT / p / "manifest_part.json", encoding="utf-8"))
             for p in PLACES if (OUT / p / "manifest_part.json").exists()]
    manifest = {"places": parts,
                "strategies": [{"key": s[0], "label": s[4], "color": s[5], "dashed": s[6]} for s in STRATEGIES]}
    with open(OUT / "manifest.js", "w", encoding="utf-8") as f:
        f.write("window.WD_MANIFEST = ")
        json.dump(manifest, f, indent=1)
        f.write(";\n")

    key = os.environ.get("CARTO_API_KEY") or (CARTO_KEY_FILE.read_text().strip() if CARTO_KEY_FILE.exists() else "")
    with open(HERE / "dashboard" / "config.js", "w", encoding="utf-8") as f:
        f.write(f"window.CARTO_API_KEY = {json.dumps(key)};\n")
    print("config.js written" + (" with Carto key" if key else " WITHOUT a Carto key (falls back to keyless tiles)"))


if __name__ == "__main__":
    main()
