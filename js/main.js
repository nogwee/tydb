// ===== main.js =====
// 初期化の順序だけを担当。各モジュールを呼び出して繋ぐ。

import { createMap } from './map.js';
import { loadManifest, populateYearSelect, populateTyphoonSelect, updateWikiLink } from './manifest.js';
import { loadTrack, ensureActiveLayers, setActivePosition, startPulse, stopPulse, toggleActive } from './track.js';
import { initPrecip, setPrecipTime } from './overlay_precip.js';
import { initGust, setGustTime } from './overlay_gust.js';
import { els, setTimeLabel, bindLayerToggles, bindSidebarToggle, addHourStepButtons, mountCursorPosControl } from './ui.js';
import { resolveGeojsonPath, setLayerVisibility } from './utils.js';


let map;
let STATE = {
  hourlyPoints: [],
  PRECIP_KEYS: [],
  TIME_TEXTS: [],
  byYear: null,
  byId: null,
  data: null
};

function setActiveTime(index){
  const p = STATE.hourlyPoints?.[index];
  if (!p) return;
  setActivePosition(map, p.lat, p.lon);
  setTimeLabel(STATE.TIME_TEXTS[index] || String(index));
  const key = STATE.PRECIP_KEYS[index];
  if (key) {
    setPrecipTime(map, key);
    setGustTime(map, key);
  }
}

async function applyTyphoon(id){
  const meta = STATE.byId.get(id);
  const path = meta?.geojson || resolveGeojsonPath(id);

  const { hourlyPoints, PRECIP_KEYS, TIME_TEXTS } = await loadTrack(map, path);
  STATE.hourlyPoints = hourlyPoints;
  STATE.PRECIP_KEYS  = PRECIP_KEYS;
  STATE.TIME_TEXTS   = TIME_TEXTS;

  // スライダー
  els.slider.min = '0';
  els.slider.max = String(hourlyPoints.length - 1);
  els.slider.step = '1';
  els.slider.value = '0';

  // アクティブ位置＋波紋
  ensureActiveLayers(map, hourlyPoints[0]);
  setActivePosition(map, hourlyPoints[0].lat, hourlyPoints[0].lon);
  setActiveTime(0);

  // ±1hボタンの有効/無効状態を再評価
  if (window.updateHourStepButtons) window.updateHourStepButtons();

  // アクティブ表示ONなら波紋アニメーション開始
  if (els.chkActive.checked) startPulse(map);

  // Wiki
  updateWikiLink(els.wiki, meta);

  // ハッシュ更新
  try { history.replaceState(null, '', `#${encodeURIComponent(id)}`); } catch {}
}

async function bootstrap(){
  map = createMap();

  // カーソル座標を右上に常時表示（小数5桁。度分秒にしたければ { dms:true }）
  mountCursorPosControl(map, { precision: 4 });

  map.on('load', async () => {
    // マニフェスト読込 → 年/台風セレクト初期化
    const { data, byYear, byId } = await loadManifest('./data/typhoons.json');
    STATE.data = data; STATE.byYear = byYear; STATE.byId = byId;

    populateYearSelect(els.selYear, byYear);

    // 初期選択: ハッシュ > defaultId > 最新年の先頭
    const hashId = location.hash?.replace(/^#/, '');
    let initialId = null, initialYear = null;

    if (hashId && byId.has(hashId)) {
      initialId = hashId;
      for (const [y, items] of byYear.entries()) {
        if (items.some(it => it.id === hashId)) { initialYear = y; break; }
      }
    } else if (data.defaultId && byId.has(data.defaultId)) {
      initialId = data.defaultId;
      for (const [y, items] of byYear.entries()) {
        if (items.some(it => it.id === initialId)) { initialYear = y; break; }
      }
    } else {
      const years = Array.from(byYear.keys()).sort((a,b)=> String(b).localeCompare(String(a),'ja'));
      if (years.length) {
        initialYear = years[0];
        initialId = (byYear.get(initialYear) || [])[0]?.id || null;
      }
    }

    if (initialYear) els.selYear.value = initialYear;
    populateTyphoonSelect(els.selTy, byYear, els.selYear.value);
    if (initialId) els.selTy.value = initialId;

    if (initialId) {
      await applyTyphoon(initialId);

      // 台風・時刻に連動した降水オーバーレイ初期化
      const precipKey = STATE.PRECIP_KEYS[0];
      if (precipKey) {
        initPrecip(map, precipKey);
        setLayerVisibility(map, 'precip-img', els.chkPre.checked);
      }

      // 台風・時刻に連動した突風オーバーレイ初期化
      if (precipKey) {
        initGust(map, precipKey);
        setLayerVisibility(map, 'gust-img', els.chkGust.checked);
      }
    }

    // レイヤ順序最後へ（前景にトラック等を残す）
    ['track-line','track-points','active-point','active-pulse'].forEach(id => {
      if (map.getLayer(id)) map.moveLayer(id);
    });
  });

  // UIバインド
  bindLayerToggles(map);
  bindSidebarToggle(map);

  // アクティブ表示のON/OFFと波紋制御
  els.chkActive.addEventListener('change', () => {
    const on = els.chkActive.checked;
    toggleActive(map, on);
    if (on) startPulse(map); else stopPulse();
  });

  // スライダー・±1h・矢印キー
  els.slider.addEventListener('input', e => setActiveTime(Number(e.target.value)));
  window.updateHourStepButtons = addHourStepButtons((i) => setActiveTime(i));

  // 年→台風
  els.selYear.addEventListener('change', async () => {
    populateTyphoonSelect(els.selTy, STATE.byYear, els.selYear.value);
    const first = els.selTy.options[0]?.value;
    if (first) {
      els.selTy.value = first;
      await applyTyphoon(first);
    } else {
      // 台風無し: トラックを空に
      map.getSource('track')?.setData({ type:'FeatureCollection', features:[] });
      updateWikiLink(els.wiki, null);
    }
  });

  // 台風変更
  els.selTy.addEventListener('change', e => applyTyphoon(e.target.value));
}

bootstrap();
