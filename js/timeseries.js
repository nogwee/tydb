// public/js/timeseries.js
// 依存: window.uPlot（index.htmlでCDN読込済み）, value_reader.worker.js, #bottom-sheet系DOM

// ====== 設定（GRIDはあなたの格子に合わせて）======
const GRID = { minLon:90.0, maxLon:180.0, minLat:0.0, maxLat:60.0, dLon:0.25, dLat:0.25 };
const SCALE = { precip: 0.1, gust: 0.1 }; // precip: mm/h, gust: m/s (0.1 scale)
const BASE_URL = new URL('.', document.baseURI).href.replace(/\/$/, '');

// ====== 内部状態 ======
let worker;
let mapRef = null;
let getTyphoonGeoJSON = null;  // () => FeatureCollection（選択中台風を返す getter）
let clickMarker = null;
let suppressCursorCallback = false;
let lastCursorSecEmitted = null;
let onTimeSelected = null;

const SERIES_CONFIG = {
  precip: {
    container: '#chart-precip',
    readout: '#chart-precip-readout',
    unit: 'mm/h',
    title: 'Precip (mm/h)',
    color: '#1f77b4',
    type: 'bar',
  },
  gust: {
    container: '#chart-gust',
    readout: '#chart-gust-readout',
    unit: 'm/s',
    title: 'Gust (m/s)',
    color: '#d2642a',
    type: 'line',
  }
};

const seriesState = {
  precip: { plot: null, xs: [], secToIdx: new Map(), updateReadout: null },
  gust:   { plot: null, xs: [], secToIdx: new Map(), updateReadout: null },
};

let activeLayer = null;
let currentActiveSec = null;
let lastClicked = null;

// ====== ユーティリティ ======
function ensureClickMarker(map) {
  if (clickMarker) return clickMarker;
  const el = document.createElement('div');
  el.className = 'click-marker';
  clickMarker = new maplibregl.Marker({ element: el, anchor: 'center' });
  return clickMarker;
}

function clearClickMarker() {
  if (!clickMarker) return;
  try { clickMarker.remove(); } catch (e) { /* noop */ }
  clickMarker = null;
}

function ll2px(lon, lat) {
  const col = Math.round((lon - GRID.minLon) / GRID.dLon);
  const row = Math.round((GRID.maxLat - lat) / GRID.dLat);
  // 画像外になってもworker側でクランプするが、ここでも軽く制限をかけておくと安心
  //（PNGの幅/高さが手元にないので、極端な外れだけ抑制）
  if (!Number.isFinite(col) || !Number.isFinite(row)) return { x: 0, y: 0 };
  return { x: col, y: row };
}

function isInsideGrid(lon, lat) {
  return lon >= GRID.minLon && lon <= GRID.maxLon && lat >= GRID.minLat && lat <= GRID.maxLat;
}

const SEC_MIN = 60;
const SEC_HOUR = 60 * SEC_MIN;
const SEC_DAY = 24 * SEC_HOUR;
const TARGET_TICKS = 8;
const AXIS_FONT = '10px "Inter", sans-serif';
const AXIS_LINE_HEIGHT = 0.92;
const PLOT_PADDING_TOP = 12;
const PLOT_PADDING_BOTTOM = 6;
const TICK_STEPS = [
  5 * SEC_MIN,
  10 * SEC_MIN,
  15 * SEC_MIN,
  30 * SEC_MIN,
  1 * SEC_HOUR,
  2 * SEC_HOUR,
  3 * SEC_HOUR,
  6 * SEC_HOUR,
  12 * SEC_HOUR,
  1 * SEC_DAY,
  2 * SEC_DAY,
  4 * SEC_DAY,
  7 * SEC_DAY,
];
const BAR_PATH = (typeof uPlot !== 'undefined' && uPlot?.paths?.bars)
  ? uPlot.paths.bars({ size: [SEC_HOUR, Infinity], align: -1 })
  : null;

