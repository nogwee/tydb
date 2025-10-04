// public/js/timeseries.js
// 依存: window.uPlot（index.htmlでCDN読込済み）, value_reader.worker.js, #bottom-sheet系DOM

// ====== 設定（GRIDはあなたの格子に合わせて）======
const GRID = { minLon:90.0, maxLon:180.0, minLat:0.0, maxLat:60.0, dLon:0.25, dLat:0.25 };
const SCALE = { precip: 0.1 }; // mm/h
const BASE_URL = new URL('.', document.baseURI).href.replace(/\/$/, '');

// ====== 内部状態 ======
let worker;
let currentPlotPrecip = null;
let getTyphoonGeoJSON = null;  // () => FeatureCollection（選択中台風を返す getter）
let clickMarker = null;

// ====== ユーティリティ ======
function ensureClickMarker(map) {
  if (clickMarker) return clickMarker;
  const el = document.createElement('div');
  el.className = 'click-marker';
  clickMarker = new maplibregl.Marker({ element: el, anchor: 'center' });
  return clickMarker;
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

let currentPlotInfo = {
  xs: [],
  secToIdx: null,
  updateReadout: null,
};

function setPlotInfo(xs, updateReadout) {
  currentPlotInfo.xs = xs;
  currentPlotInfo.secToIdx = new Map();
  xs.forEach((sec, idx) => {
    if (sec != null) currentPlotInfo.secToIdx.set(sec, idx);
  });
  currentPlotInfo.updateReadout = updateReadout;
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

function setPlotCursorBySec(sec) {
  if (!currentPlotPrecip || sec == null) return false;
  let idx = currentPlotInfo.secToIdx?.get(sec);
  if (idx == null) idx = findClosestIdx(currentPlotInfo.xs, sec);
  if (idx == null) {
    currentPlotInfo.updateReadout?.(null, null);
    return false;
  }
  const xVal = currentPlotInfo.xs[idx];
  const ySeries = currentPlotPrecip.data?.[1];
  const yVal = Array.isArray(ySeries) ? ySeries[idx] : null;
  const left = currentPlotPrecip.valToPos(xVal, 'x');
  currentPlotPrecip.setCursor({ idx, left });
  const displaySec = currentPlotInfo.secToIdx?.has(sec) ? sec : xVal;
  currentPlotInfo.updateReadout?.(displaySec, yVal);
  return true;
}

function clearCurrentPlot() {
  if (currentPlotPrecip) {
    try { currentPlotPrecip.destroy(); } catch (e) { /* noop */ }
  }
  currentPlotPrecip = null;
  currentPlotInfo = { xs: [], secToIdx: null, updateReadout: null };
  const container = document.querySelector('#chart-precip');
  if (container) {
    container.innerHTML = '';
    container.classList.add('empty');
    container.setAttribute('data-placeholder', 'loading…');
  }
  const readoutEl = getReadoutElement('#chart-precip');
  if (readoutEl) readoutEl.textContent = '—';
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

function openSheet(title) {
  sheetTitle.textContent = title;
  sheet.classList.remove('hidden');
  // 小さなタイムアウトでtransitionを確実に
  requestAnimationFrame(() => sheet.classList.add('show'));
}
function closeSheet() {
  sheet.classList.remove('show');
  // 終了後に display:none（hidden）に戻す
  setTimeout(() => sheet.classList.add('hidden'), 250);
}
function setSheetMeta(text) {
  if (sheetMeta) sheetMeta.textContent = text;
}
sheetClose?.addEventListener('click', closeSheet);

// ====== uPlot描画 ======
function renderLine(containerSel, yLabel, xs, ys, existing) {
  const el = document.querySelector(containerSel);
  if (!el) return null;

  const data = [xs, ys];
  const readoutEl = getReadoutElement(containerSel);
  const unitMatch = typeof yLabel === 'string' ? yLabel.match(/\(([^)]+)\)$/) : null;
  const unitText = unitMatch ? unitMatch[1] : '';

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

  if (existing) {
    if (!(existing.ctx && existing.ctx.asBars)) {
      existing.destroy();
    } else {
      existing.setData(data);
      const container = document.querySelector('#chart-precip');
      if (container) container.classList.remove('empty');
      setPlotInfo(xs, updateReadout);
      updateReadout(null, null);
      return existing;
    }
  }

  const opts = {
    width: el.clientWidth,
    height: el.clientHeight,
    padding: [PLOT_PADDING_TOP, null, PLOT_PADDING_BOTTOM, null],
    scales: { x: { time: true } },
    cursor: {
      x: true,
      y: false,
    },
    axes: [
      {
        stroke: "#444",
        label: "UTC",
        font: AXIS_FONT,
        lineHeight: AXIS_LINE_HEIGHT,
        splits: (u, axisIdx, scaleMin, scaleMax) => computeUtcSplits(scaleMin, scaleMax),
        values: (u, splits) => formatUtcLabels(u, splits, Boolean(u?.ctx?.showEdges)),
      },
      { stroke: "#444", label: yLabel }
    ],
    series: [
      { label: "time" },
      {
        label: yLabel,
        // 棒グラフで表示
        stroke: '#1f77b4',
        width: 0,
        fill: 'rgba(31,119,180,0.55)',
        points: { show: false },
        spanGaps: true,
        paths: BAR_PATH || undefined,
      }
    ],
    hooks: {
      init: [u => {
        if (!u.ctx) u.ctx = {};
        u.ctx.showEdges = false;
        u.ctx.asBars = Boolean(BAR_PATH);
        setPlotInfo(xs, updateReadout);
        updateReadout(null, null);
      }],
      setData: [u => {
        const xsCurrent = Array.isArray(u.data?.[0]) ? u.data[0] : [];
        setPlotInfo(xsCurrent, updateReadout);
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
      }],
    },
  };
  return new uPlot(opts, data, el);
}

function resizePlots() {
  if (!currentPlotPrecip) return;
  const el = document.querySelector('#chart-precip');
  currentPlotPrecip.setSize({ width: el.clientWidth, height: el.clientHeight });
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
export function initTimeseries({ map, getTyphoonGeoJSON: getter }) {
  getTyphoonGeoJSON = getter;
  worker = new Worker('./js/value_reader.worker.js', { type: 'module' });

  // 地図クリック -> その地点の降水時系列
  map.on('click', async (e) => {
    const { lng, lat } = e.lngLat;

    // クリック目印の表示＆アニメ（波紋）
    const marker = ensureClickMarker(map);
    marker.setLngLat([lng, lat]).addTo(map);
    const el = marker.getElement();
    el.classList.add('ping');

    const ty = getTyphoonGeoJSON?.();
    if (!ty) { console.warn('[timeseries] typhoon geojson is null'); return; }

    const tw = getTyphoonTimeWindow(ty);
    if (!tw) { console.warn('[timeseries] time window not found in geojson'); return; }

    openSheet(`Timeseries @ ${lng.toFixed(3)}, ${lat.toFixed(3)}`);
    clearCurrentPlot();

    const container = document.querySelector('#chart-precip');

    if (!isInsideGrid(lng, lat)) {
      if (container) container.setAttribute('data-placeholder', 'この地点は対象範囲外です');
      setSheetMeta('この地点は対象範囲外です');
      return;
    }

    setSheetMeta('loading…');
    if (container) container.setAttribute('data-placeholder', 'loading…');
    await new Promise(requestAnimationFrame);

    const { x, y } = ll2px(lng, lat);
    const { nx, ny } = expectedSize();
    console.log('[timeseries] click px', { x, y, expected: { nx, ny } });

    const dates = hourlyRangeUTC(tw.start, tw.end);
    const stamps = dates.map(toStampUTC);

    try {
      let { values: vals, diag } = await askWorker('precip', stamps, x, y, SCALE.precip);
      if (diag) {
        console.log('[timeseries] first png diag:', diag);
        // UIにも簡易表示（必要なら消してください）
        if (diag.status !== 200) {
          setSheetMeta(`最初のPNGが取得できません: ${diag.status}\n${diag.firstUrl}`);
        } else {
          setSheetMeta(`first=${diag.firstUrl}\nimg=${diag.wh.w}x${diag.wh.h} px=(${diag.px.xOrig},${diag.px.yOrig})->(${diag.px.x},${diag.px.y}) u16=${diag.u16} val=${diag.val ?? 'NaN'}`);
        }
      }

      const xs = dates.map(d => Math.floor(d.getTime() / 1000)); // Unix秒
      const ys = vals.map(v => Number.isFinite(v) ? v : null);   // NaN→null

      console.log('[timeseries] total:', vals.length, 'finite:', ys.length);
      const nFinite = ys.filter(v=>v!=null).length;
      console.log('[timeseries] non-null points:', nFinite, 'range:', {
        min: (nFinite ? Math.min(...ys.filter(v=>v!=null)) : null),
        max: (nFinite ? Math.max(...ys.filter(v=>v!=null)) : null),
      });

   if (ys.length === 0) {
     // --- フォールバック：実在する時刻列（STATE.PRECIP_KEYS）で再試行 ---
     const K = (window.STATE && Array.isArray(window.STATE.PRECIP_KEYS)) ? window.STATE.PRECIP_KEYS : [];
     if (K.length) {
       console.log('[timeseries] fallback to STATE.PRECIP_KEYS', K.length);
       const ret = await askWorker('precip', K, x, y, SCALE.precip);
       const vals2 = ret.values;
       const dates2 = K.map(s => {
         const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z$/);
         return new Date(Date.UTC(m[1], m[2]-1, m[3], m[4], m[5]));
       });
       const xs2=[], ys2=[];
       for (let i=0; i<vals2.length; i++){
         const v = vals2[i];
         if (Number.isFinite(v)) {
           xs2.push(Math.floor(dates2[i].getTime()/1000));
           ys2.push(v);
         }
       }
       console.log('[timeseries] fallback finite:', ys2.length);
       if (ys2.length > 0) {
         currentPlotPrecip = renderLine('#chart-precip', 'Precip (mm/h)', xs2, ys2, currentPlotPrecip);
         setSheetMeta(`${K[0]} – ${K.at(-1)} (fallback)`);
         resizePlots();
         return;
       }
     }

      setSheetMeta('この期間の値が取得できません（ファイル未配置 / 404 / 地点がデータ域外 / NoData）。Consoleのログを確認してください。');
      const sample = stamps.filter((_,i)=>i%Math.ceil(stamps.length/3)===0).slice(0,3);
      for (const s of sample) {
        const u = `${BASE_URL}/value_png/precip/precip_${s}.png`;
       fetch(u, {cache:'no-cache'}).then(r=>console.log('[check]', s, r.status, u));
      }
      const container = document.querySelector('#chart-precip');
      if (container) {
        container.classList.add('empty');
        container.setAttribute('data-placeholder', 'データが取得できません');
      }
      return;
    }

    currentPlotPrecip = renderLine('#chart-precip', 'Precip (mm/h)', xs, ys, currentPlotPrecip);
    const container = document.querySelector('#chart-precip');
    if (container) container.classList.remove('empty');
    setSheetMeta(`${tw.start} – ${tw.end}`);
    resizePlots();
    } catch (err) {
      setSheetMeta('データ取得に失敗しました');
      // eslint-disable-next-line no-console
      console.error(err);
    }
  });

  return {
    // 台風選択が変わった時に呼ぶと、次回クリックから新しい期間が使われる
    setTyphoonGetter(fn) { getTyphoonGeoJSON = fn; },
    setActiveTime(sec) { return setPlotCursorBySec(sec); },
    destroy() {
      worker?.terminate();
      worker = null;
      currentPlotInfo = { xs: [], secToIdx: null, updateReadout: null };
    }
  };
}
