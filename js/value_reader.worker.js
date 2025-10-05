// public/js/value_reader.worker.js
// 仕様: RG=UInt16（R=上位, G=下位）, 65535=NoData, 実値 = u16 * SCALE[kind]
// ピクセル単点サンプル。A==0 は常に NoData とみなす（透明→色が0に潰れる対策）。

const NODATA_U16 = 65535;
const SCALE = { precip: 0.1, gust: 0.1 };
const MODE  = 'RG16_BE';   // 'RG16_BE' | 'GRAY8' | 'G_ONLY' | 'MAX_RGB'

async function fetchBitmap(url) {
  // ★ キャッシュ完全無効化
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return { ok:false, status:res.status, bmp:null };
  const blob = await res.blob();
  // 透明画素の色成分が潰れないように（対応環境で有効）
  const opts = { colorSpaceConversion: 'none', premultiplyAlpha: 'none' };
  let bmp;
  try { bmp = await createImageBitmap(blob, opts); }
  catch { bmp = await createImageBitmap(blob); } // 後方互換
  return { ok:true, status:res.status, bmp };
}

function u16FromRGBA(r, g, b, a) {
  if (a === 0) return NODATA_U16; // 透明はNoData扱い
  switch (MODE) {
    case 'RG16_BE': return (r << 8) | g;  // R=高位, G=低位
    case 'G_ONLY':  return g;
    case 'GRAY8':   return r;             // R=G=B 前提
    case 'MAX_RGB': return Math.max(r, g, b);
    default:        return (r << 8) | g;
  }
}

function samplePixelExact(bmp, x, y) {
  const oc  = new OffscreenCanvas(bmp.width, bmp.height);
  // ★ サイズ設定→コンテキスト生成→描画（順序大事：サイズ設定でクリアされるため）
  oc.width = bmp.width; oc.height = bmp.height;
  const ctx = oc.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0);

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v|0));
  const sx = clamp(x, 0, bmp.width  - 1);
  const sy = clamp(y, 0, bmp.height - 1);

  const { data } = ctx.getImageData(sx, sy, 1, 1);
  const r = data[0], g = data[1], b = data[2], a = data[3];
  const u16 = u16FromRGBA(r, g, b, a);
  return { u16, r, g, b, a, sx, sy, w:bmp.width, h:bmp.height };
}

async function readVal(url, x, y, scale) {
  try {
    const r = await fetchBitmap(url);
    if (!r.ok) return NaN;
    const s = samplePixelExact(r.bmp, x, y);
    return (s.u16 === NODATA_U16) ? NaN : s.u16 * scale;
  } catch {
    return NaN;
  }
}

self.onmessage = async (e) => {
  const { kind, scale, stamps, x, y, baseUrl } = e.data;

  // ★ scaleの安全化：未定義/0/NaN/負はフォールバック
  const sc = (typeof scale === 'number' && isFinite(scale) && scale > 0)
    ? scale
    : (typeof SCALE[kind] === 'number' && isFinite(SCALE[kind]) && SCALE[kind] > 0 ? SCALE[kind] : 1.0);

  try {
    const prefix = (kind === 'precip') ? 'precip' : kind;
    // ★ キャッシュバスター付与（開発中の更新取りこぼし防止）
    const bust = Date.now();
    const urls = stamps.map(s => `${baseUrl}/value_png/${kind}/${prefix}_${s}.png?t=${bust}`);

    // 診断（先頭1枚）
    let diag = null;
    if (urls.length > 0) {
      const url0 = urls[0];
      const r0 = await fetchBitmap(url0);
      if (r0.ok) {
        const s0 = samplePixelExact(r0.bmp, x, y);
        const val0 = (s0.u16 === NODATA_U16) ? NaN : s0.u16 * sc;
        diag = {
          firstUrl: url0,
          status: 200,
          wh: { w: s0.w, h: s0.h },
          px: { xOrig: x, yOrig: y, x: s0.sx, y: s0.sy },
          rgba: { r: s0.r, g: s0.g, b: s0.b, a: s0.a },
          u16: s0.u16,
          val: Number.isFinite(val0) ? val0 : null,
          sc,                      // ★ 何を掛けたかも確認
          mode: MODE,
          note: "alpha==0→NoData扱い, fetch=no-store, cache-busted"
        };
      } else {
        diag = { firstUrl: url0, status: r0.status };
      }
    }

    const vals = await Promise.all(urls.map(u => readVal(u, x, y, sc)));
    self.postMessage({ ok: true, values: vals, diag });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
