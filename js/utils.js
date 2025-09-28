// ===== utils.js =====
// 時刻・内挿の下回りやレイヤ可視制御、パス解決など汎用

export const HOUR = 3600000;

export const wrapLon = lon => ((lon + 180) % 360) - 180;
export const diffHours = (t1, t0) => (t1 - t0) / HOUR;

export function toDateAny(v){
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v < 1e12 ? v*1000 : v);
  return new Date(v);
}

export function buildHourlyTimeline(startTime, endTime){
  const out = [];
  const t0 = new Date(Math.ceil(startTime.getTime()/HOUR)*HOUR);
  for (let t=t0.getTime(); t<=endTime.getTime(); t+=HOUR) out.push(new Date(t));
  return out;
}

export function findBracket(arr, t){
  let lo = 0, hi = arr.length-1;
  if (t <= arr[0].time) return {i0:0,i1:0};
  if (t >= arr[hi].time) return {i0:hi,i1:hi};
  while (hi-lo>1){
    const mid=(lo+hi)>>1;
    (arr[mid].time <= t ? lo=mid : hi=mid);
  }
  return {i0:lo,i1:hi};
}

export function lerpPos(A, B, f){
  let lon1 = B.lon;
  const dlon = lon1 - A.lon;
  if (dlon > 180) lon1 -= 360;
  if (dlon < -180) lon1 += 360;
  const lat = A.lat + (B.lat - A.lat) * f;
  const lon = wrapLon(A.lon + (lon1 - A.lon) * f);
  return { lat, lon };
}

export const pad2 = n => String(n).padStart(2,'0');
export const dateToKeyUTC = d =>
  `${d.getUTCFullYear()}${pad2(d.getUTCMonth()+1)}${pad2(d.getUTCDate())}T${pad2(d.getUTC_Hours?.() ?? d.getUTCHours())}${pad2(d.getUTCMinutes())}Z`;

export function setLayerVisibility(map, id, on){
  if (map.getLayer(id)) map.setLayoutProperty(id,'visibility', on?'visible':'none');
}
export function setLayersVisibility(map, ids, on){ ids.forEach(id => setLayerVisibility(map,id,on)); }

export function resolveGeojsonPath(selectValue){
  if (!selectValue) return null;
  let v = String(selectValue).trim();
  if (!v) return null;
  const hasExt  = /\.geojson$/i.test(v);
  const hasPath = v.includes('/');
  if (!hasPath) {
    if (!hasExt) v = `${v}.geojson`;
    return `../data/bst_geojson/${v}`;
  }
  return hasExt ? v : `${v}.geojson`;
}
