// ===== DOM =====
const slider = document.getElementById('time');
const label  = document.getElementById('label');
const selYear= document.getElementById('sel-year');
const selTy  = document.getElementById('sel-typhoon');
const chkPre = document.getElementById('chk-precip');
const chkWin = document.getElementById('chk-wind');
const chkTrackLine = document.getElementById('chk-trackline');
const chkActive = document.getElementById('chk-active');
const WIKI_ANCHOR = document.getElementById('wiki-link');

// ===== 雨量PNG設定 =====
const GRID = { minLon:110.0, maxLon:160.0, minLat:10.0, maxLat:50.0, dLon:0.25, dLat:0.25 };
const BOUNDS = [
  [GRID.minLon - GRID.dLon/2, GRID.maxLat + GRID.dLat/2],
  [GRID.maxLon + GRID.dLon/2, GRID.maxLat + GRID.dLat/2],
  [GRID.maxLon + GRID.dLon/2, GRID.minLat - GRID.dLat/2],
  [GRID.minLon - GRID.dLon/2, GRID.minLat - GRID.dLat/2],
];
const PRECIP_PNG = (key) => `./overlays/precip_${key}.png`;
const INITIAL_PRECIP_KEY = "20180903T0000Z";

let PRECIP_KEYS = [];
let TIME_TEXTS  = [];

// ===== 地図 =====
const map = new maplibregl.Map({
  container: 'map',
  style: {
    version: 8,
    sources: {
      basemap: {
        type:'raster',
        tiles:['https://cartodb-basemaps-a.global.ssl.fastly.net/light_all/{z}/{x}/{y}.png'],
        tileSize:256
      },
      track:   { type:'geojson', data:{ "type":"FeatureCollection","features":[] } },
      windsrc: { type:'geojson', data:{ "type":"FeatureCollection","features":[] } },
    },
    layers: [
      { id:'basemap', type:'raster', source:'basemap' },
      { id:'track-line', type:'line', source:'track',
        filter: ['==', ['geometry-type'], 'LineString'],
        paint:{ 'line-color':'#333','line-width':2 },
        layout:{ visibility:'visible' } },
      { id:'track-points', type:'circle', source:'track',
        filter:['==', ['geometry-type'], 'Point'],
        paint:{ 'circle-radius':4, 'circle-color':'#666' },
        layout:{ visibility:'visible' } },
      { id:'wind', type:'circle', source:'windsrc',
        layout:{ visibility:'none' },
        paint:{ 'circle-radius':3, 'circle-color':'#2b8a3e' } }
    ]
  },
  center:[139.7,35.6], zoom:3
});

// === 1h 内挿ユーティリティ ===
const HOUR = 3600000;
const wrapLon = lon => ((lon + 180) % 360) - 180;
const diffHours = (t1, t0) => (t1 - t0) / HOUR;