function setPlotInfo(kind, xs, updateReadout) {
  const state = seriesState[kind];
  state.xs = xs;
  const map = new Map();
  xs.forEach((sec, idx) => {
    if (sec != null) map.set(sec, idx);
  });
  state.secToIdx = map;
  state.updateReadout = updateReadout;
}

function findClosestIdx(xs, targetSec) {
  if (!Array.isArray(xs) || xs.length === 0 || targetSec == null) return null;
  let lo = 0;
  let hi = xs.length - 1;
  if (targetSec <= xs[lo]) return lo;
  if (targetSec >= xs[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= targetSec) lo = mid; else hi = mid;
  }
  return (targetSec - xs[lo] <= xs[hi] - targetSec) ? lo : hi;
}

function setPlotCursor(kind, sec) {
  if (sec == null) return false;
  const state = seriesState[kind];
  const plot = state.plot;
  if (!plot) return false;
  let idx = state.secToIdx?.get(sec);
  if (idx == null) idx = findClosestIdx(state.xs, sec);
  if (idx == null) {
    state.updateReadout?.(null, null);
    return false;
  }
  const xVal = state.xs[idx];
  const ySeries = plot.data?.[1];
  const yVal = Array.isArray(ySeries) ? ySeries[idx] : null;
  const left = plot.valToPos(xVal, 'x');
  suppressCursorCallback = true;
  plot.setCursor({ idx, left });
  suppressCursorCallback = false;
  const displaySec = state.secToIdx?.has(sec) ? sec : xVal;
  state.updateReadout?.(displaySec, yVal);
  return true;
}

function markPlaceholder(kind, message) {
  const cfg = SERIES_CONFIG[kind];
  const container = document.querySelector(cfg.container);
  if (container) {
    container.classList.remove('loading');
    container.removeAttribute('data-overlay');
    container.innerHTML = '';
    container.classList.add('empty');
    container.setAttribute('data-placeholder', message);
  }
  const readoutEl = getReadoutElement(cfg.container);
  if (readoutEl) readoutEl.textContent = '—';
}

function setLoadingOverlay(kind, message = 'loading...') {
  const cfg = SERIES_CONFIG[kind];
  const container = document.querySelector(cfg.container);
  if (!container) return;
  container.classList.remove('empty');
  container.classList.add('loading');
  container.setAttribute('data-overlay', message);
  const readoutEl = getReadoutElement(cfg.container);
  if (readoutEl) readoutEl.textContent = '—';
}

function clearSeries(kind, placeholder = 'loading...') {
  const state = seriesState[kind];
  if (state.plot) {
    try { state.plot.destroy(); } catch (e) { /* noop */ }
  }
  state.plot = null;
  state.xs = [];
  state.secToIdx = new Map();
  state.updateReadout = null;
  markPlaceholder(kind, placeholder);
}

function clearAllCharts(placeholder = 'loading...') {
  Object.keys(SERIES_CONFIG).forEach(kind => clearSeries(kind, placeholder));
  updateChartVisibility();
}

const readoutCache = new Map();

