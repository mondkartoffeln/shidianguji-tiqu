'use strict';
/**
 * 识典古籍取图 —— 后台脚本
 *
 * 做的事只有一件：把阅读器真正加载的整页原图地址记下来。
 * 阅读器的影像层是 Konva 画的 canvas，图不在 DOM 里，
 * 但图片文件本身一定会过一次网络请求 —— 所以从 webRequest 里捞最可靠。
 *
 * 记下来的地址带有站点自己签的名（x-signature），可以直接下载，不需要登录态。
 */

// ── 图片地址解析 ────────────────────────────────────────────────
// 形如：
// https://p9-ancientlib-sign.byteimg.com/tos-cn-i-ceu0di7tn2/read/CADAL02038284/1/page/1l87agpj4zgvi/1l5eoutk13uvu-3-72.webp~tplv-ceu0di7tn2-image.image?lk3s=...
//                                          └── bookId ──┘ ↑卷              ↑pageId        ↑stem=卷-页   ↑模板
const READ_RE = /\/read\/([^/]+)\/(\d+)\/page\/([^/]+)\/([^/~?]+)\.(webp|jpe?g|png)(?:~tplv-([^?]+))?/i;

/**
 * 模板优先级：image.image 是原图；png.png 是转码后的 PNG（同尺寸，体积大几倍）；
 * 其余（缩略图之类）排在最后。
 */
function templateRank(tpl) {
  if (!tpl) return 1;
  if (tpl.indexOf('image.image') !== -1) return 3;
  if (tpl.indexOf('png.png') !== -1) return 2;
  return 1;
}

function parseImageUrl(url) {
  const m = READ_RE.exec(url);
  if (!m) return null;

  const stem = m[4];
  // stem 末尾是 "-卷号-页号"，如 1l5eoutk13uvu-3-72
  const g = /-(\d+)-(\d+)$/.exec(stem);

  const objectExt = (m[5] || 'webp').toLowerCase().replace('jpeg', 'jpg');
  const tpl = m[6] || '';

  return {
    bookId: m[1],
    vol: g ? Number(g[1]) : null,
    num: g ? Number(g[2]) : null,
    pageId: m[3],
    tpl: tpl,
    rank: templateRank(tpl),
    url: url,
    // 模板是 png.png 时，服务端实际吐出来的是 PNG
    ext: tpl.indexOf('png.png') !== -1 ? 'png' : objectExt,
  };
}

// ── 按标签页存放的状态 ──────────────────────────────────────────
// { tabId, bookId, pages: { [pageId]: {pageId, vol, num, url, rank, ts} } }
const mem = new Map();

async function getState(tabId) {
  if (mem.has(tabId)) return mem.get(tabId);
  const key = 'tab:' + tabId;
  let st = null;
  try {
    const o = await chrome.storage.session.get(key);
    st = o[key] || null;
  } catch (e) {
    st = null;
  }
  if (!st) st = { tabId, bookId: '', pages: {} };
  mem.set(tabId, st);
  return st;
}

let saveTimer = null;
const dirty = new Set();

function scheduleSave(tabId) {
  dirty.add(tabId);
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const payload = {};
    for (const id of dirty) {
      const st = mem.get(id);
      if (st) payload['tab:' + id] = st;
    }
    dirty.clear();
    try {
      await chrome.storage.session.set(payload);
    } catch (e) {
      /* 存不下就算了，内存里还有 */
    }
  }, 150);
}

// ── 记录一张图 ─────────────────────────────────────────────────
async function record(tabId, url) {
  const info = parseImageUrl(url);
  if (!info) return;

  const st = await getState(tabId);
  if (info.bookId) st.bookId = info.bookId;

  const prev = st.pages[info.pageId];
  // 同一个 pageId 可能先出现缩略版、后出现原图；只保留质量最好的一次
  if (prev && prev.rank >= info.rank && prev.vol === info.vol && prev.num === info.num) {
    prev.ts = Date.now(); // 仍然刷新"最近看到的页"
    scheduleSave(tabId);
    return;
  }

  st.pages[info.pageId] = {
    pageId: info.pageId,
    vol: info.vol,
    num: info.num,
    url: info.url,
    rank: info.rank,
    ts: Date.now(),
  };
  scheduleSave(tabId);
}

// ── 监听网络：只关心图片 ────────────────────────────────────────
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    if (!/\/read\/[^/]+\/\d+\/page\//.test(details.url)) return;
    record(details.tabId, details.url);
  },
  { urls: ['*://*.byteimg.com/*'] }
);

chrome.tabs.onRemoved.addListener((tabId) => {
  mem.delete(tabId);
  dirty.delete(tabId);
  try {
    chrome.storage.session.remove('tab:' + tabId);
  } catch (e) {}
});