function lerpPos(A, B, f){
  let lon1 = B.lon;
  const dlon = lon1 - A.lon;
  if (dlon > 180) lon1 -= 360;
  if (dlon < -180) lon1 += 360;
  const lat = A.lat + (B.lat - A.lat) * f;
  const lon = wrapLon(A.lon + (lon1 - A.lon) * f);
  return { lat, lon };
}
function toDateAny(v){
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v < 1e12 ? v*1000 : v);
  return new Date(v);
}
function buildHourlyTimeline(startTime, endTime){
  const out = [];
  const t0 = new Date(Math.ceil(startTime.getTime()/HOUR)*HOUR);
  for (let t=t0.getTime(); t<=endTime.getTime(); t+=HOUR) out.push(new Date(t));
  return out;
}
function findBracket(arr, t){
  let lo = 0, hi = arr.length-1;
  if (t <= arr[0].time) return {i0:0,i1:0};
  if (t >= arr[hi].time) return {i0:hi,i1:hi};
  while (hi-lo>1){
    const mid=(lo+hi)>>1;
    (arr[mid].time <= t ? lo=mid : hi=mid);
  }
  return {i0:lo,i1:hi};
}
function interpolateAt(trackPts, t, {maxGapHours=6}={}){
  if (t <= trackPts[0].time) return { time:t, lat:trackPts[0].lat, lon:trackPts[0].lon };
  if (t >= trackPts[trackPts.length-1].time) {
    const L = trackPts[trackPts.length-1];
    return { time:t, lat:L.lat, lon:L.lon };
  }
  const {i0,i1} = findBracket(trackPts, t);
  const A = trackPts[i0], B = trackPts[i1];
  const gap = diffHours(B.time, A.time);
  if (gap <= 0 || gap > maxGapHours) return null;
  const f = diffHours(t, A.time) / gap;
  const {lat,lon} = lerpPos(A,B,f);
  return { time:t, lat, lon };
}
function dateToKeyUTC(d){
  const pad = n => String(n).padStart(2,'0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth()+1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
}

// ===== active 用レイヤ =====
function ensureActiveLayers(initial) {
  const srcId = 'active';
  if (!map.getSource(srcId)) {
    map.addSource(srcId, {
      type: 'geojson',
      data: {
        type:'FeatureCollection',
        features:[{ type:'Feature', properties:{}, geometry:{ type:'Point', coordinates:[initial.lon, initial.lat] } }]
      }
    });
    map.addLayer({
      id:'active-point',
      type:'circle',
      source:srcId,
      paint:{ 'circle-radius': 4, 'circle-color': '#d22','circle-stroke-color':'#fff','circle-stroke-width':1 }
    });
    map.addLayer({
      id:'active-pulse',
      type:'circle',
      source:srcId,
      paint:{ 'circle-radius': 12, 'circle-color': '#ff2d2d', 'circle-opacity': 0.25, 'circle-blur': 0.4 }
    });
  }
}
function setActivePosition(lat, lon){
  const src = map.getSource('active'); if (!src) return;
  src.setData({ type:'FeatureCollection', features:[{ type:'Feature', properties:{}, geometry:{ type:'Point', coordinates:[lon, lat] } }] });
}

// ===== 可視制御ユーティリティ =====
function setLayerVisibility(id, on){ if (map.getLayer(id)) map.setLayoutProperty(id,'visibility', on?'visible':'none'); }
function setLayersVisibility(ids, on){ ids.forEach(id=>setLayerVisibility(id,on)); }
function bindToggle(chkEl, id){ const apply=()=>setLayerVisibility(id, chkEl.checked); chkEl.addEventListener('change', apply); map.on('load', apply); }
function bindToggleMulti(chkEl, ids){ const apply=()=>setLayersVisibility(ids, chkEl.checked); chkEl.addEventListener('change', apply); map.on('load', apply); }

// ===== アクティブ時刻更新 =====
function setActiveTime(t) {
  const p = window.__hourlyPoints?.[t];
  if (!p) return;
  label.textContent = TIME_TEXTS[t] || `t=${t}`;
  setActivePosition(p.lat, p.lon);
  const key = PRECIP_KEYS[t];
  if (key) setPrecipTime(key);
}

// ===== 台風トラック読込 & スライダー設定 =====
async function loadTrack(geojsonUrl) {
  const res = await fetch(geojsonUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error('GeoJSON 読込失敗: ' + res.status + ' (' + geojsonUrl + ')');
  const geo = await res.json();
  map.getSource('track').setData(geo);

  const rawPoints = geo.features
    .filter(f => f.geometry?.type === 'Point')
    .map(f => {
      const p = f.properties || {};
      const dtStr = p["datetime(UTC)"];
      const time = (dtStr != null) ? toDateAny(dtStr.replace(' ', 'T')) : null;
      const [lon, lat] = f.geometry.coordinates;
      return { time, lat:+lat, lon:+lon };
    })
    .filter(d => d.time instanceof Date && !isNaN(d.time))
    .sort((a,b)=>a.time-b.time);

  if (!rawPoints.length) throw new Error('Point（観測点）が見つかりません: ' + geojsonUrl);

  const hourlyTimes  = buildHourlyTimeline(rawPoints[0].time, rawPoints[rawPoints.length-1].time);
  const hourlyPoints = [];
  for (const t of hourlyTimes){
    const p = interpolateAt(rawPoints, t, {maxGapHours: 9});
    if (p) hourlyPoints.push(p);
  }

  PRECIP_KEYS = hourlyPoints.map(p => dateToKeyUTC(p.time));
  TIME_TEXTS  = hourlyPoints.map(p => p.time.toISOString().replace('.000',''));

  slider.min = '0';
  slider.max = String(hourlyPoints.length - 1);
  slider.step = '1';
  slider.value = '0';

  ensureActiveLayers(hourlyPoints[0]);
  setActivePosition(hourlyPoints[0].lat, hourlyPoints[0].lon);

  window.__hourlyPoints = hourlyPoints;
  setActiveTime(0);
}

// ===== 雨量PNG =====
function addOrUpdatePrecip(key = INITIAL_PRECIP_KEY) {
  const srcId = 'precip-img';
  const url = PRECIP_PNG(key);
  if (!map.getSource(srcId)) {
    map.addSource(srcId, { type:'image', url, coordinates: BOUNDS });
    map.addLayer({
      id: srcId, type:'raster', source: srcId,
      layout: { visibility: chkPre.checked ? 'visible' : 'none' },
      paint: { 'raster-opacity': 0.6, 'raster-resampling': 'nearest' }
    });
  } else {
    map.getSource(srcId).updateImage({ url, coordinates: BOUNDS });
  }
}
function setPrecipTime(key) {
  const src = map.getSource('precip-img'); if (!src) return;
  src.updateImage({ url: PRECIP_PNG(key) });
}

// ===== 波紋アニメーション =====
let _pulseRAF = null, _pulseRunning = false;
const PULSE_PERIOD = 1200, PULSE_MIN_R = 10, PULSE_MAX_R = 20;
function _pulseStep() {
  if (!_pulseRunning) return;
  const t = (performance.now() % PULSE_PERIOD) / PULSE_PERIOD;
  let radius, opacity;
  if (t < 0.9) { radius = PULSE_MIN_R + (PULSE_MAX_R - PULSE_MIN_R) * t; opacity = 0.35 * (1 - t); }
  else { radius = PULSE_MIN_R; opacity = 0; }
  if (map.getLayer('active-pulse')) {
    map.setPaintProperty('active-pulse','circle-radius', radius);
    map.setPaintProperty('active-pulse','circle-opacity', opacity);
  }
  _pulseRAF = requestAnimationFrame(_pulseStep);
}
function startPulse(){ if (_pulseRunning) return; _pulseRunning = true; _pulseRAF = requestAnimationFrame(_pulseStep); }
function stopPulse(){ _pulseRunning = false; if (_pulseRAF) cancelAnimationFrame(_pulseRAF); _pulseRAF = null; }

// ===== ここから: 台風マニフェスト読み込み（二段階セレクト） =====
/*
 typhoons.json 期待構造（例）:
 {
   "groups":[
     {"label":"2018","items":[{"id":"TY2018_21_JEBI","name":"Jebi 2018","geojson":"../data/bst_geojson/TY2018_21_JEBI.geojson","wiki":"..."}]},
     {"label":"2019","items":[{"id":"TY2019_19_HAGIBIS","name":"Hagibis 2019","geojson":"../data/bst_geojson/TY2019_19_HAGIBIS.geojson","wiki":"..."}]}
   ],
   "defaultId":"TY2018_21_JEBI"
 }
*/
let TYPHOON_INDEX = null;           // 生データ
let TYPHOON_BY_YEAR = new Map();    // yearLabel -> items[]
let TYPHOON_MAP = new Map();        // id -> item

function resolveGeojsonPath(selectValue) {
  if (!selectValue) return null;
  let v = String(selectValue).trim();
  if (!v) return null;
  const hasExt  = /\.geojson$/i.test(v);
  const hasPath = v.includes('/');
  if (!hasPath) {
    if (!hasExt) v = `${v}.geojson`;
    return `../data/${v}`;
  }
  return hasExt ? v : `${v}.geojson`;
}

/** 年セレクトを構築（降順表示） */
function populateYearSelect() {
  while (selYear.firstChild) selYear.removeChild(selYear.firstChild);
  const years = Array.from(TYPHOON_BY_YEAR.keys())
    .sort((a,b)=> String(b).localeCompare(String(a), 'ja')); // 降順
  years.forEach(y => {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    selYear.appendChild(opt);
  });
}

/** 台風セレクトを選択年で構築 */
function populateTyphoonSelect(yearLabel) {
  while (selTy.firstChild) selTy.removeChild(selTy.firstChild);
  const items = TYPHOON_BY_YEAR.get(yearLabel) || [];
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = item.id; opt.textContent = item.name || item.id;
    selTy.appendChild(opt);
  });
}

