// ===== overlay_precip.js =====
// 降水タイル（XYZ）レイヤ制御

const TILE_URL = './tiles/precip_20250929_09/{z}/{x}/{y}.png';

export function initPrecip(map) {
  const id = 'precip-tile';
  if (!map.getSource(id)) {
    map.addSource(id, {
      type: 'raster',
      tiles: [TILE_URL],
      tileSize: 256,
      scheme: 'xyz',
    });
    map.addLayer({
      id,
      type: 'raster',
      source: id,
      layout: { visibility: 'none' },
      paint: { 'raster-opacity': 0.7, 'raster-resampling': 'nearest' },
    });
  }
}

// 時間ごとにタイルセットを切り替える場合は、TILE_URLを動的に変更する実装が必要
export function setPrecipTime(map, key) {
  // 例: keyでタイルセットを切り替える場合
  // const url = `./tiles/precip_${key}/{z}/{x}/{y}.png`;
  // map.getSource('precip-tile').setTiles([url]);
  // 今回は単一セットなので未実装
}
