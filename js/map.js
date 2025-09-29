// ===== map.js =====
// MapLibre 初期化（maplibregl は index.html の CDN スクリプトでグローバル提供）

export function createMap() {
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
        track:   { type:'geojson', data:{ type:"FeatureCollection", features:[] } },
        windsrc: { type:'geojson', data:{ type:"FeatureCollection", features:[] } },
      },
      layers: [
        { id:'basemap', type:'raster', source:'basemap' },
        { id:'track-line', type:'line', source:'track',
          filter:['==', ['geometry-type'], 'LineString'],
          paint:{'line-color':'#333','line-width':2},
          layout:{ visibility:'visible' } },
        { id:'track-points', type:'circle', source:'track',
          filter:['==', ['geometry-type'], 'Point'],
          paint:{'circle-radius':4, 'circle-color':'#666'},
          layout:{ visibility:'visible' } }
      ]
    },
    center:[139.7,35.6], zoom:4
  });
  return map;
}
