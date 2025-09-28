// ===== track.js =====
// トラック GeoJSON 読込、時間内挿、アクティブ位置・波紋

import {
  toDateAny, buildHourlyTimeline, findBracket, lerpPos,
  diffHours, dateToKeyUTC, setLayersVisibility
} from './utils.js';

export async function loadTrack(map, geojsonUrl) {
  // --- fetch/geojsonパース ---
  const res = await fetch(geojsonUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error('GeoJSON 読込失敗: ' + res.status + ' (' + geojsonUrl + ')');
  const geo = await res.json();
  map.getSource('track').setData(geo);

  // --- rawPoints生成 ---
  const rawPoints = geo.features
    .filter(f => f.geometry?.type === 'Point')
    .map(f => {
      const p = f.properties || {};
      const dtStr = p["datetime(UTC)"];
      const time = (dtStr != null) ? toDateAny(dtStr.replace(' ', 'T') + 'Z') : null;
      const [lon, lat] = f.geometry.coordinates;
      return { time, lat:+lat, lon:+lon, _raw: dtStr };
    })
    .filter(d => d.time instanceof Date && !isNaN(d.time))
    .sort((a,b)=>a.time-b.time);

  if (!rawPoints.length) throw new Error('Point（観測点）が見つかりません: ' + geojsonUrl);


  // --- hourlyTimes生成 ---
  const hourlyTimes  = buildHourlyTimeline(rawPoints[0].time, rawPoints[rawPoints.length-1].time);

  // --- hourlyPoints生成 ---
  const hourlyPoints = [];
  for (const t of hourlyTimes){
    const {i0,i1} = findBracket(rawPoints, t);
    const A = rawPoints[i0], B = rawPoints[i1];
    const gap = diffHours(B.time, A.time);
    if (gap >= 0 && gap <= 9){
      let lat, lon;
      if (gap === 0) {
        lat = A.lat;
        lon = A.lon;
      } else {
        const f = diffHours(t, A.time) / gap;
        ({lat, lon} = lerpPos(A, B, f));
      }
      hourlyPoints.push({ time:t, lat, lon });
    }
  }

  const PRECIP_KEYS = hourlyPoints.map(p => dateToKeyUTC(p.time));
  const TIME_TEXTS  = hourlyPoints.map(p => p.time.toISOString().replace('.000',''));

  return { hourlyPoints, PRECIP_KEYS, TIME_TEXTS };
}

// === active 用レイヤ
export function ensureActiveLayers(map, initial) {
  const srcId = 'active';
  if (!map.getSource(srcId)) {
    map.addSource(srcId, {
      type: 'geojson',
      data: { type:'FeatureCollection', features:[{
        type:'Feature', properties:{}, geometry:{ type:'Point', coordinates:[initial.lon, initial.lat] }
      }]}
    });
    map.addLayer({
      id:'active-point',
      type:'circle',
      source:srcId,
      paint:{ 'circle-radius': 4, 'circle-color': '#d22', 'circle-stroke-color':'#fff', 'circle-stroke-width':1 }
    });
    map.addLayer({
      id:'active-pulse',
      type:'circle',
      source:srcId,
      paint:{ 'circle-radius': 12, 'circle-color': '#ff2d2d', 'circle-opacity': 0.25, 'circle-blur': 0.4 }
    });
  }
}
export function setActivePosition(map, lat, lon){
  const src = map.getSource('active'); if (!src) return;
  src.setData({ type:'FeatureCollection', features:[{
    type:'Feature', properties:{}, geometry:{ type:'Point', coordinates:[lon, lat] }
  }]});
}
export function toggleActive(map, on){
  setLayersVisibility(map, ['active-point','active-pulse'], on);
}

// === 波紋アニメーション
let _pulseRAF = null;
let _pulseRunning = false;
const PULSE_PERIOD = 1200;
const PULSE_MIN_R = 10;
const PULSE_MAX_R = 20;

function _pulseStep(map) {
  if (!_pulseRunning) return;
  const t = (performance.now() % PULSE_PERIOD) / PULSE_PERIOD;
  let radius, opacity;
  if (t < 0.9) { radius = PULSE_MIN_R + (PULSE_MAX_R - PULSE_MIN_R) * t; opacity = 0.35 * (1 - t); }
  else { radius = PULSE_MIN_R; opacity = 0; }
  if (map.getLayer('active-pulse')) {
    map.setPaintProperty('active-pulse', 'circle-radius', radius);
    map.setPaintProperty('active-pulse', 'circle-opacity', opacity);
  }
  _pulseRAF = requestAnimationFrame(()=>_pulseStep(map));
}
export function startPulse(map) {
  if (_pulseRunning) return;
  _pulseRunning = true;
  _pulseRAF = requestAnimationFrame(()=>_pulseStep(map));
}
export function stopPulse() {
  _pulseRunning = false;
  if (_pulseRAF) cancelAnimationFrame(_pulseRAF);
  _pulseRAF = null;
}
