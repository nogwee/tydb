// ===== manifest.js =====
// typhoons.json 読込、年→台風セレクト構築、Wikiリンク更新

export async function loadManifest(manifestUrl = './data/typhoons.json') {
  const res = await fetch(manifestUrl, { cache:'no-cache' });
  if (!res.ok) throw new Error(`一覧の読み込みに失敗: ${res.status}`);
  const data = await res.json();

  const byYear = new Map();
  const byId   = new Map();

  const groups = Array.isArray(data.groups) ? data.groups : [];
  for (const g of groups) {
    const yearLabel = g.label ?? 'Unknown';
    const items = Array.isArray(g.items) ? g.items : [];
    byYear.set(yearLabel, items);
    items.forEach(it => byId.set(it.id, it));
  }
  return { data, byYear, byId };
}

export function populateYearSelect(selYear, byYear) {
  selYear.innerHTML = '';
  const years = Array.from(byYear.keys()).sort((a,b)=> String(b).localeCompare(String(a),'ja'));
  years.forEach(y=>{
    const opt=document.createElement('option');
    opt.value=y; opt.textContent=y;
    selYear.appendChild(opt);
  });
}

export function populateTyphoonSelect(selTy, byYear, yearLabel) {
  selTy.innerHTML = '';
  (byYear.get(yearLabel) || []).forEach(item=>{
    const opt=document.createElement('option');
    opt.value=item.id; opt.textContent=item.name || item.id;
    selTy.appendChild(opt);
  });
}

export function updateWikiLink(anchorEl, meta){
  if (!anchorEl) return;
  if (meta?.wiki) {
    anchorEl.href = meta.wiki;
    anchorEl.style.pointerEvents = '';
    anchorEl.style.opacity = '';
  } else {
    anchorEl.removeAttribute('href');
    anchorEl.style.pointerEvents = 'none';
    anchorEl.style.opacity = '0.5';
  }
}
