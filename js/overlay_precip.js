// ===== overlay_precip.js =====
// 降水PNGの image source 制御

const GRID = { minLon:110.0, maxLon:160.0, minLat:10.0, maxLat:50.0, dLon:0.25, dLat:0.25 };
const BOUNDS = [
  [GRID.minLon - GRID.dLon/2, GRID.maxLat + GRID.dLat/2], // top-left
  [GRID.maxLon + GRID.dLon/2, GRID.maxLat + GRID.dLat/2], // top-right
  [GRID.maxLon + GRID.dLon/2, GRID.minLat - GRID.dLat/2], // bottom-right
  [GRID.minLon - GRID.dLon/2, GRID.minLat - GRID.dLat/2], // bottom-left
];
const PRECIP_PNG = (key) => `./overlays/precip_${key}.png`;

export function initPrecip(map, initialKey) {
  const id = 'precip-img';
  if (!map.getSource(id)) {
    map.addSource(id, { type:'image', url: PRECIP_PNG(initialKey), coordinates: BOUNDS });
    map.addLayer({
      id, type:'raster', source:id,
      layout: { visibility: 'none' }, // 可視/不可視は UI 側が制御
      paint: { 'raster-opacity': 0.6, 'raster-resampling': 'nearest' }
    });
  }
}

export function setPrecipTime(map, key) {
  const src = map.getSource('precip-img');
  if (!src) return;
  src.updateImage({ url: PRECIP_PNG(key), coordinates: BOUNDS });
}
