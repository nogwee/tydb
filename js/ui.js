// 降水カラーバーのラベル値
const JMA_RAIN_LABELS = ["1", "5", "10", "20", "30", "50", "80"];
const JMA_RAIN_COLORS = [
    [242, 242, 255],  // 0–1
    [160, 210, 255],  // 1–5
    [33, 140, 255],   // 5–10
    [0, 65, 255],     // 10–20
    [250, 245, 0],    // 20–30
    [255, 153, 0],    // 30–50
    [255, 40, 0],     // 50–80
    [180, 0, 104],    // 80
];

function renderPrecipColorbar() {
  const bar = document.getElementById('precip-colorbar');
  if (!bar) return;
  // 離散ブロック
  bar.innerHTML = '';
  for (let i = 0; i < JMA_RAIN_COLORS.length; i++) {
    const c = JMA_RAIN_COLORS[i];
    const div = document.createElement('div');
    div.className = 'precip-colorbar-block';
    div.style.background = `rgb(${c[0]},${c[1]},${c[2]})`;
    bar.appendChild(div);
  }
  // ラベル（区間比率で正確に配置）
  let labelDiv = document.getElementById('precip-colorbar-labels');
  if (!labelDiv) {
    labelDiv = document.createElement('div');
    labelDiv.id = 'precip-colorbar-labels';
    bar.after(labelDiv);
  }
  // 等間隔配置: 8ブロック→7ラベル
  const n = JMA_RAIN_COLORS.length;
  let html = '';
  for (let i = 1; i < n; i++) {
    // i=1～7, ラベルは各ブロックの右端
    let pct = (i / n) * 100;
    // 全体的に少し左寄せ
    html += `<span style="position:absolute;left:calc(${pct}% - 21px);min-width:24px;text-align:center;">${JMA_RAIN_LABELS[i-1]}</span>`;
  }
  labelDiv.innerHTML = html;
  labelDiv.style.position = 'relative';
  labelDiv.style.height = '16px';
}

function setPrecipColorbarVisible(visible) {
  const bar = document.getElementById('precip-colorbar');
  const labels = document.getElementById('precip-colorbar-labels');
  if (bar) bar.style.display = visible ? '' : 'none';
  if (labels) labels.style.display = visible ? 'flex' : 'none';
}
// ===== ui.js =====
// DOM 参照と UI バインド（トグル、サイドバー、±1hボタン、キー操作）

import { setLayerVisibility } from './utils.js';

export const els = {
  slider: document.getElementById('time'),
  label:  document.getElementById('label'),
  selYear:document.getElementById('sel-year'),
  selTy:  document.getElementById('sel-typhoon'),
  chkPre: document.getElementById('chk-precip'),
  chkWin: document.getElementById('chk-wind'),
  chkTrackLine: document.getElementById('chk-trackline'),
  chkActive: document.getElementById('chk-active'),
  wiki:   document.getElementById('wiki-link'),
  sidebar:document.getElementById('sidebar'),
  toggleBtn:document.getElementById('sidebar-toggle'),
};

export function setTimeLabel(text){ els.label.textContent = text; }

export function bindLayerToggles(map){
  // 降水
  renderPrecipColorbar();
  const applyPre = () => {
    setLayerVisibility(map, 'precip-tile', els.chkPre.checked);
    setPrecipColorbarVisible(els.chkPre.checked);
  };
  els.chkPre.addEventListener('change', applyPre);
  map.on('load', applyPre);

  // トラック（線・点）
  const setMulti = on => ['track-line','track-points'].forEach(id=>setLayerVisibility(map,id,on));
  const applyTrack = () => setMulti(els.chkTrackLine.checked);
  els.chkTrackLine.addEventListener('change', applyTrack);
  map.on('load', applyTrack);
}

export function bindSidebarToggle(map){
  els.toggleBtn.addEventListener('click', () => {
    const collapsed = els.sidebar.classList.toggle('collapsed');
    els.toggleBtn.textContent = collapsed ? '≫' : '≪';
    els.toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    map.resize();
  });
  els.sidebar.addEventListener('transitionend', (e) => {
    if (e.propertyName === 'width') map.resize();
  });
}

export function addHourStepButtons(onStep){
  // 既存があれば再利用
  let btnPrev = document.getElementById('btn-prev');
  let btnNext = document.getElementById('btn-next');
  const slider = els.slider;

  function makeBtn(id, text, title){
    const b = document.createElement('button');
    b.id = id; b.type = 'button';
    b.textContent = text; b.title = title;
    b.style.margin = '0 6px'; b.style.padding = '2px 8px'; b.style.cursor = 'pointer';
    return b;
  }

  if (!btnPrev || !btnNext) {
    const wrap = document.createElement('div');
    wrap.style.display = 'flex';
    wrap.style.alignItems = 'center';
    wrap.style.gap = '6px';

    const parent = slider.parentElement || document.body;
    parent.insertBefore(wrap, slider);

    btnPrev = btnPrev || makeBtn('btn-prev', '−1h', '1時間戻る');
    btnNext = btnNext || makeBtn('btn-next', '+1h', '1時間進む');

    wrap.appendChild(btnPrev);
    wrap.appendChild(slider);
    wrap.appendChild(btnNext);
  }

  const getMin = () => Number(slider.min) || 0;
  const getIdx = () => Number(slider.value) || getMin();
  const maxIdx = () => Number(slider.max) || getMin();
  const setIdx = (i) => {
    const min = getMin(), max = maxIdx();
    const clamped = Math.max(min, Math.min(i, max));
    slider.value = String(clamped);
    onStep(clamped);
    updateButtonsDisabled();
  };
  function updateButtonsDisabled(){
    const i = getIdx(), min = getMin(), m = maxIdx();
    btnPrev.disabled = (i <= min);
    btnNext.disabled = (i >= m);
  }

  btnPrev.addEventListener('click', () => setIdx(getIdx() - 1));
  btnNext.addEventListener('click', () => setIdx(getIdx() + 1));
  slider.addEventListener('input', updateButtonsDisabled);
  setTimeout(updateButtonsDisabled, 0);
  return updateButtonsDisabled;

  // ←/→ キー
  document.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); setIdx(getIdx() - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setIdx(getIdx() + 1); }
  });
}
