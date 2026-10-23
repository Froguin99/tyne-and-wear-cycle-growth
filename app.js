/* Network growth explorer: map + slider + metric chart.
   Data comes from data/*.js written by ../build_data.py (window.WD, window.WD_MANIFEST). */
(function () {
  "use strict";

  const M = window.WD_MANIFEST;
  const WD = (window.WD = window.WD || { runs: {}, metrics: {}, context: {}, boundary: {} });
  const $ = (id) => document.getElementById(id);

  // ── palette (validated dataviz steps) ─────────────────────────────────────
  // Build-order ramp, early -> late: the first-built links get the strongest contrast against the basemap
  const RAMP_LIGHT = ["#0d366b", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#86b6ef"];
  const RAMP_DARK = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];
  let BLUE_RAMP = RAMP_LIGHT;
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : !!(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  };
  // Light/dark steps of the same hues; ink colours follow the theme so marks stay visible on either basemap.
  const palette = () => isDark()
    ? { newInfra: "#3987e5", existing: "#199e70", ltn: "#9085e9", ghost: "#6f6d68", abstract: "#d8d6d0",
        boundary: "#f0efec", seedOn: "#f0efec", seedOff: "#1a1a19", seedRing: "#f0efec", hl: "#ffffff" }
    : { newInfra: "#2a78d6", existing: "#1baf7a", ltn: "#4a3aa7", ghost: "#b3b1ab", abstract: "#3d3c38",
        boundary: "#1d1d1b", seedOn: "#1d1d1b", seedOff: "#ffffff", seedRing: "#1d1d1b", hl: "#1d1d1b" };
  let C = palette();
  const setRamp = () => { BLUE_RAMP = isDark() ? RAMP_DARK : RAMP_LIGHT; };

  // ── state ─────────────────────────────────────────────────────────────────
  const S = {
    place: null, scenario: null, strategy: "demand", run: null, stage: 0, n: 100,
    colorMode: "order", ghost: false, showRandom: true, metricId: null, devMode: false,
    playing: null, routedState: [], abstractState: [], hidden: new Set(),
  };

  // ── helpers ───────────────────────────────────────────────────────────────
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }
  const loaded = new Set();
  async function need(file) {
    if (loaded.has(file)) return;
    await loadScript("data/" + file);
    loaded.add(file);
  }
  function hexToRgb(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function mix(a, b, t) {
    const A = hexToRgb(a), B = hexToRgb(b);
    return "#" + A.map((x, i) => Math.round(x + (B[i] - x) * t).toString(16).padStart(2, "0")).join("");
  }
  function rampAt(t) {
    const p = Math.min(Math.max(t, 0), 1) * (BLUE_RAMP.length - 1);
    const i = Math.min(Math.floor(p), BLUE_RAMP.length - 2);
    return mix(BLUE_RAMP[i], BLUE_RAMP[i + 1], p - i);
  }
  function fmt(v, unit, digits) {
    if (v === null || v === undefined || Number.isNaN(v)) return "–";
    const a = Math.abs(v);
    const d = digits !== undefined ? digits : a >= 100 ? 0 : a >= 10 ? 1 : a >= 1 ? 2 : 3;
    const s = v.toLocaleString("en-GB", { maximumFractionDigits: d, minimumFractionDigits: 0 });
    return unit ? (unit === "%" ? s + "%" : s + " " + unit) : s;
  }
  const strategyInfo = (key) => M.strategies.find((s) => s.key === key);
  const placeInfo = (key) => M.places.find((p) => p.key === key);
  const scenarioInfo = (key) => placeInfo(S.place).scenarios.find((s) => s.key === key);
  const scKey = () => `${S.place}/${S.scenario}`;

  // ── map ───────────────────────────────────────────────────────────────────
  const map = L.map("map", { zoomControl: true, preferCanvas: true, zoomSnap: 0.25, zoomDelta: 0.5 });
  map.attributionControl.setPrefix(false);
  const ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>';
  let tiles = null;
  function setBasemap() {
    if (tiles) map.removeLayer(tiles);
    const style = isDark() ? "dark_all" : "light_all";
    const keyed = window.CARTO_API_KEY
      ? `https://basemaps.cartocdn.com/rastertiles/${style}/{z}/{x}/{y}.png?key=${window.CARTO_API_KEY}` : null;
    const keyless = `https://{s}.basemaps.cartocdn.com/${style}/{z}/{x}/{y}{r}.png`;
    tiles = L.tileLayer(keyed || keyless, { attribution: ATTR, maxZoom: 20, subdomains: "abcd" }).addTo(map);
    if (keyed) {
      let errs = 0;
      tiles.on("tileerror", () => {
        if (++errs === 6) { // key rejected or offline: fall back to the public endpoint
          map.removeLayer(tiles);
          tiles = L.tileLayer(keyless, { attribution: ATTR, maxZoom: 20, subdomains: "abcd" }).addTo(map);
        }
      });
    }
  }

  const panes = [["ctxPolys", 410], ["ctxLines", 420], ["routedPane", 430], ["highlightPane", 440],
                 ["abstractPane", 450], ["seedPane", 620]];
  const R = {};
  panes.forEach(([name, z]) => {
    map.createPane(name).style.zIndex = z;
    R[name] = L.canvas({ pane: name, tolerance: 6 });
  });
  map.getPane("seedPane").style.pointerEvents = "auto";

  const layers = {
    boundary: L.layerGroup(), ltn: L.layerGroup(), bike: L.layerGroup(),
    routed: L.layerGroup().addTo(map), abstract: L.layerGroup(), seeds: L.layerGroup(), exits: L.layerGroup(),
    highlight: L.layerGroup().addTo(map),
  };
  let routedGroups = [], abstractGroups = [], seedMarkers = [];

  // boundary (per place, always shown)
  const boundaryStyle = () => ({ color: C.boundary, weight: 2, dashArray: "6 6", fill: false, opacity: 0.7 });
  async function loadBoundary(place) {
    await need(placeInfo(place).boundary);
    layers.boundary.clearLayers();
    (WD.boundary[place] || []).forEach((p) => {
      L.polygon(p.c.map((ring) => ring.map(([x, y]) => [y, x])), {
        renderer: R.ctxPolys, pane: "ctxPolys", interactive: false, ...boundaryStyle(),
      }).addTo(layers.boundary);
    });
    if (layers.boundary.getLayers().length) {
      // keep the place clear of the map card on the right
      const card = $("layersCard").offsetWidth + 20;
      map.fitBounds(L.featureGroup(layers.boundary.getLayers()).getBounds(), { paddingTopLeft: [20, 20], paddingBottomRight: [card, 20] });
    }
  }
  map.setView([54.97, -1.6], 11);

  function buildContext() {
    layers.ltn.clearLayers(); layers.bike.clearLayers(); layers.exits.clearLayers();
    const ctx = WD.context[scKey()] || { ltns: [], biketrack: [], exits: [] };
    (ctx.exits || []).forEach(([x, y]) => {
      L.circleMarker([y, x], {
        renderer: R.abstractPane, pane: "abstractPane", radius: 3, weight: 1.5, color: C.ltn, fillColor: C.seedOff,
        fillOpacity: 1, interactive: false,
      }).addTo(layers.exits);
    });
    ctx.ltns.forEach((p) => {
      L.polygon(p.c.map((ring) => ring.map(([x, y]) => [y, x])), {
        renderer: R.ctxPolys, pane: "ctxPolys", color: C.ltn, weight: 1, opacity: 0.7,
        fillColor: C.ltn, fillOpacity: 0.12,
      }).bindTooltip(`LTN neighbourhood<br>plausibility score ${fmt(p.score, "", 1)}`, { sticky: true })
        .addTo(layers.ltn);
    });
    ctx.biketrack.forEach((l) => {
      L.polyline(l.c.map(([x, y]) => [y, x]), {
        renderer: R.ctxLines, pane: "ctxLines", color: C.existing, weight: 1.5, opacity: 0.65, interactive: false,
      }).addTo(layers.bike);
    });
  }

  // ── growth layers ─────────────────────────────────────────────────────────
  function routedStyle(seg, state) {
    const stage = seg[4];
    if (state === "future") return { color: C.ghost, weight: 1.6, opacity: 0.7 };
    if (state === "cur") return { color: css("--accent") || "#eb6834", weight: 5, opacity: 1 };
    let color;
    if (S.colorMode === "invest") color = seg[7] ? C.newInfra : C.existing;
    else color = orderColor(stage);
    return { color, weight: 2.6, opacity: 0.95 };
  }
  function abstractStyle(state, ab) {
    if (state === "future") return { color: C.ghost, weight: 1.4, opacity: 0.7, dashArray: "4 6" };
    if (state === "cur") return { color: css("--accent") || "#eb6834", weight: 3.5, opacity: 1, dashArray: "8 6" };
    if (S.colorMode === "order") return { color: orderColor(ab.s), weight: 2.4, opacity: 0.95, dashArray: "6 6" };
    return { color: C.abstract, weight: 2, opacity: 0.8, dashArray: "6 6" };
  }
  function orderColor(stage) { return rampAt((stage - 1) / Math.max(S.n - 1, 1)); }

  function buildRun(run) {
    layers.routed.clearLayers(); layers.abstract.clearLayers(); layers.seeds.clearLayers(); layers.highlight.clearLayers();
    S.n = run.n;
    routedGroups = Array.from({ length: run.n + 1 }, () => L.layerGroup());
    abstractGroups = Array.from({ length: run.n + 1 }, () => L.layerGroup());
    run.segs.forEach((seg) => {
      const pl = L.polyline([[seg[1], seg[0]], [seg[3], seg[2]]], { renderer: R.routedPane, pane: "routedPane" });
      pl.seg = seg;
      pl.on("click", (e) => { L.DomEvent.stopPropagation(e); selectRouted(seg, e.latlng); });
      routedGroups[seg[4]].addLayer(pl);
    });
    run.abstract.forEach((ab) => {
      const pl = L.polyline([[ab.c[1], ab.c[0]], [ab.c[3], ab.c[2]]], { renderer: R.abstractPane, pane: "abstractPane" });
      pl.ab = ab;
      pl.on("click", (e) => { L.DomEvent.stopPropagation(e); selectAbstract(ab, e.latlng); });
      abstractGroups[ab.s].addLayer(pl);
    });
    seedMarkers = run.seeds.map((sd) => {
      const ll = [sd.c[1], sd.c[0]];
      const m = sd.t === "ltn"
        ? L.marker(ll, { pane: "seedPane", icon: L.divIcon({ className: "ltnseed", iconSize: [12, 12] }), keyboard: false })
        : L.circleMarker(ll, { pane: "seedPane", radius: 5, weight: 2 });
      m.sd = sd;
      m.bindTooltip(() => seedTooltip(sd));
      m.addTo(layers.seeds);
      return m;
    });
    S.routedState = new Array(run.n + 1).fill(null);
    S.abstractState = new Array(run.n + 1).fill(null);
    const sl = $("stage");
    sl.max = run.n; $("stageMax").textContent = run.n;
    if (S.stage > run.n) S.stage = run.n;
  }

  function seedTooltip(sd) {
    const kind = sd.t === "ltn" ? "LTN seed point" : "Seed point (tessellation)";
    return sd.s ? `${kind}<br>connected at stage ${sd.s}` : `${kind}<br>never connected`;
  }

  function stateFor(s) { return s < S.stage ? "past" : s === S.stage ? "cur" : "future"; }

  function renderGrowth(force) {
    for (let s = 1; s <= S.n; s++) {
      const st = stateFor(s);
      // routed
      const key = st + (st === "future" ? (S.ghost ? "g" : "h") : "");
      if (force || S.routedState[s] !== key) {
        const g = routedGroups[s];
        if (st === "future" && !S.ghost) layers.routed.removeLayer(g);
        else {
          g.eachLayer((pl) => pl.setStyle(routedStyle(pl.seg, st)));
          if (!layers.routed.hasLayer(g)) layers.routed.addLayer(g);
          if (st === "cur") g.eachLayer((pl) => pl.bringToFront());
        }
        S.routedState[s] = key;
      }
      // abstract
      if (force || S.abstractState[s] !== key) {
        const g = abstractGroups[s];
        if (st === "future" && !S.ghost) layers.abstract.removeLayer(g);
        else {
          g.eachLayer((pl) => pl.setStyle(abstractStyle(st, pl.ab)));
          if (!layers.abstract.hasLayer(g)) layers.abstract.addLayer(g);
        }
        S.abstractState[s] = key;
      }
    }
    // seeds: filled once connected, hollow before; ringed in accent when connected this stage
    const accent = css("--accent") || "#eb6834";
    seedMarkers.forEach((m) => {
      const sd = m.sd, on = sd.s && sd.s <= S.stage, now = sd.s === S.stage;
      if (sd.t === "ltn") {
        const el = m.getElement && m.getElement();
        if (el) {
          el.classList.toggle("off", !on);
          el.style.boxShadow = now ? `0 0 0 3px ${accent}` : "none";
        }
      } else {
        m.setStyle({
          color: now ? accent : C.seedRing, weight: now ? 3 : 2,
          fillColor: on ? C.seedOn : C.seedOff, fillOpacity: 1, radius: now ? 6 : 5,
        });
      }
    });
  }

  // ── selection details ─────────────────────────────────────────────────────
  function highlight(latlngsList) {
    layers.highlight.clearLayers();
    latlngsList.forEach((ll) => L.polyline(ll, {
      renderer: R.highlightPane, pane: "highlightPane", color: C.hl, weight: 9, opacity: 0.35, interactive: false,
    }).addTo(layers.highlight));
  }
  const popup = L.popup({ maxWidth: 320, minWidth: 260, autoPanPadding: [20, 20] });
  function detail(html, latlng) { popup.setLatLng(latlng).setContent(`<div class="detail">${html}</div>`).openOn(map); }
  function jumpButtons(stage, extra) {
    return `<div class="detailbtns"><button class="btn" data-jump="${stage}">Go to stage ${stage}</button>${extra || ""}</div>`;
  }
  function selectRouted(seg, latlng) {
    const run = S.run, hw = run.hw[seg[5]];
    latlng = latlng || [(seg[1] + seg[3]) / 2, (seg[0] + seg[2]) / 2];
    highlight([[[seg[1], seg[0]], [seg[3], seg[2]]]]);
    detail(`<h2>Routed link</h2><dl class="kv">
      <dt>Added at</dt><dd>stage ${seg[4]} of ${run.n}</dd>
      <dt>Street type</dt><dd>${hw}</dd>
      <dt>Length</dt><dd>${fmt(seg[6], "m", 0)}</dd>
      <dt>Build cost</dt><dd>${seg[7] ? "new investment" : "existing cycle infrastructure (no cost)"}</dd>
      <dt>Inside an LTN</dt><dd>${seg[8] ? "yes" : "no"}</dd></dl>
      ${jumpButtons(seg[4], `<button class="btn" data-stagehl="${seg[4]}">Highlight stage ${seg[4]}</button>`)}`, latlng);
  }
  function selectAbstract(ab, latlng) {
    latlng = latlng || [(ab.c[1] + ab.c[3]) / 2, (ab.c[0] + ab.c[2]) / 2];
    highlight([[[ab.c[1], ab.c[0]], [ab.c[3], ab.c[2]]]]);
    const detour = ab.route && ab.eucl ? ab.route / ab.eucl : null;
    const kind = (t) => (t === "ltn" ? "LTN" : "tessellation point");
    let why = "";
    if (ab.adj) why = `<p class="note">These two LTNs touch, so little or no new street is needed to link them.</p>`;
    else if (ab.t.includes("ltn")) why = `<p class="note">Routes to an LTN start at its boundary exit points: streets inside the LTN already count as low-traffic, so the route stops at the LTN edge.</p>`;
    detail(`<h2>Abstract link</h2><dl class="kv">
      <dt>Added at</dt><dd>stage ${ab.s} of ${S.run.n}</dd>
      <dt>Connects</dt><dd>${kind(ab.t[0])} &harr; ${kind(ab.t[1])}</dd>
      <dt>Straight-line distance</dt><dd>${fmt(ab.eucl / 1000, "km", 2)}</dd>
      <dt>Routed distance</dt><dd>${fmt(ab.route / 1000, "km", 2)}</dd>
      <dt>Detour ratio</dt><dd>${fmt(detour, "", 2)}</dd>
      <dt>LTS-weighted distance</dt><dd>${fmt(ab.lts / 1000, "km", 2)}</dd></dl>${why}
      ${jumpButtons(ab.s, `<button class="btn" data-stagehl="${ab.s}">Highlight stage ${ab.s}</button>`)}`, latlng);
  }
  function highlightStage(stage) {
    const lls = [];
    routedGroups[stage].eachLayer((pl) => lls.push(pl.getLatLngs()));
    abstractGroups[stage].eachLayer((pl) => lls.push(pl.getLatLngs()));
    highlight(lls);
  }
  map.getContainer().addEventListener("click", (e) => {
    const j = e.target.closest("[data-jump]"), h = e.target.closest("[data-stagehl]");
    if (j) setStage(+j.dataset.jump);
    if (h) highlightStage(+h.dataset.stagehl);
  }, true); // capture: Leaflet stops click propagation inside popups
  map.on("click", () => layers.highlight.clearLayers());

  // ── tiles (info panel) ────────────────────────────────────────────────────
  function renderTiles() {
    const st = S.run.stats, s = S.stage, m = currentMetric();
    const strat = strategyInfo(S.strategy);
    const nSeeds = S.run.seeds.length;
    let metricTile = "";
    if (m) {
      const v = (m.series[S.strategy] || [])[s];
      const rv = m.random ? m.random[s] : null;
      metricTile = `<div class="tile" style="grid-column:1/-1"><div class="k">${m.label} · ${strat.label}</div>
        <div class="v">${fmt(v, m.unit)}</div>
        <div class="s">${S.showRandom && rv !== null && rv !== undefined ? "random baseline " + fmt(rv, m.unit) : "&nbsp;"}</div></div>`;
    }
    const share = st.len_km[s] ? (100 * st.new_km[s]) / st.len_km[s] : 0;
    $("tiles").innerHTML = `
      <div class="tile accent"><div class="k">Added this stage</div><div class="v">${fmt(st.added_km[s], "km", 1)}</div>
        <div class="s">${st.added_links[s]} street segments · ${st.added_abstract[s]} abstract links</div></div>
      <div class="tile"><div class="k">Network on map</div><div class="v">${fmt(st.len_km[s], "km", 1)}</div>
        <div class="s">${st.n_abstract[s]} abstract links</div></div>
      <div class="tile"><div class="k">New investment</div><div class="v">${fmt(st.new_km[s], "km", 1)}</div>
        <div class="s">${fmt(share, "%", 0)} of the network</div></div>
      <div class="tile"><div class="k">Existing infra reused</div><div class="v">${fmt(st.existing_km[s], "km", 1)}</div>
        <div class="s">${fmt(st.ltn_km[s], "km", 1)} runs inside LTNs</div></div>
      <div class="tile"><div class="k">Seed points connected</div><div class="v">${st.seeds[s]} <span class="muted" style="font-size:14px">/ ${nSeeds}</span></div>
        <div class="s">&nbsp;</div></div>
      <div class="tile"><div class="k">Stage</div><div class="v">${s} <span class="muted" style="font-size:14px">/ ${S.n}</span></div>
        <div class="s">${fmt((100 * st.len_km[s]) / st.len_km[S.n], "%", 0)} of the full network</div></div>
      ${metricTile}`;
  }

  // ── chart ─────────────────────────────────────────────────────────────────
  let chart = null;
  const currentMetric = () => (WD.metrics[scKey()] || []).find((m) => m.id === S.metricId);

  const stageLine = {
    id: "stageLine",
    afterDatasetsDraw(c) {
      const x = c.scales.x.getPixelForValue(S.stage), { top, bottom } = c.chartArea;
      const ctx = c.ctx;
      ctx.save();
      ctx.strokeStyle = css("--accent") || "#eb6834"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke();
      ctx.restore();
    },
  };

  const refLine = {
    id: "refLine",
    afterDatasetsDraw(c) {
      const m = currentMetric();
      if (!m || m.ref === null || m.ref === undefined || (m.deviation && S.devMode)) return;
      const y = c.scales.y.getPixelForValue(m.ref), { left, right, top, bottom } = c.chartArea;
      if (y < top || y > bottom) return;
      const ctx = c.ctx;
      ctx.save();
      ctx.strokeStyle = css("--ink-3"); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(right, y); ctx.stroke();
      ctx.setLineDash([]); ctx.fillStyle = css("--ink-3"); ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "right"; ctx.fillText(`LTS ${m.ref}`, right - 4, y - 4);
      ctx.restore();
    },
  };

  function populateMetrics() {
    const sel = $("metric"), metrics = WD.metrics[scKey()] || [];
    sel.innerHTML = "";
    const groups = {};
    metrics.forEach((m) => {
      if (!groups[m.group]) { groups[m.group] = document.createElement("optgroup"); groups[m.group].label = m.group; sel.appendChild(groups[m.group]); }
      const o = document.createElement("option");
      o.value = m.id; o.textContent = m.label + (m.unit ? ` (${m.unit})` : "");
      groups[m.group].appendChild(o);
    });
    if (!metrics.find((m) => m.id === S.metricId)) S.metricId = metrics.length ? metrics[0].id : null;
    sel.value = S.metricId;
  }

  function buildChart() {
    const m = currentMetric();
    if (chart) { chart.destroy(); chart = null; }
    if (!m) return;
    const ink2 = css("--ink-2"), ink3 = css("--ink-3"), grid = css("--grid");
    const dev = m.deviation && S.devMode && m.random;
    $("devRow").hidden = !m.deviation;
    // "vs random baseline" = strategy minus random mean, exactly the paper's deviation panels
    const tr = (arr) => (dev ? arr.map((y, i) => (y === null || m.random[i] === null ? null : y - m.random[i])) : arr);
    const xs = (arr) => tr(arr).map((y, i) => ({ x: i, y }));
    const ds = [];
    if (S.showRandom && m.band) {
      ds.push({ label: "_bandHi", data: xs(m.band[1]), borderWidth: 0, pointRadius: 0, fill: "+1",
                backgroundColor: isDark() ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.07)" });
      ds.push({ label: "_bandLo", data: xs(m.band[0]), borderWidth: 0, pointRadius: 0, fill: false });
    }
    if (S.showRandom && m.random) {
      ds.push({ label: dev ? "Random baseline (zero)" : "Random (mean)", data: xs(m.random), borderColor: isDark() ? "#aaa9a3" : "#444444",
                borderWidth: 1.5, borderDash: [2, 3], pointRadius: 0, fill: false, _key: "random" });
    }
    const order = M.strategies.filter((s) => m.series[s.key]).sort((a, b) => (a.key === S.strategy) - (b.key === S.strategy));
    order.forEach((s) => {
      const sel = s.key === S.strategy;
      ds.push({
        label: s.label, data: xs(m.series[s.key]), borderColor: sel ? s.color : s.color + "99",
        borderWidth: sel ? 3 : 1.6, borderDash: s.dashed ? [6, 4] : [], fill: false, _key: s.key,
        pointRadius: (ctx) => (sel && ctx.dataIndex === S.stage ? 5 : 0),
        pointBackgroundColor: s.color, pointBorderColor: css("--surface-1"), pointBorderWidth: 2,
        pointHoverRadius: 4, hidden: S.hidden.has(s.key),
      });
    });
    chart = new Chart($("chart"), {
      type: "line",
      data: { datasets: ds },
      plugins: [stageLine, refLine],
      options: {
        animation: false, maintainAspectRatio: false, parsing: false, spanGaps: true,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { type: "linear", min: 0, max: S.n, title: { display: true, text: "Growth stage", color: ink3 },
               ticks: { color: ink3, stepSize: 10 }, grid: { color: grid } },
          y: { title: { display: !!(m.unit || dev), text: dev ? `Deviation from baseline${m.unit ? " (" + m.unit + ")" : ""}` : m.unit, color: ink3 },
               ticks: { color: ink3 }, grid: { color: grid } },
        },
        plugins: {
          legend: {
            position: "bottom",
            labels: {
              color: ink2, boxWidth: 26, boxHeight: 0, padding: 10,
              filter: (it) => !it.text.startsWith("_"),
              generateLabels: (c) => c.data.datasets.map((d, i) => ({
                text: d.label, datasetIndex: i, hidden: !c.isDatasetVisible(i), fontColor: ink2,
                strokeStyle: d.borderColor, fillStyle: "transparent", lineWidth: 3, lineDash: d.borderDash || [],
              })),
            },
            onClick: (e, item, legend) => {
              const d = legend.chart.data.datasets[item.datasetIndex];
              const vis = legend.chart.isDatasetVisible(item.datasetIndex);
              legend.chart.setDatasetVisibility(item.datasetIndex, !vis);
              if (d._key && d._key !== "random") vis ? S.hidden.add(d._key) : S.hidden.delete(d._key);
              legend.chart.update();
            },
          },
          tooltip: {
            filter: (it) => !it.dataset.label.startsWith("_"),
            callbacks: {
              title: (items) => `Stage ${items[0].parsed.x}`,
              label: (it) => ` ${it.dataset.label}: ${dev && it.parsed.y > 0 ? "+" : ""}${fmt(it.parsed.y, m.unit)}`,
            },
          },
        },
        onClick: (e, _els, c) => {
          const x = Math.round(c.scales.x.getValueForPixel(e.x));
          if (x >= 0 && x <= S.n) setStage(Math.max(x, 0));
        },
      },
    });
    const notes = [];
    if (m.note) notes.push(m.note);
    if (dev) notes.push(m.lowerBetter ? "Below zero = better than random growth." : "Above zero = better than random growth.");
    else if (m.lowerBetter) notes.push("Lower is better.");
    if (S.showRandom && m.random) notes.push(m.nRandom ? `Random baseline: mean of ${m.nRandom} random-order runs; shaded band = 5th–95th percentile.` : "Random baseline: mean of random-order runs.");
    notes.push("Click the chart to jump to a stage. Click legend entries to hide lines.");
    $("metricNote").textContent = notes.join(" ");
  }
  function updateChartStage() { if (chart) chart.update("none"); }

  // ── map legend ────────────────────────────────────────────────────────────
  function renderLegend() {
    const accent = css("--accent") || "#eb6834";
    const order = S.colorMode === "order";
    const mid = rampAt(0.35);
    const linkRows = `
      <div class="row"><span class="swatch dash" style="border-color:${order ? mid : C.abstract}"></span>Abstract link</div>
      <div class="row"><span class="swatch" style="border-color:${order ? mid : C.abstract}"></span>Routed link</div>`;
    const colourKey = order
      ? `<div class="row"><span class="ramp" style="background:linear-gradient(90deg,${BLUE_RAMP.join(",")})"></span></div>
         <div class="row" style="justify-content:space-between"><span>built first</span><span>built last</span></div>`
      : `<div class="row"><span class="swatch" style="border-color:${C.newInfra}"></span>New investment</div>
         <div class="row"><span class="swatch" style="border-color:${C.existing}"></span>Existing cycle infra reused</div>`;
    $("mapLegend").innerHTML = `${linkRows}${colourKey}
      <div class="row"><span class="swatch" style="border-color:${accent};border-top-width:5px"></span>Added at this stage</div>
      ${S.ghost ? `<div class="row"><span class="swatch" style="border-color:${C.ghost}"></span>Not yet built</div>` : ""}
      <div class="row"><span class="fillbox" style="border-color:${C.ltn};background:${C.ltn}22"></span>LTN neighbourhood</div>
      <div class="row"><span class="swatch" style="border-color:${C.existing};border-top-width:2px"></span>Existing cycle infrastructure</div>
      <div class="row"><span class="dot" style="background:${C.seedOn};border-color:${C.seedRing}"></span>Seed connected <span class="dot" style="background:${C.seedOff};border-color:${C.seedRing};margin-left:6px"></span>not yet</div>
      <div class="row"><span class="sq" style="background:${C.ltn};border-color:${C.ltn}"></span>LTN seed point</div>
      ${$("lyExits").checked ? `<div class="row"><span class="dot" style="width:8px;height:8px;border-width:1.5px;border-color:${C.ltn};background:${C.seedOff}"></span>LTN exit point (routes start here)</div>` : ""}`;
  }

  // ── stage control ─────────────────────────────────────────────────────────
  // URL hash keeps the current view, so a workshop view can be bookmarked / shared
  function writeHash() {
    const h = new URLSearchParams({ place: S.place, scenario: S.scenario, strategy: S.strategy, stage: S.stage, metric: S.metricId || "",
      colour: S.colorMode, vs: S.devMode ? 1 : 0, abstract: $("lyAbstract").checked ? 1 : 0, future: S.ghost ? 1 : 0 });
    if (document.documentElement.dataset.theme) h.set("theme", document.documentElement.dataset.theme);
    history.replaceState(null, "", "#" + h.toString());
  }
  function readHash() {
    const h = new URLSearchParams(location.hash.slice(1));
    if (h.get("theme")) document.documentElement.dataset.theme = h.get("theme");
    if (h.get("strategy")) S.strategy = h.get("strategy");
    if (h.get("stage")) S.stage = +h.get("stage");
    if (h.get("metric")) S.metricId = h.get("metric");
    if (h.get("vs") === "1") { S.devMode = true; document.querySelector('input[name="devMode"][value="dev"]').checked = true; }
    if (h.get("colour") === "order" || h.get("colour") === "invest") {
      S.colorMode = h.get("colour");
      const r = document.querySelector(`input[name="colorMode"][value="${S.colorMode}"]`);
      if (r) r.checked = true;
    }
    if (h.get("abstract")) { $("lyAbstract").checked = h.get("abstract") === "1"; $("lyAbstract").dispatchEvent(new Event("change")); }
    if (h.get("future") === "1") { $("lyFuture").checked = true; S.ghost = true; }
    return { place: h.get("place"), scenario: h.get("scenario") };
  }

  function applyTheme() {
    C = palette(); setRamp();
    setBasemap();
    layers.boundary.eachLayer((l) => l.setStyle(boundaryStyle()));
    buildContext();
    renderGrowth(true);
    renderLegend();
    buildChart();
    setStage(S.stage);
    $("theme").textContent = isDark() ? "Light mode" : "Dark mode";
  }

  function setStage(s) {
    S.stage = Math.min(Math.max(Math.round(s), 0), S.n);
    $("stage").value = S.stage;
    $("stageNum").textContent = S.stage;
    renderGrowth(false);
    if (S.stage > 0) renderTiles(); else renderTilesZero();
    updateChartStage();
    writeHash();
  }
  function renderTilesZero() {
    $("tiles").innerHTML = `<div class="tile" style="grid-column:1/-1"><div class="k">Stage 0</div>
      <div class="v">Nothing built yet</div><div class="s">${S.run.seeds.length} seed points to connect. Press play or drag the slider.</div></div>`;
  }
  function play() {
    if (S.playing) { stop(); return; }
    if (S.stage >= S.n) setStage(0);
    $("play").innerHTML = "&#10074;&#10074;"; $("play").setAttribute("aria-label", "Pause");
    const tick = () => {
      if (S.stage >= S.n) { stop(); return; }
      setStage(S.stage + 1);
      S.playing = setTimeout(tick, +$("speed").value);
    };
    S.playing = setTimeout(tick, 50);
  }
  function stop() {
    clearTimeout(S.playing); S.playing = null;
    $("play").innerHTML = "&#9654;"; $("play").setAttribute("aria-label", "Play");
  }

  // ── selection of place / scenario / strategy ──────────────────────────────
  async function selectPlace(key, scenario) {
    S.place = key;
    $("place").value = key;
    document.title = `Expanding Cycle Networks · ${placeInfo(key).label}`;
    await loadBoundary(key);
    const scs = placeInfo(key).scenarios;
    await selectScenario(scs.find((s) => s.key === scenario) ? scenario : scs[0].key);
  }
  async function selectScenario(key) {
    S.scenario = key;
    const sc = scenarioInfo(key);
    await Promise.all([need(sc.metrics), need(sc.context)]);
    buildContext();
    const sel = $("strategy");
    sel.innerHTML = "";
    sc.runs.forEach((r) => { const o = document.createElement("option"); o.value = r.key; o.textContent = strategyInfo(r.key).label; sel.appendChild(o); });
    if (!sc.runs.find((r) => r.key === S.strategy)) S.strategy = sc.runs[0].key;
    sel.value = S.strategy;
    populateMetrics();
    await selectStrategy(S.strategy);
  }
  async function selectStrategy(key) {
    S.strategy = key;
    const sc = scenarioInfo(S.scenario);
    await need(sc.runs.find((r) => r.key === key).file);
    S.run = WD.runs[`${scKey()}/${key}`];
    buildRun(S.run);
    renderGrowth(true);
    renderLegend();
    buildChart();
    setStage(S.stage);
    map.closePopup();
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  map.addLayer(layers.boundary); // city boundary is always shown
  const toggles = { lyRouted: "routed", lyAbstract: "abstract", lyLtn: "ltn", lyBike: "bike", lySeeds: "seeds",
                    lyExits: "exits" };
  Object.entries(toggles).forEach(([id, key]) => {
    const apply = () => ($(id).checked ? map.addLayer(layers[key]) : map.removeLayer(layers[key]));
    $(id).addEventListener("change", () => { apply(); if (key === "seeds") renderGrowth(true); if (key === "exits") renderLegend(); });
    apply();
  });
  $("lyFuture").addEventListener("change", (e) => { S.ghost = e.target.checked; renderGrowth(true); renderLegend(); writeHash(); });
  document.querySelectorAll('input[name="colorMode"]').forEach((r) => r.addEventListener("change", (e) => {
    S.colorMode = e.target.value; renderGrowth(true); renderLegend(); writeHash();
  }));
  $("collapseLayers").addEventListener("click", (e) => {
    const body = $("layersBody"), open = body.style.display !== "none";
    body.style.display = open ? "none" : ""; e.target.textContent = open ? "show" : "hide";
    e.target.setAttribute("aria-expanded", String(!open));
  });
  $("stage").addEventListener("input", (e) => { stop(); setStage(+e.target.value); });
  $("prev").addEventListener("click", () => { stop(); setStage(S.stage - 1); });
  $("next").addEventListener("click", () => { stop(); setStage(S.stage + 1); });
  $("play").addEventListener("click", play);
  $("metric").addEventListener("change", (e) => { S.metricId = e.target.value; buildChart(); setStage(S.stage); });
  document.querySelectorAll('input[name="devMode"]').forEach((r) => r.addEventListener("change", (e) => {
    S.devMode = e.target.value === "dev"; buildChart(); setStage(S.stage);
  }));
  $("showRandom").addEventListener("change", (e) => { S.showRandom = e.target.checked; buildChart(); setStage(S.stage); });
  $("strategy").addEventListener("change", (e) => { stop(); selectStrategy(e.target.value); });
  $("place").addEventListener("change", (e) => { stop(); selectPlace(e.target.value, S.scenario); });

  function setPanel(show) {
    $("layout").classList.toggle("nopanel", !show);
    $("togglePanel").textContent = show ? "Hide dashboard" : "Show dashboard";
    $("togglePanel").setAttribute("aria-pressed", String(show));
    setTimeout(() => { map.invalidateSize(); if (chart) chart.resize(); }, 50);
  }
  $("togglePanel").addEventListener("click", () => setPanel($("layout").classList.contains("nopanel")));

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("select, input[type=text]")) return;
    if (e.key === "ArrowRight") { stop(); setStage(S.stage + 1); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { stop(); setStage(S.stage - 1); e.preventDefault(); }
    else if (e.key === " " && !e.target.closest("button")) { play(); e.preventDefault(); }
    else if (e.key === "Home") { stop(); setStage(0); }
    else if (e.key === "End") { stop(); setStage(S.n); }
  });

  $("theme").addEventListener("click", () => {
    document.documentElement.dataset.theme = isDark() ? "light" : "dark";
    applyTheme();
  });

  // handle for console poking during the workshop / testing
  window.__growth = { S, selectRouted, selectAbstract, highlightStage, setStage };

  // ── boot ──────────────────────────────────────────────────────────────────
  M.places.forEach((p) => { const o = document.createElement("option"); o.value = p.key; o.textContent = p.label; $("place").appendChild(o); });
  S.metricId = "demand_met";
  document.documentElement.dataset.theme = "light"; // opens in light mode; the URL hash can override
  const start = readHash();
  C = palette(); setRamp();
  setBasemap();
  $("theme").textContent = isDark() ? "Light mode" : "Dark mode";
  const startPlace = placeInfo(start.place) ? start.place : M.places[0].key;
  selectPlace(startPlace, start.scenario).catch((err) => {
    $("tiles").innerHTML = `<div class="tile" style="grid-column:1/-1"><div class="k">Error</div><div class="s">${err.message}</div></div>`;
    console.error(err);
  });
})();
