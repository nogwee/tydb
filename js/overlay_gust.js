// ===== overlay_gust.js =====
// 降水PNGの image source 制御

const GRID = { minLon:90.0, maxLon:180.0, minLat:0.0, maxLat:60.0, dLon:0.25 };
const northEdgeLat = 60.0624; // 画像の最上端の緯度(nc_to_png.pyで出力された値)
const southEdgeLat = -0.1249; 
const BOUNDS = [
  [GRID.minLon - GRID.dLon/2, northEdgeLat], // top-left
  [GRID.maxLon + GRID.dLon/2, northEdgeLat], // top-right
  [GRID.maxLon + GRID.dLon/2, southEdgeLat], // bottom-right
  [GRID.minLon - GRID.dLon/2, southEdgeLat], // bottom-left
];
const GUST_PNG = (key) => `./overlays/gust/gust_${key}.png`;

export function initGust(map, initialKey) {
  const id = 'gust-img';
  if (!map.getSource(id)) {
    map.addSource(id, { type:'image', url: GUST_PNG(initialKey), coordinates: BOUNDS });
    map.addLayer({
      id, type:'raster', source:id,
      layout: { visibility: 'none' }, // 可視/不可視は UI 側が制御
      paint: { 'raster-opacity': 0.7, 'raster-resampling': 'nearest' }
    });
  }
}

export function setGustTime(map, key) {
  const src = map.getSource('gust-img');
  if (!src) return;
  src.updateImage({ url: GUST_PNG(key), coordinates: BOUNDS });
}