/** Wikiリンク更新 */
function updateWikiLink(meta) {
  if (!WIKI_ANCHOR) return;
  if (meta?.wiki) {
    WIKI_ANCHOR.href = meta.wiki;
    WIKI_ANCHOR.style.pointerEvents = '';
    WIKI_ANCHOR.style.opacity = '';
  } else {
    WIKI_ANCHOR.removeAttribute('href');
    WIKI_ANCHOR.style.pointerEvents = 'none';
    WIKI_ANCHOR.style.opacity = '0.5';
  }
}

/** id を選択・読み込み */
function applyTyphoonSelection(id) {
  const meta = TYPHOON_MAP.get(id);
  const path = meta?.geojson || resolveGeojsonPath(id);
  if (path) {
    loadTrack(path).catch(err => {
      console.error(err); alert('トラック読み込みエラー: ' + err.message);
    });
  }
  updateWikiLink(meta);
  try { history.replaceState(null, '', `#${encodeURIComponent(id)}`); } catch {}
}

/** 一覧のロードと二段階セレクト初期化 */
async function loadTyphoonList(manifestUrl = './data/typhoons.json') {
  const res = await fetch(manifestUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`一覧の読み込みに失敗: ${res.status}`);
  const data = await res.json();
  TYPHOON_INDEX = data;

  // マップを構築
  TYPHOON_BY_YEAR.clear();
  TYPHOON_MAP.clear();

  const groups = Array.isArray(data.groups) ? data.groups : [];
  for (const g of groups) {
    const yearLabel = g.label ?? 'Unknown';
    const items = Array.isArray(g.items) ? g.items : [];
    TYPHOON_BY_YEAR.set(yearLabel, items);
    items.forEach(it => TYPHOON_MAP.set(it.id, it));
  }

  populateYearSelect();

  // 初期選択: ハッシュID > defaultId > 最初の年の最初の台風
  const hashId = location.hash?.replace(/^#/, '');
  let initialId = null, initialYear = null;

  if (hashId && TYPHOON_MAP.has(hashId)) {
    initialId = hashId;
    // 所属年を探す
    for (const [y, items] of TYPHOON_BY_YEAR.entries()) {
      if (items.some(it => it.id === hashId)) { initialYear = y; break; }
    }
  } else if (data.defaultId && TYPHOON_MAP.has(data.defaultId)) {
    initialId = data.defaultId;
    for (const [y, items] of TYPHOON_BY_YEAR.entries()) {
      if (items.some(it => it.id === initialId)) { initialYear = y; break; }
    }
  } else {
    const years = Array.from(TYPHOON_BY_YEAR.keys()).sort((a,b)=> String(b).localeCompare(String(a),'ja'));
    if (years.length) {
      initialYear = years[0];
      const first = (TYPHOON_BY_YEAR.get(initialYear) || [])[0];
      if (first) initialId = first.id;
    }
  }

  // セレクト反映
  if (initialYear) selYear.value = initialYear;
  populateTyphoonSelect(selYear.value);
  if (initialId) selTy.value = initialId;

  if (initialId) applyTyphoonSelection(initialId);
}

// ===== イベント =====
slider.addEventListener('input', (e) => setActiveTime(Number(e.target.value)));
selYear.addEventListener('change', () => {
  populateTyphoonSelect(selYear.value);
  const id = selTy.options[0]?.value;
  if (id) {
    selTy.value = id;
    applyTyphoonSelection(id);
  } else {
    // 台風なし：トラックを空に
    map.getSource('track')?.setData({ type:'FeatureCollection', features:[] });
    updateWikiLink(null);
  }
});
selTy.addEventListener('change', () => {
  const id = selTy.value;
  if (id) applyTyphoonSelection(id);
});

bindToggle(chkPre,  'precip-img');
bindToggle(chkWin,  'wind');
bindToggleMulti(chkTrackLine, ['track-line','track-points']);

(function bindActive() {
  const apply = () => {
    const on = chkActive.checked;
    setLayersVisibility(['active-point','active-pulse'], on);
    if (on) startPulse(); else stopPulse();
  };
  chkActive.addEventListener('change', apply);
  map.on('load', apply);
})();

// ===== 初期ロード =====
map.on('load', () => {
  // 一覧を読んでから各UI初期化
  loadTyphoonList('./data/typhoons.json').then(() => {
    try {
      addOrUpdatePrecip(INITIAL_PRECIP_KEY);
      setLayerVisibility('precip-img', chkPre.checked);
    } catch (e) { console.warn('precip PNG 初期化失敗:', e); }
    ['track-line','track-points','active-point','active-pulse'].forEach(id => {
      if (map.getLayer(id)) map.moveLayer(id);
    });
  }).catch(err => {
    console.error(err);
    alert('台風一覧の読み込みに失敗しました。');
  });
});

// ===== サイドバー =====
const sidebar = document.getElementById('sidebar');
const toggleBtn = document.getElementById('sidebar-toggle');
toggleBtn.addEventListener('click', () => {
  const collapsed = sidebar.classList.toggle('collapsed');
  toggleBtn.textContent = collapsed ? '≫' : '≪';
  toggleBtn.setAttribute('aria-expanded', String(!collapsed));
});
sidebar.addEventListener('transitionend', (e) => {
  if (e.propertyName === 'width') map.resize();
});

// ===== スライダー ±1時間ボタン（自動生成＆キーボード対応） =====
(function addHourStepButtons(){
  let btnPrev = document.getElementById('btn-prev');
  let btnNext = document.getElementById('btn-next');

  function makeBtn(id, text, title){
    const b = document.createElement('button');
    b.id = id; b.type = 'button';
    b.textContent = text; b.title = title;
    b.style.margin = '0 6px'; b.style.padding = '2px 8px'; b.style.cursor = 'pointer';
    return b;
  }

  if (!btnPrev || !btnNext) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex'; wrap.style.alignItems = 'center'; wrap.style.gap = '6px';

    const parent = slider.parentElement || document.body;
    parent.insertBefore(wrap, slider);

    btnPrev = btnPrev || makeBtn('btn-prev', '−1h', '1時間戻る');
    btnNext = btnNext || makeBtn('btn-next', '+1h', '1時間進む');

    wrap.appendChild(btnPrev);
    wrap.appendChild(slider);
    wrap.appendChild(btnNext);
  }

  const getIdx  = () => (Number(slider.value) | 0);
  const maxIdx  = () => (Number(slider.max)   | 0);
  const setIdx  = (i) => {
    const clamped = Math.max(0, Math.min(i, maxIdx()));
    slider.value = String(clamped);
    setActiveTime(clamped);
    updateButtonsDisabled();
  };

  function updateButtonsDisabled(){
    const i = getIdx(), m = maxIdx();
    btnPrev.disabled = (i <= 0);
    btnNext.disabled = (i >= m);
  }

  btnPrev.addEventListener('click', () => setIdx(getIdx() - 1));
  btnNext.addEventListener('click', () => setIdx(getIdx() + 1));
  slider.addEventListener('input', updateButtonsDisabled);

  document.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); btnPrev.click(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); btnNext.click(); }
  });

  setTimeout(updateButtonsDisabled, 0);

  const _origLoadTrack = loadTrack;
  window.loadTrack = async function(...args){
    const r = await _origLoadTrack.apply(this, args);
    updateButtonsDisabled();
    return r;
  };
})();
