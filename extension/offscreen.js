'use strict';
/**
 * 识典古籍取图 —— 离屏文档（offscreen document）
 *
 * 存在的唯一理由：service worker 里没有 URL.createObjectURL，
 * 而 data: URL 在"下载前询问保存位置"等设置下，下载器会丢掉我们给的文件名
 * （结果存成一个叫「下载」、没有扩展名的文件）。
 *
 * 因此：在这里把图转成 PNG / JPG，生成本地 blob: 链接交给后台下载。
 * blob: 链接是标准的下载来源，文件名能正常生效。
 */

const MAX_AGE_MS = 10 * 60 * 1000; // 兜底：超过 10 分钟强制回收，防内存泄漏
const alive = new Map(); // blobUrl -> timer

function track(blobUrl) {
  const t = setTimeout(() => {
    alive.delete(blobUrl);
    URL.revokeObjectURL(blobUrl);
  }, MAX_AGE_MS);
  alive.set(blobUrl, t);
}

function revoke(blobUrl) {
  const t = alive.get(blobUrl);
  if (t) clearTimeout(t);
  alive.delete(blobUrl);
  URL.revokeObjectURL(blobUrl);
}

async function convert(srcUrl, format) {
  const res = await fetch(srcUrl);
  if (!res.ok) throw new Error('HTTP ' + res.status);

  const src = await res.blob();
  const bmp = await createImageBitmap(src);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, bmp.width, bmp.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close();

  const blob = await canvas.convertToBlob({
    type: format === 'jpg' ? 'image/jpeg' : 'image/png',
    quality: 0.92,
  });

  const blobUrl = URL.createObjectURL(blob);
  track(blobUrl);
  return { blobUrl, size: blob.size };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.type === 'convert') {
    convert(msg.srcUrl, msg.format)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }

  if (msg.type === 'revoke') {
    try {
      revoke(msg.blobUrl);
    } catch (e) {}
    sendResponse({ ok: true });
    return false;
  }
});