function getReadoutElement(containerSel) {
  if (!containerSel) return null;
  if (readoutCache.has(containerSel)) return readoutCache.get(containerSel);
  const id = containerSel.startsWith('#') ? containerSel.slice(1) : containerSel;
  const el = document.getElementById(`${id}-readout`);
  readoutCache.set(containerSel, el || null);
  return el || null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatCursorTime(sec) {
  if (sec == null) return null;
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.valueOf())) return null;
  const yyyy = d.getUTCFullYear();
  const mm = pad2(d.getUTCMonth() + 1);
  const dd = pad2(d.getUTCDate());
  const hh = pad2(d.getUTCHours());
  const mi = pad2(d.getUTCMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}Z`;
}

function formatCursorValue(val) {
  if (val == null) return null;
  const num = Number(val);
  if (!Number.isFinite(num)) return null;
  const abs = Math.abs(num);
  const decimals = abs >= 10 ? 1 : 2;
  return num.toFixed(decimals);
}

function computeUtcSplits(scaleMin, scaleMax) {
  if (!Number.isFinite(scaleMin) || !Number.isFinite(scaleMax) || scaleMax <= scaleMin) {
    return [scaleMin || 0];
  }

  const range = scaleMax - scaleMin;
  let step = TICK_STEPS[TICK_STEPS.length - 1];
  for (const candidate of TICK_STEPS) {
    if (range / candidate <= TARGET_TICKS) {
      step = candidate;
      break;
    }
  }

  const splits = [];
  const first = Math.ceil(scaleMin / step) * step;
  for (let t = first; t <= scaleMax; t += step) {
    splits.push(t);
  }

  if (!splits.length) {
    splits.push(scaleMin, scaleMax);
  }

  // Include exact bounds soズーム極小時でも最低2本
  splits.push(scaleMin, scaleMax);

  // Inject any UTC midnight tick that falls inside the range
  let firstMidnight = Math.ceil(scaleMin / SEC_DAY) * SEC_DAY;
  if (Math.abs(scaleMin % SEC_DAY) < 1e-3) firstMidnight = scaleMin;
  for (let t = firstMidnight; t <= scaleMax; t += SEC_DAY) {
    splits.push(t);
  }

  const uniq = Array.from(new Set(splits.map(v => Math.round(v)))).sort((a, b) => a - b);
  return uniq.filter(v => v >= scaleMin - 1e-6 && v <= scaleMax + 1e-6);
}

function formatUtcLabels(u, splits, withEdge = false) {
  const dates = splits.map(sec => new Date(sec * 1000));
  return dates.map((d, i) => {
    if (!withEdge && (i === 0 || i === dates.length - 1)) return '';
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mi = String(d.getUTCMinutes()).padStart(2, '0');
    const timePart = `${hh}:${mi}`;

    const prev = dates[i - 1];
    const isNewDay = !prev ||
      prev.getUTCFullYear() !== d.getUTCFullYear() ||
      prev.getUTCMonth() !== d.getUTCMonth() ||
      prev.getUTCDate() !== d.getUTCDate();

    if (hh === '00' && mi === '00') {
      return `${timePart}\n${mm}/${dd}`;
    }

    if (isNewDay) {
      return `${timePart}\n${mm}/${dd}`;
    }

    return timePart;
  });
}

// Date(UTC) -> 'YYYYMMDDTHHMMZ'
function toStampUTC(date) {
  const y = String(date.getUTCFullYear()).padStart(4,'0');
  const m = String(date.getUTCMonth()+1).padStart(2,'0');
  const d = String(date.getUTCDate()).padStart(2,'0');
  const H = String(date.getUTCHours()).padStart(2,'0');
  const M = String(date.getUTCMinutes()).padStart(2,'0');
  return `${y}${m}${d}T${H}${M}Z`;
}
function toDateUTC(iso) { return new Date(iso); }

// [startISO, endISO] の毎時配列
function hourlyRangeUTC(startISO, endISO) {
  const out = [];
  let t = toDateUTC(startISO);
  const end = toDateUTC(endISO);
  t.setUTCMinutes(0,0,0);
  while (t <= end) {
    out.push(new Date(t));
    t = new Date(t.getTime() + 60*60*1000);
  }
  return out;
}

// 台風GeoJSONから time 範囲取得
function getTyphoonTimeWindow(tyFC) {
  const times = [];

  for (const f of tyFC.features || []) {
    // Point だけを対象（LineStringは無視）
    if (f.geometry?.type !== 'Point') continue;

    const p = f.properties || {};

    // 1) あなたのデータの主キー: "datetime(UTC)" → "YYYY-MM-DD HH:MM:SS"
    // 2) 想定される別名: time / valid_time / validTime / datetime / date
    let t =
      p['datetime(UTC)'] ??
      p.time ??
      p.valid_time ??
      p.validTime ??
      p.datetime ??
      p.date ??
      null;

    if (!t) continue;

    // "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DDTHH:MM:SSZ" にして UTC で読む
    if (typeof t === 'string' && t.includes(' ') && !t.endsWith('Z')) {
      t = t.replace(' ', 'T') + 'Z';
    }

    const d = new Date(t);
    if (!Number.isNaN(d.valueOf())) times.push(d.toISOString());
  }

  if (times.length === 0) return null;

  times.sort(); // ISO文字列なら辞書順でOK
  return { start: times[0], end: times.at(-1) };
}

// 画像サイズの理論値（GRIDから計算）
function expectedSize() {
  const nx = Math.round((GRID.maxLon - GRID.minLon) / GRID.dLon) + 1;
  const ny = Math.round((GRID.maxLat - GRID.minLat) / GRID.dLat) + 1;
  return { nx, ny };
}

// ====== ボトムシートUI ======
const sheet = document.getElementById('bottom-sheet');
const sheetTitle = document.getElementById('sheet-title');
const sheetMeta = document.getElementById('sheet-meta');
const sheetClose = document.getElementById('sheet-close');
const chartBlocks = {
  precip: document.getElementById('block-precip'),
  gust: document.getElementById('block-gust'),
};
const noneMessage = document.getElementById('chart-none-message');

function openSheet(title) {
  sheetTitle.textContent = title;
  sheet.classList.remove('hidden');
  // 小さなタイムアウトでtransitionを確実に
  requestAnimationFrame(() => sheet.classList.add('show'));
}
function closeSheet() {
  sheet.classList.remove('show');
  clearClickMarker();
  resetCharts();
  // 終了後に display:none（hidden）に戻す
  setTimeout(() => sheet.classList.add('hidden'), 250);
}
function setSheetMeta(text) {
  if (sheetMeta) sheetMeta.textContent = text;
}
sheetClose?.addEventListener('click', closeSheet);

function updateChartVisibility() {
  Object.entries(chartBlocks).forEach(([kind, block]) => {
    if (!block) return;
    block.style.display = (activeLayer === kind) ? 'block' : 'none';
  });
  if (noneMessage) noneMessage.style.display = activeLayer ? 'none' : 'block';
}

function applyActiveLayer(kind) {
  activeLayer = kind;
  updateChartVisibility();
  if (kind && currentActiveSec != null) setPlotCursor(kind, currentActiveSec);
  if (kind && lastClicked && !seriesState[kind].plot) {
    loadChartsForLocation(lastClicked.lng, lastClicked.lat, { showMarker: false, keepExisting: true, layers: [kind] });
  }
  if (kind) resizePlots();
}

updateChartVisibility();

async function loadChartsForLocation(lng, lat, { showMarker = true, keepExisting = false, layers = null } = {}) {
  if (!mapRef) return false;
  const ty = getTyphoonGeoJSON?.();
  if (!ty) {
    console.warn('[timeseries] typhoon geojson is null');
    return false;
  }

  const tw = getTyphoonTimeWindow(ty);
  if (!tw) {
    console.warn('[timeseries] time window not found in geojson');
    return false;
  }

  if (showMarker) {
    const marker = ensureClickMarker(mapRef);
    marker.setLngLat([lng, lat]).addTo(mapRef);
    marker.getElement().classList.add('ping');
  }

  openSheet(`Timeseries @ ${lng.toFixed(3)}, ${lat.toFixed(3)}`);

  const allKinds = Object.keys(SERIES_CONFIG);
  const fetchSet = new Set((layers ? layers : (activeLayer ? [activeLayer] : [])).filter(Boolean));

  if (!isInsideGrid(lng, lat)) {
    allKinds.forEach(kind => clearSeries(kind, 'この地点は対象範囲外です'));
    updateChartVisibility();
    setSheetMeta('この地点は対象範囲外です');
    lastClicked = { lng, lat };
    lastCursorSecEmitted = null;
    return false;
  }

  if (fetchSet.size === 0) {
    if (!keepExisting) {
      clearAllCharts('レイヤーを選択してください');
    }
    setSheetMeta('レイヤーを選択してください');
    lastClicked = { lng, lat };
    lastCursorSecEmitted = null;
    return false;
  }

  if (!keepExisting) {
    allKinds.forEach(kind => {
      if (fetchSet.has(kind)) {
        clearSeries(kind, 'loading...');
      } else {
        clearSeries(kind, 'レイヤーを選択してください');
      }
    });
  } else {
    fetchSet.forEach(kind => {
      const state = seriesState[kind];
      state.updateReadout?.(null, null);
      state.plot?.setCursor({ idx: null, left: null });
      setLoadingOverlay(kind);
    });
  }

  setSheetMeta('loading...');
  lastClicked = { lng, lat };
  lastCursorSecEmitted = null;

  await new Promise(requestAnimationFrame);

  const { x, y } = ll2px(lng, lat);
  const dates = hourlyRangeUTC(tw.start, tw.end);
  const stamps = dates.map(toStampUTC);
  const xsBase = dates.map(d => Math.floor(d.getTime() / 1000));

  const valuesToSeries = (vals) => vals.map(v => Number.isFinite(v) ? v : null);
  const hasData = (arr) => Array.isArray(arr) && arr.some(v => v != null);

  let precipXs = xsBase;
  let precipYs = [];
  let precipHasData = false;
  let precipLabel = `${tw.start} – ${tw.end}`;

  let gustYs = [];
  let gustHasData = false;

  try {
    if (fetchSet.has('precip')) {
      const { values: precipVals } = await askWorker('precip', stamps, x, y, SCALE.precip);
      precipYs = valuesToSeries(precipVals);
      precipHasData = hasData(precipYs);

      if (!precipHasData) {
        const keys = (window.STATE && Array.isArray(window.STATE.PRECIP_KEYS)) ? window.STATE.PRECIP_KEYS : [];
        if (keys.length) {
          const fallbackRes = await askWorker('precip', keys, x, y, SCALE.precip);
          const fallbackVals = fallbackRes.values || [];
          const fallbackXs = [];
          const fallbackYs = [];
          keys.forEach((s, idx) => {
            const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/);
            if (!m) return;
            const sec = Math.floor(Date.UTC(m[1], m[2]-1, m[3], m[4], m[5]) / 1000);
            const raw = fallbackVals[idx];
            fallbackXs.push(sec);
            fallbackYs.push(Number.isFinite(raw) ? raw : null);
          });
          if (hasData(fallbackYs)) {
            precipYs = fallbackYs;
            precipXs = fallbackXs;
            precipHasData = true;
            precipLabel = `${keys[0]} – ${keys.at(-1)} (fallback)`;
          }
        }
      }

      if (precipHasData) {
        renderSeries('precip', precipXs, precipYs);
      } else {
        markPlaceholder('precip', 'データが取得できません');
      }
    } else if (!keepExisting) {
      markPlaceholder('precip', 'レイヤーを選択してください');
    }

    if (fetchSet.has('gust')) {
      try {
        const { values: gustVals } = await askWorker('gust', stamps, x, y, SCALE.gust);
        gustYs = valuesToSeries(gustVals);
        gustHasData = hasData(gustYs);
        if (gustHasData) {
          renderSeries('gust', xsBase, gustYs);
        } else {
          markPlaceholder('gust', 'データが取得できません');
        }
      } catch (gustErr) {
        console.error('[timeseries] gust fetch failed', gustErr);
        markPlaceholder('gust', 'データが取得できません');
      }
    } else if (!keepExisting) {
      markPlaceholder('gust', 'レイヤーを選択してください');
    }

    if ((fetchSet.has('precip') && precipHasData) || (fetchSet.has('gust') && gustHasData)) {
      setSheetMeta(precipLabel);
    } else if (fetchSet.size) {
      setSheetMeta('この期間の値が取得できません');
    }

    resizePlots();
    if (currentActiveSec != null) {
      allKinds.forEach(kind => setPlotCursor(kind, currentActiveSec));
    } else if (precipHasData && precipXs.length) {
      currentActiveSec = precipXs[0];
      allKinds.forEach(kind => setPlotCursor(kind, currentActiveSec));
    }

    updateChartVisibility();
    return (fetchSet.has('precip') && precipHasData) || (fetchSet.has('gust') && gustHasData);
  } catch (err) {
    setSheetMeta('データ取得に失敗しました');
    console.error(err);
    if (fetchSet.has('precip')) markPlaceholder('precip', 'データが取得できません');
    if (fetchSet.has('gust')) markPlaceholder('gust', 'データが取得できません');
    updateChartVisibility();
    return false;
  }
}

// ====== uPlot描画 ======
function renderSeries(kind, xs, ys) {
  const cfg = SERIES_CONFIG[kind];
  const container = document.querySelector(cfg.container);
  if (!container) return null;

  container.classList.remove('empty');
  container.classList.remove('loading');
  container.removeAttribute('data-overlay');

  const data = [xs, ys];
  const readoutEl = getReadoutElement(cfg.container);
  const unitText = cfg.unit || '';
  const axisLabel = cfg.title || (unitText ? `Value (${unitText})` : 'Value');

  const updateReadout = (sec, val) => {
    if (!readoutEl) return;
    if (sec == null) {
      readoutEl.textContent = '—';
      return;
    }
    const timeText = formatCursorTime(sec) || '—';
    const valueTextRaw = formatCursorValue(val);
    const valueText = valueTextRaw ? (unitText ? `${valueTextRaw} ${unitText}` : valueTextRaw) : '—';
    readoutEl.textContent = `${timeText} · ${valueText}`;
  };

  const state = seriesState[kind];
  const existing = state.plot;

  if (existing) {
    existing.setData(data);
    container.classList.remove('empty');
    setPlotInfo(kind, xs, updateReadout);
    state.updateReadout = updateReadout;
    updateReadout(null, null);
    return existing;
  }

  const el = container;
  const isBar = cfg.type === 'bar';

  const seriesOpts = {
    label: axisLabel,
    stroke: cfg.color,
    spanGaps: true,
  };

  if (isBar) {
    seriesOpts.width = 0;
    seriesOpts.fill = 'rgba(31,119,180,0.55)';
    seriesOpts.points = { show: false };
    seriesOpts.paths = BAR_PATH || undefined;
  } else {
    seriesOpts.width = 2;
    seriesOpts.fill = 'rgba(210,100,42,0.10)';
    seriesOpts.points = { show: true, size: 3 };
  }

  const opts = {
    width: el.clientWidth,
    height: el.clientHeight,
    padding: [PLOT_PADDING_TOP, null, PLOT_PADDING_BOTTOM, null],
    scales: { x: { time: true } },
    cursor: { x: true, y: false },
    axes: [
      {
        stroke: '#444',
        label: 'UTC',
        font: AXIS_FONT,
        lineHeight: AXIS_LINE_HEIGHT,
        splits: (u, axisIdx, scaleMin, scaleMax) => computeUtcSplits(scaleMin, scaleMax),
        values: (u, splits) => formatUtcLabels(u, splits, Boolean(u?.ctx?.showEdges)),
      },
      { stroke: '#444', label: axisLabel }
    ],
    series: [
      { label: 'time' },
      seriesOpts,
    ],
    hooks: {
      init: [u => {
        if (!u.ctx) u.ctx = {};
        u.ctx.showEdges = false;
        u.ctx.asBars = isBar;
        state.plot = u;
        setPlotInfo(kind, xs, updateReadout);
        state.updateReadout = updateReadout;
        container.classList.remove('empty');
        updateReadout(null, null);
      }],
      setData: [u => {
        const xsCurrent = Array.isArray(u.data?.[0]) ? u.data[0] : [];
        setPlotInfo(kind, xsCurrent, updateReadout);
        state.updateReadout = updateReadout;
        updateReadout(null, null);
      }],
      setCursor: [u => {
        const { left, top, idx } = u.cursor;
        if (left == null || top == null || left < 0 || top < 0 || idx == null || idx < 0) {
          updateReadout(null, null);
          return;
        }
        const xsData = u.data?.[0];
        const ysData = u.data?.[1];
        if (!Array.isArray(xsData) || idx >= xsData.length) {
          updateReadout(null, null);
          return;
        }
        const sec = xsData[idx];
        const val = Array.isArray(ysData) ? ysData[idx] : null;
        updateReadout(sec, val);
        if (!suppressCursorCallback && onTimeSelected && typeof sec === 'number') {
          if (lastCursorSecEmitted !== sec) {
            lastCursorSecEmitted = sec;
            onTimeSelected(sec);
          }
        }
      }],
    },
  };

  const plot = new uPlot(opts, data, el);
  state.plot = plot;
  return plot;
}

function resizePlots() {
  Object.entries(SERIES_CONFIG).forEach(([kind, cfg]) => {
    const plot = seriesState[kind].plot;
    if (!plot) return;
    const el = document.querySelector(cfg.container);
    if (!el) return;
    plot.setSize({ width: el.clientWidth, height: el.clientHeight });
  });
}
window.addEventListener('resize', () => { if (sheet.classList.contains('show')) resizePlots(); });

// ====== Worker呼び出し ======
function askWorker(kind, stamps, x, y, scale) {
  return new Promise((resolve, reject) => {
    const onmsg = (ev) => {
      worker.removeEventListener('message', onmsg);
      ev.data.ok ? resolve(ev.data) : reject(ev.data.error);
    };
    worker.addEventListener('message', onmsg);
    worker.postMessage({ kind, scale, stamps, x, y, baseUrl: BASE_URL });
  });
}

// ====== 外部公開API ======
export function initTimeseries({ map, getTyphoonGeoJSON: getter, onTimeSelect } = {}) {
  mapRef = map;
  getTyphoonGeoJSON = getter;
  onTimeSelected = typeof onTimeSelect === 'function' ? onTimeSelect : null;
  lastCursorSecEmitted = null;
  worker = new Worker('./js/value_reader.worker.js', { type: 'module' });

  // 地図クリック -> その地点の時系列
  map.on('click', (e) => {
    loadChartsForLocation(e.lngLat.lng, e.lngLat.lat, { showMarker: true, keepExisting: false });
  });

  resetCharts();

  return {
    // 台風選択が変わった時に呼ぶと、次回クリックから新しい期間が使われる
    setTyphoonGetter(fn) { getTyphoonGeoJSON = fn; },
    setActiveTime(sec) {
      currentActiveSec = sec;
      Object.keys(SERIES_CONFIG).forEach(kind => setPlotCursor(kind, sec));
      return true;
    },
    refresh() {
      if (lastClicked) {
        return loadChartsForLocation(lastClicked.lng, lastClicked.lat, { showMarker: false, keepExisting: true });
      }
      resetCharts();
      return false;
    },
    reset() { resetCharts(); },
    setActiveLayer(kind) { applyActiveLayer(kind); },
    destroy() {
      worker?.terminate();
      worker = null;
      mapRef = null;
      lastClicked = null;
      currentActiveSec = null;
      onTimeSelected = null;
      suppressCursorCallback = false;
      lastCursorSecEmitted = null;
      clearAllCharts('レイヤーを選択してください');
    }
  };
}
function resetCharts() {
  clearAllCharts('地点をクリックしてください');
  currentActiveSec = null;
  setSheetMeta('地点をクリックしてください');
  lastClicked = null;
  lastCursorSecEmitted = null;
}