// ── 下载 ───────────────────────────────────────────────────────
//
// 为什么会存成「下载」这个没扩展名的名字？
//   早先 PNG / JPG 是用 data: URL 交给下载器的。data: URL 没有路径，
//   一旦浏览器在"保存位置"这一步要它自己猜名字（比如开了「下载前询问每个文件的保存位置」），
//   猜出来就是本地化的 "download" → 「下载」。
// 现在的做法：
//   1) 转换放到离屏文档里做，产出标准的 blob: 链接（有正常文件名语义）
//   2) 同时挂 downloads.onDeterminingFilename，在下载器决定文件名的最后一步
//      再压一次名字 —— 这一层连"询问保存位置"的对话框都管得到

let offscreenTask = null;

async function ensureOffscreen() {
  if (offscreenTask) return offscreenTask;
  offscreenTask = (async () => {
    try {
      if (chrome.offscreen && chrome.offscreen.hasDocument) {
        if (await chrome.offscreen.hasDocument()) return;
      }
    } catch (e) {}
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['BLOBS'],
        justification: '把整页扫描件转成 PNG / JPG，并生成本地 blob 链接供下载（service worker 里没有 URL.createObjectURL）',
      });
    } catch (e) {
      // 已经有离屏文档了，忽略
    }
  })();
  return offscreenTask;
}

/** 交给离屏文档转换，拿回 blob: 链接 */
async function convertViaOffscreen(srcUrl, format) {
  await ensureOffscreen();
  const r = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'convert', srcUrl, format });
  if (!r || !r.ok) throw new Error((r && r.error) || '转换失败');
  return r.blobUrl;
}

function revokeBlob(blobUrl) {
  if (!blobUrl) return;
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', blobUrl }).catch(() => {});
}

// url → 想要的文件名。onDeterminingFilename 在这一步把它压下去。
const wantedNames = new Map();

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const want = wantedNames.get(item.url);
  if (want) {
    wantedNames.delete(item.url);
    try {
      suggest({ filename: want, conflictAction: 'uniquify' });
      return;
    } catch (e) {
      // 名字不合法就让它走默认
    }
  }
  suggest();
});

// 下载结束后回收 blob，别一直占着内存
chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;
  const st = delta.state.current;
  if (st !== 'complete' && st !== 'interrupted') return;
  chrome.downloads.search({ id: delta.id }).then((list) => {
    const item = list && list[0];
    if (item && item.url && item.url.startsWith('blob:')) {
      wantedNames.delete(item.url);
      revokeBlob(item.url);
    }
  }).catch(() => {});
});

async function downloadAll(items, format) {
  let ok = 0;
  let fail = 0;
  const errors = [];

  for (const it of items) {
    let url = it.url;
    let blobUrl = null;

    if (format && format !== 'orig') {
      try {
        blobUrl = await convertViaOffscreen(it.url, format);
        url = blobUrl;
      } catch (e) {
        // 转不了就退回原图，别让这一页丢了
        url = it.url;
        blobUrl = null;
        if (errors.length < 3) errors.push('转换失败，已存原图：' + String((e && e.message) || e));
      }
    }

    wantedNames.set(url, it.filename);
    try {
      await chrome.downloads.download({
        url: url,
        filename: it.filename,
        conflictAction: 'uniquify',
        saveAs: false,
      });
      ok++;
    } catch (e) {
      fail++;
      wantedNames.delete(url);
      revokeBlob(blobUrl);
      if (errors.length < 3) errors.push(String((e && e.message) || e));
    }
    // 稍微隔一下，避免一次性糊太多请求过去
    await new Promise((r) => setTimeout(r, 120));
  }
  return { ok, fail, errors };
}

// ── 消息 ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = (sender && sender.tab && sender.tab.id) || (msg && msg.tabId) || -1;
  (async () => {
    try {
      if (msg && msg.type === 'state') {
        const st = await getState(tabId);
        sendResponse({ ok: true, state: st });
      } else if (msg && msg.type === 'add') {
        // 页面主世界读到的「当前显示图」—— 装扩展之前就加载好的图靠这条补录
        if (tabId >= 0 && msg.url) await record(tabId, msg.url);
        const st = await getState(tabId);
        sendResponse({ ok: true, state: st });
      } else if (msg && msg.type === 'clear') {
        mem.delete(tabId);
        await chrome.storage.session.remove('tab:' + tabId);
        sendResponse({ ok: true });
      } else if (msg && msg.type === 'download') {
        const r = await downloadAll(msg.items || [], msg.format || 'orig');
        sendResponse({ ok: true, ...r });
      } else {
        sendResponse({ ok: false, error: 'unknown message' });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String((e && e.message) || e) });
    }
  })();
  return true; // 异步响应
});

chrome.action.onClicked.addListener((tab) => {
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => {});
});
