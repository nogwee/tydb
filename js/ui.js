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
  const applyPre = () => setLayerVisibility(map, 'precip-img', els.chkPre.checked);
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

  const getIdx = () => (Number(slider.value) | 0);
  const maxIdx = () => (Number(slider.max)   | 0);
  const setIdx = (i) => {
    const clamped = Math.max(0, Math.min(i, maxIdx()));
    slider.value = String(clamped);
    onStep(clamped);
    updateButtonsDisabled();
  };
  function updateButtonsDisabled(){
    const i = getIdx(), m = maxIdx();
    btnPrev.disabled = (i <= 0);
    btnNext.disabled = (i >= m);
  }

  btnPrev.addEventListener('click', () => setIdx(getIdx() - 1));
  btnNext.addEventListener('click', () => setIdx(getIdx() + 1));
  slider.addEventListener('input', updateButtonsDisabled);
  setTimeout(updateButtonsDisabled, 0);

  // ←/→ キー
  document.addEventListener('keydown', (e) => {
    const tag = (e.target?.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); setIdx(getIdx() - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); setIdx(getIdx() + 1); }
  });
}
