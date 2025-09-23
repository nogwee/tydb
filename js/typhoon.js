// ===== DOM =====
const slider = document.getElementById('time');
const label  = document.getElementById('label');
const selTy  = document.getElementById('sel-typhoon');
const chkPre = document.getElementById('chk-precip');
const chkWin = document.getElementById('chk-wind');
const chkRail= document.getElementById('chk-rail');

// ===== 雨量PNGの貼り付け設定（あなたの格子に合わせて調整） =====
const GRID = { minLon:110.0, maxLon:160.0, minLat:10.0, maxLat:50.0, dLon:0.25, dLat:0.25 };
const BOUNDS = [
  [GRID.minLon - GRID.dLon/2, GRID.maxLat + GRID.dLat/2], // 左上
  [GRID.maxLon + GRID.dLon/2, GRID.maxLat + GRID.dLat/2], // 右上
  [GRID.maxLon + GRID.dLon/2, GRID.minLat - GRID.dLat/2], // 右下
  [GRID.minLon - GRID.dLon/2, GRID.minLat - GRID.dLat/2], // 左下
];
const PRECIP_PNG = (key) => `./overlays/precip_${key}.png`;
const INITIAL_PRECIP_KEY = "20180903T0000Z"; // 初期表示用（任意の存在するPNGキーに）

// スライダーの t_idx → PNGファイル名キー（YYYYMMDDTHHMMZ）
let PRECIP_KEYS = [];
let TIME_TEXTS   = [];

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
      railsrc: { type:'geojson', data:{ "type":"FeatureCollection","features":[] } }
      // ★ ここに precip-img は入れない（後で addSource する）
    },
    layers: [
      { id:'basemap', type:'raster', source:'basemap' },

      { id:'track-line', type:'line', source:'track',
        paint:{ 'line-color':'#333','line-width':2 } },
      { id:'track-points', type:'circle', source:'track',
        filter:['==',['get','kind'],'point'],
        paint:{ 'circle-radius':4, 'circle-color':'#666' } },
      { id:'track-points-active', type:'circle', source:'track',
        filter:['all',['==',['get','kind'],'point'], ['==',['get','t_idx'], 0]],
        paint:{ 'circle-radius':6, 'circle-color':'#d22', 'circle-stroke-color':'#fff', 'circle-stroke-width':1 } },

      // 風・鉄道（ダミー）
      { id:'wind', type:'circle', source:'windsrc',
        layout:{ visibility:'none' },
        paint:{ 'circle-radius':3, 'circle-color':'#2b8a3e' } },
      { id:'rail', type:'line', source:'railsrc',
        layout:{ visibility:'none' },
        paint:{ 'line-color':'#8e44ad', 'line-width':2 } }
    ]
  },
  center:[139.7,35.6], zoom:4
});

// ===== ユーティリティ =====
function setLayerVisibility(layerId, visible) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}
function bindToggle(checkboxEl, layerId) {
  const apply = () => setLayerVisibility(layerId, checkboxEl.checked);
  checkboxEl.addEventListener('change', apply);
  map.on('load', apply);
}

// "YYYY-MM-DD HH:MM:SS" → "YYYYMMDDTHHMMZ"（UTCとして扱う）
function timeStringToKey(s) {
  // 例: "2018-09-04 18:00:00"
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const yyyy = m[1], MM = m[2], dd = m[3], HH = m[4], mm = m[5]; // ss=m[6] は捨てる
  return `${yyyy}${MM}${dd}T${HH}${mm}Z`;
}

function setActiveTime(t) {
  const timeText = TIME_TEXTS[t] || `t=${t}`;
  label.textContent = timeText;
  map.setFilter('track-points-active',
    ['all', ['==',['get','kind'],'point'], ['==',['get','t_idx'], t]]
  );
  // スライダーに合わせて降水PNGを切替
  const key = PRECIP_KEYS[t];
  if (key) setPrecipTime(key);
}

