// ===== DOM =====
const slider = document.getElementById('time');
const label  = document.getElementById('label');
const selTy  = document.getElementById('sel-typhoon');
const chkPre = document.getElementById('chk-precip');
const chkWin = document.getElementById('chk-wind');
const chkTrackLine = document.getElementById('chk-trackline');
const chkActive = document.getElementById('chk-active');

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
        paint:{ 'line-color':'#333','line-width':2 } },
      { id:'track-points', type:'circle', source:'track',
        filter:['==',['get','kind'],'point'],
        paint:{ 'circle-radius':4, 'circle-color':'#666' } },
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
        features:[{
          type:'Feature',
          properties:{},
          geometry:{ type:'Point', coordinates:[initial.lon, initial.lat] }
        }]
      }
    });
    map.addLayer({
      id:'active-point',
      type:'circle',
      source:srcId,
      paint:{
        'circle-radius': 4,
        'circle-color': '#d22',
        'circle-stroke-color':'#fff',
        'circle-stroke-width':1
      }
    });
    map.addLayer({
      id:'active-pulse',
      type:'circle',
      source:srcId,
      paint:{
        'circle-radius': 12,
        'circle-color':  '#ff2d2d',
        'circle-opacity': 0.25,
        'circle-blur':   0.4
      }
    });
  }
}

function setActivePosition(lat, lon){
  const src = map.getSource('active');
  if (!src) return;
  src.setData({
    type:'FeatureCollection',
    features:[{
      type:'Feature',
      properties:{},
      geometry:{ type:'Point', coordinates:[lon, lat] }
    }]
  });
}

// ===== ユーティリティ =====
function setLayerVisibility(layerId, visible) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}
function setLayersVisibility(layerIds, visible) {
  layerIds.forEach(id => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  });
}
function bindToggle(checkboxEl, layerId) {
  const apply = () => setLayerVisibility(layerId, checkboxEl.checked);
  checkboxEl.addEventListener('change', apply);
  map.on('load', apply);
}
function bindToggleMulti(checkboxEl, layerIds) {
  const apply = () => setLayersVisibility(layerIds, checkboxEl.checked);
  checkboxEl.addEventListener('change', apply);
  map.on('load', apply);
}

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
  if (!res.ok) throw new Error('GeoJSON 読込失敗: ' + res.status);
  const geo = await res.json();

  map.getSource('track').setData(geo);

  const rawPoints = geo.features
    .filter(f => f.properties?.kind === 'point' && f.geometry?.type === 'Point')
    .map(f => {
      const p = f.properties || {};
      const time = (typeof p.time === 'string' || typeof p.time === 'number') ? toDateAny(p.time) : null;
      const [lon, lat] = f.geometry.coordinates;
      return { time, lat:+lat, lon:+lon };
    })
    .filter(d => d.time instanceof Date && !isNaN(d.time))
    .sort((a,b)=>a.time-b.time);

  if (!rawPoints.length) throw new Error('pointが見つかりません');

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
  const layerId = 'precip-img';
  const url = PRECIP_PNG(key);

  if (!map.getSource(srcId)) {
    map.addSource(srcId, {
      type: 'image',
      url,
      coordinates: BOUNDS
    });
    map.addLayer({
      id: layerId,
      type: 'raster',
      source: srcId,
      layout: { visibility: chkPre.checked ? 'visible' : 'none' },
      paint: { 'raster-opacity': 0.6, 'raster-resampling': 'nearest' }
    });
  } else {
    map.getSource(srcId).updateImage({ url, coordinates: BOUNDS });
  }
}
function setPrecipTime(key) {
  const src = map.getSource('precip-img');
  if (!src) return;
  src.updateImage({ url: PRECIP_PNG(key) });
}

// ===== 波紋アニメーション =====
let _pulseRAF = null;
let _pulseRunning = false;
const PULSE_PERIOD = 1200;
const PULSE_MIN_R = 10;
const PULSE_MAX_R = 20;
function _pulseStep() {
  if (!_pulseRunning) return;
  const now = performance.now();
  const t = (now % PULSE_PERIOD) / PULSE_PERIOD;
  let radius, opacity;
  if (t < 0.9) {
    radius  = PULSE_MIN_R + (PULSE_MAX_R - PULSE_MIN_R) * t;
    opacity = 0.35 * (1 - t);
  } else {
    radius  = PULSE_MIN_R;
    opacity = 0;
  }
  if (map.getLayer('active-pulse')) {
    map.setPaintProperty('active-pulse', 'circle-radius', radius);
    map.setPaintProperty('active-pulse', 'circle-opacity', opacity);
  }
  _pulseRAF = requestAnimationFrame(_pulseStep);
}
function startPulse() {
  if (_pulseRunning) return;
  _pulseRunning = true;
  _pulseRAF = requestAnimationFrame(_pulseStep);
}
function stopPulse() {
  _pulseRunning = false;
  if (_pulseRAF) cancelAnimationFrame(_pulseRAF);
  _pulseRAF = null;
}

// ===== イベント =====
slider.addEventListener('input', (e) => setActiveTime(Number(e.target.value)));
selTy.addEventListener('change', () => {
  loadTrack('./data/track_sample.geojson').catch(err => {
    console.error(err); alert('トラック読み込みエラー: ' + err.message);
  });
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
  loadTrack('./data/track_sample.geojson').catch(err => {
    console.error(err); alert('初期データ読み込みエラー: ' + err.message);
  });
  try {
    addOrUpdatePrecip(INITIAL_PRECIP_KEY);
    setLayerVisibility('precip-img', chkPre.checked);
  } catch (e) { console.warn('precip PNG 初期化失敗:', e); }
  ['track-line','track-points','active-point','active-pulse'].forEach(id => {
    if (map.getLayer(id)) map.moveLayer(id);
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
  // 1) 既存ボタンがあれば取得、無ければ作る
  let btnPrev = document.getElementById('btn-prev');
  let btnNext = document.getElementById('btn-next');

  function makeBtn(id, text, title){
    const b = document.createElement('button');
    b.id = id;
    b.type = 'button';
    b.textContent = text;
    b.title = title;
    b.style.margin = '0 6px';
    b.style.padding = '2px 8px';
    b.style.cursor = 'pointer';
    return b;
  }

  if (!btnPrev || !btnNext) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';

    // スライダーの親に差し替え挿入
    const parent = slider.parentElement || document.body;
    parent.insertBefore(wrap, slider);

    // 生成 or 既存を移動
    btnPrev = btnPrev || makeBtn('btn-prev', '−1h', '1時間戻る');
    btnNext = btnNext || makeBtn('btn-next', '+1h', '1時間進む');

    // wrapへ [prev][slider][next] の順に配置
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

  // 2) クリックで±1時間
  btnPrev.addEventListener('click', () => setIdx(getIdx() - 1));
  btnNext.addEventListener('click', () => setIdx(getIdx() + 1));

  // 3) スライダー操作時も活性/非活性更新
  slider.addEventListener('input', updateButtonsDisabled);

  // 4) キーボード（←/→）で±1時間（フォーム入力中は無効）
  document.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); btnPrev.click(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); btnNext.click(); }
  });

  // 5) 初期同期（トラック読込後にも呼ばれるよう保険でタイマー）
  setTimeout(updateButtonsDisabled, 0);

  // 6) トラック読込後にもボタン状態を更新（既存フローにフック）
  const _origLoadTrack = loadTrack;
  window.loadTrack = async function(...args){
    const r = await _origLoadTrack.apply(this, args);
    updateButtonsDisabled();
    return r;
  };
})();