// ===== 台風トラック読込 & スライダー設定 =====
async function loadTrack(geojsonUrl) {
  const res = await fetch(geojsonUrl, { cache: 'no-cache' });
  if (!res.ok) throw new Error('GeoJSON 読込失敗: ' + res.status);
  const geo = await res.json();

  const points = geo.features.filter(f => f.properties?.kind === 'point');

  // t_idx を保証
  if (points.length && points.every(f => typeof f.properties.t_idx !== 'number')) {
    points.forEach((f, i) => f.properties.t_idx = i);
  }

  // t_idx 昇順に並べて PNGキー配列を構築
  const sorted = [...points].sort((a,b) => (a.properties.t_idx ?? 0) - (b.properties.t_idx ?? 0));
  PRECIP_KEYS = [];
  TIME_TEXTS   = [];
  sorted.forEach(f => {
    const p = f.properties || {};
    // 時刻文字列（"YYYY-MM-DD HH:MM:SS"）を保存
    if (typeof p.time === 'string') TIME_TEXTS.push(p.time);
    else TIME_TEXTS.push(null);
  
    // PNGキーも従来どおり作成
    if (p.key && typeof p.key === 'string') {
      PRECIP_KEYS.push(p.key);
    } else if (p.time && typeof p.time === 'string') {
      PRECIP_KEYS.push(timeStringToKey(p.time));
    } else {
      PRECIP_KEYS.push(null);
    }
  });

  map.getSource('track').setData(geo);

  const maxIdx = sorted.reduce((m,f)=>Math.max(m, f.properties.t_idx ?? 0), 0);
  slider.min = '0';
  slider.max = String(maxIdx);
  slider.step = '1';
  slider.value = '0';

  // 初期アクティブ（PNGも切替）
  setActiveTime(0);
}

// ===== 雨量PNG（image source + layer を load 後に追加） =====
function addOrUpdatePrecip(key = INITIAL_PRECIP_KEY) {
  const srcId = 'precip-img';
  const layerId = 'precip-img';
  const url = PRECIP_PNG(key);

  if (!map.getSource(srcId)) {
    // ソースを追加
    map.addSource(srcId, {
      type: 'image',
      url,
      coordinates: BOUNDS
    });
    // レイヤを追加（source を参照させる）
    map.addLayer({
      id: layerId,
      type: 'raster',
      source: srcId,
      layout: { visibility: chkPre.checked ? 'visible' : 'none' }, // 初期はチェックボックスに合わせる
      paint: {
        'raster-opacity': 0.6,
        'raster-resampling': 'nearest'
      }
    });
  } else {
    // 既存ソースの画像だけ差し替え
    const src = map.getSource(srcId);
    src.updateImage({ url, coordinates: BOUNDS });
    // src.setCoordinates(BOUNDS);
  }
}
function setPrecipTime(key) {
  const src = map.getSource('precip-img');
  if (!src) return;
  src.updateImage({ url: PRECIP_PNG(key) }); // 座標は固定なら省略OK
  // 座標は固定なら setCoordinates は不要
}

// ===== イベント配線 =====
slider.addEventListener('input', (e) => setActiveTime(Number(e.target.value)));
selTy.addEventListener('change', () => {
  const url = './data/track_sample.geojson'; // TODO: 実IDで切替
  loadTrack(url).catch(err => { console.error(err); alert('トラック読み込みエラー: ' + err.message); });
});
bindToggle(chkPre,  'precip-img'); // ← レイヤ追加後に効く
bindToggle(chkWin,  'wind');
bindToggle(chkRail, 'rail');

// ===== 初期ロード =====
map.on('load', () => {
  // 1) 台風トラック
  loadTrack('./data/track_sample.geojson').catch(err => {
    console.error(err);
    alert('初期データ読み込みエラー: ' + err.message);
  });

  // 2) 降水PNG（存在するなら追加）
  try {
    addOrUpdatePrecip(INITIAL_PRECIP_KEY);
    // 明示反映（保険）
    setLayerVisibility('precip-img', chkPre.checked);
  } catch (e) {
    console.warn('precip PNG の初期化に失敗:', e);
  }

  // ★ 3) 経路関連レイヤを最前面に移動
  ["track-line", "track-points", "track-points-active"].forEach(id => {
    if (map.getLayer(id)) {
      map.moveLayer(id);
    }
  });
});
