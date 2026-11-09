'use strict';
/**
 * 识典古籍取图 —— 页面内面板（隔离世界）
 *
 * 影像阅读器是 Konva 画的 canvas，图不在 DOM 里，右键"图片另存为"拿不到，
 * 截图又会带上阅读器底色、还只能取到屏幕上那一块。
 *
 * 这里的做法：
 *   1) main-world.js 从 window.Konva 读出"正在显示的那张图"的地址（精确，不靠猜）
 *   2) background.js 从网络请求里记下阅读器加载过的所有整页原图地址
 *   3) 面板里直接下原图 —— 整页、无背景、不用裁
 */
(function () {
  if (window.__sdgj_tiqu_injected) return;
  window.__sdgj_tiqu_injected = true;

  // ── 小工具 ───────────────────────────────────────────────────
  const $ = (sel, root) => (root || document).querySelector(sel);
  const pad3 = (n) => String(n).padStart(3, '0');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function send(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
          else resolve(res || { ok: false, error: 'no response' });
        });
      } catch (e) {
        resolve({ ok: false, error: String((e && e.message) || e) });
      }
    });
  }

  const pageIdOf = (url) => {
    const m = /\/page\/([^/]+)\//.exec(url || '');
    return m ? m[1] : null;
  };

  function safeName(s) {
    return (s || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, '').slice(0, 40) || '识典古籍';
  }

  // ── 繁 → 简 ──────────────────────────────────────────────────
  // 表由 t2s-table.js 提供（zhconv 的 zh-cn 词典，含"逐字会转错"的例外词，
  // 比如 乾隆 / 乾卦 不会被转成 干隆 / 干卦）。
  let T2S_CHARS = null;
  let T2S_PHRASES = null;
  let T2S_MAXLEN = 1;

  function initT2S() {
    if (T2S_CHARS) return true;
    const T = typeof SDGJ_T2S !== 'undefined' ? SDGJ_T2S : null;
    if (!T || !T.chars) return false;
    T2S_CHARS = new Map();
    // 必须按"码点"切，不能按字符串下标 —— 扩展区汉字（如 𠀀）占两个 UTF-16 码元，
    // 按码元切会把整串配对错位。
    const cps = Array.from(T.chars);
    for (let i = 0; i + 1 < cps.length; i += 2) T2S_CHARS.set(cps[i], cps[i + 1]);
    T2S_PHRASES = new Map(Object.entries(T.phrases || {}));
    for (const k of T2S_PHRASES.keys()) T2S_MAXLEN = Math.max(T2S_MAXLEN, Array.from(k).length);
    return true;
  }

  /** 最长匹配：先试例外词，再退回逐字 */
  function t2s(s) {
    if (!s) return s;
    if (!initT2S()) return s;
    const arr = Array.from(s); // 同样按码点处理
    const n = arr.length;
    const out = [];
    let i = 0;
    while (i < n) {
      let hit = null;
      for (let L = Math.min(T2S_MAXLEN, n - i); L >= 2; L--) {
        const frag = arr.slice(i, i + L).join('');
        if (T2S_PHRASES.has(frag)) {
          hit = [T2S_PHRASES.get(frag), L];
          break;
        }
      }
      if (hit) {
        out.push(hit[0]);
        i += hit[1];
      } else {
        out.push(T2S_CHARS.get(arr[i]) || arr[i]);
        i += 1;
      }
    }
    return out.join('');
  }

  function bookName() {
    // 优先用主世界从 _ROUTER_DATA 读到的规范书名（站点存的是简体），
    // 退化时才看页面上的 h1 —— h1 会跟着简/繁显示开关变。
    let name = bookTitle;
    if (!name) {
      const el = $('.book-title h1') || $('h1');
      name = el ? el.textContent : '';
    }
    if (!name) name = (document.title || '').split(/[-_—|]/)[0];
    return safeName(t2s((name || '').trim()));
  }

  // ── 影像阅读器的翻页控件 ─────────────────────────────────────
  const btn = (type) => document.querySelector('.vik-toolbox-btn[type="' + type + '"]');
  const curPage = () => {
    const e = $('.vik-toolbox-btn[type="page-text"] .prefix');
    const n = e ? parseInt((e.textContent || '').trim(), 10) : NaN;
    return Number.isFinite(n) ? n : null;
  };
  const totalPage = () => {
    const e = $('.vik-toolbox-btn[type="page-text"] .suffix');
    const n = e ? parseInt((e.textContent || '').replace(/[^\d]/g, ''), 10) : NaN;
    return Number.isFinite(n) ? n : null;
  };

  /** 点一下翻页，等页码变化；跳出本章则返回 false */
  async function turn(type) {
    const el = btn(type);
    if (!el) return false;
    const before = curPage();
    const href = location.href;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    for (let i = 0; i < 45; i++) {
      await sleep(100);
      if (location.href !== href) return false;
      if (curPage() !== before) return true;
    }
    return false;
  }

  // ── 界面 ─────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.id = 'sdgj-root';
  root.innerHTML = `
    <button id="sdgj-fab" type="button" title="识典古籍取图">取图</button>
    <div id="sdgj-panel" hidden>
      <div class="sdgj-head">
        <b>识典取图</b>
        <span id="sdgj-sub">已捕获 0 页</span>
        <button id="sdgj-close" type="button" title="收起">×</button>
      </div>
      <div class="sdgj-tools">
        <button type="button" data-act="toggleall">全选</button>
        <button type="button" data-act="harvest">采集整章</button>
        <select id="sdgj-fmt" title="保存格式">
          <option value="orig">原格式 WebP</option>
          <option value="png">PNG（无损）</option>
          <option value="jpg">JPG（92%）</option>
        </select>
      </div>
      <div id="sdgj-list"><div class="sdgj-empty">还没有图。<br>翻两页，或者点「采集整章」。</div></div>
      <div id="sdgj-name" class="sdgj-name"></div>
      <div class="sdgj-foot">
        <button id="sdgj-dl" type="button" class="sdgj-primary">下载选中（0）</button>
        <span id="sdgj-tip"></span>
      </div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const panel = $('#sdgj-panel');
  const list = $('#sdgj-list');
  const sub = $('#sdgj-sub');
  const tip = $('#sdgj-tip');
  const dlBtn = $('#sdgj-dl');

  let lastPages = [];
  let busy = false;
  let lastSig = '';
  let currentImg = null; // 主世界推过来的「正在显示的那张」
  let bookTitle = ''; // 主世界从 _ROUTER_DATA 读到的规范书名（简体）
  let autoSel = true; // 选择是否跟着当前页走
  let saveFmt = 'orig'; // orig | png | jpg
  let justSaved = ''; // 刚保存的文件名，显示在面板上直到用户再动一下

  const selected = new Set();

  // 格式选择记在本地，下次打开还是你上次选的
  const fmtSel = $('#sdgj-fmt');
  try {
    chrome.storage.local.get('fmt', (o) => {
      if (o && o.fmt) {
        saveFmt = o.fmt;
        fmtSel.value = o.fmt;
      }
    });
  } catch (e) {}
  fmtSel.addEventListener('change', () => {
    saveFmt = fmtSel.value;
    justSaved = '';
    try {
      chrome.storage.local.set({ fmt: saveFmt });
    } catch (e) {}
    lastSig = '';
    refresh();
  });

  function setTip(text) {
    tip.textContent = text || '';
  }

  /**
   * 文件名规则：书名_卷N_NNN.ext，例如 郁冈斋笔麈_卷3_072.png
   * 不再套子目录 —— 直接落在下载目录里。
   */
  function fileName(p, book, fmt) {
    const vol = p.vol == null ? '' : '卷' + p.vol + '_';
    const num = p.num == null ? p.pageId : pad3(p.num);
    const ext = fmt === 'png' ? 'png' : fmt === 'jpg' ? 'jpg' : p.ext || 'webp';
    return `${book}_${vol}${num}.${ext}`;
  }

  /**
   * 把「将要保存成什么名字」直接写在面板上，不用悬停才看得到。
   * 换格式、改选择都会立刻跟着变。
   */
  function updateTitle() {
    const picked = lastPages.filter((p) => selected.has(p.pageId));
    const nameEl = $('#sdgj-name');

    // 刚下完就先把"已保存"挂一会儿，等用户换选择/换格式再回到预览
    if (justSaved) {
      nameEl.textContent = justSaved;
      nameEl.title = justSaved;
      return;
    }

    if (!picked.length) {
      dlBtn.title = '选中要下载的页面';
      nameEl.textContent = '';
      nameEl.title = '';
      return;
    }

    const book = bookName();
    const first = fileName(picked[0], book, saveFmt);

    if (picked.length === 1) {
      dlBtn.title = '将保存为：' + first;
      nameEl.textContent = '文件名：' + first;
      nameEl.title = first;
    } else {
      dlBtn.title = '将保存为：' + first + `（共 ${picked.length} 个）`;
      nameEl.textContent = '文件名：' + first + ` 等 ${picked.length} 个`;
      nameEl.title = picked.map((p) => fileName(p, book, saveFmt)).join('\n');
    }
  }

  // 缩略图懒加载：整章 168 页一次性拉原图太浪费
  const io = new IntersectionObserver(
    (entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        const el = en.target;
        const thumb = el.querySelector('.sdgj-thumb');
        if (el.dataset.src && thumb) thumb.style.backgroundImage = 'url("' + el.dataset.src + '")';
        io.unobserve(el);
      }
    },
    { root: list, rootMargin: '240px 0px' }
  );

  function render(state) {
    const pages = Object.values((state && state.pages) || {});
    pages.sort((a, b) => (a.vol - b.vol) || (a.num - b.num));
    lastPages = pages;

    const ids = new Set(pages.map((p) => p.pageId));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);

    // 当前页：优先用主世界读到的真实显示图；退而求其次用「最近载入」
    let currentId = null;
    if (currentImg && ids.has(currentImg.pageId)) {
      currentId = currentImg.pageId;
    } else {
      let newest = 0;
      for (const p of pages) if (p.ts > newest) { newest = p.ts; currentId = p.pageId; }
    }

    sub.textContent = '已捕获 ' + pages.length + ' 页';
    sub.title = '书名（用于文件名）：' + bookName();

    // 跟着当前页自动选中，省一次点击
    if (autoSel && currentId && !(selected.size === 1 && selected.has(currentId))) {
      selected.clear();
      selected.add(currentId);
      lastSig = '';
    }

    const allBtn = panel.querySelector('[data-act="toggleall"]');
    if (allBtn) allBtn.textContent = pages.length && selected.size >= pages.length ? '取消选择' : '全选';

    const sig = pages.map((p) => p.pageId + ':' + p.rank).join(',') + '|' + currentId + '|' + selected.size;
    if (sig === lastSig) {
      dlBtn.textContent = '下载选中（' + selected.size + '）';
      updateTitle();
      return;
    }
    lastSig = sig;

    if (!pages.length) {
      list.innerHTML = '<div class="sdgj-empty">还没有图。<br>翻两页，或者点「采集整章」。</div>';
      dlBtn.textContent = '下载选中（0）';
      dlBtn.title = '';
      const emptyName = $('#sdgj-name');
      emptyName.textContent = '';
      emptyName.title = '';
      return;
    }

    const scrollTop = list.scrollTop;
    const frag = document.createDocumentFragment();
    for (const p of pages) {
      const card = document.createElement('div');
      card.className = 'sdgj-card' + (p.pageId === currentId ? ' sdgj-cur' : '') + (selected.has(p.pageId) ? ' sdgj-on' : '');
      card.dataset.page = p.pageId;
      card.dataset.src = p.url;
      card.title = (p.vol != null ? '卷' + p.vol + ' · ' : '') + '第 ' + (p.num == null ? '?' : p.num) + ' 页\n单击选择，双击打开原图';
      card.innerHTML = '<div class="sdgj-thumb"></div><div class="sdgj-meta"><span></span></div>';
      card.querySelector('.sdgj-meta span').textContent =
        (p.vol != null ? p.vol + '-' : '') + (p.num == null ? '?' : p.num);
      frag.appendChild(card);
    }
    list.innerHTML = '';
    list.appendChild(frag);
    list.scrollTop = scrollTop;
    for (const c of list.children) if (c.dataset && c.dataset.src) io.observe(c);

    dlBtn.textContent = '下载选中（' + selected.size + '）';
    updateTitle();
  }

  async function refresh() {
    const r = await send({ type: 'state' });
    if (r && r.ok) render(r.state);
    else setTip('后台没响应：' + (r && r.error ? r.error : '未知'));
  }

  list.addEventListener('click', (e) => {
    const card = e.target.closest('.sdgj-card');
    if (!card) return;
    autoSel = false;
    justSaved = '';
    const id = card.dataset.page;
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    card.classList.toggle('sdgj-on', selected.has(id));
    dlBtn.textContent = '下载选中（' + selected.size + '）';
    updateTitle();
  });

  list.addEventListener('dblclick', (e) => {
    const card = e.target.closest('.sdgj-card');
    if (!card) return;
    const p = lastPages.find((x) => x.pageId === card.dataset.page);
    if (p) window.open(p.url, '_blank', 'noopener');
  });

  panel.addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || busy) return;
    const act = b.dataset.act;

    if (act === 'toggleall') {
      autoSel = false;
      justSaved = '';
      if (selected.size >= lastPages.length && lastPages.length) selected.clear();
      else {
        selected.clear();
        lastPages.forEach((p) => selected.add(p.pageId));
      }
      lastSig = '';
      refresh();
    } else if (act === 'harvest') {
      await harvest();
    }
  });

  dlBtn.addEventListener('click', async () => {
    if (busy) return;
    const picked = lastPages.filter((p) => selected.has(p.pageId));
    if (!picked.length) {
      setTip('先点几个页面，或者点「全选」');
      return;
    }
    const book = bookName();
    const items = picked.map((p) => ({ url: p.url, filename: fileName(p, book, saveFmt) }));
    if (saveFmt !== 'orig' && picked.length > 20) {
      if (!confirm('要转换 ' + picked.length + ' 页为 ' + saveFmt.toUpperCase() + '，每页大约要多花 1～2 秒，确定？')) return;
    }
    setTip(saveFmt === 'orig' ? '正在交给浏览器下载…' : '正在转换并下载，慢一点…');
    const r = await send({ type: 'download', items, format: saveFmt });
    if (r && r.ok) {
      const e = r.errors && r.errors.length ? '（' + r.errors[0] + '）' : '';
      justSaved = picked.length === 1
        ? '已保存：' + items[0].filename
        : '已保存 ' + r.ok + ' 个，首个：' + items[0].filename;
      updateTitle();
      setTip('已发起 ' + r.ok + ' 个下载' + (r.fail ? '，失败 ' + r.fail : '') + e);
    } else setTip('下载失败：' + (r && r.error ? r.error : '未知'));
  });

  // ── 采集整章：用站点自己的翻页按钮走一遍 ─────────────────────
  async function harvest() {
    if (busy) return;
    if (!btn('page-next') || !btn('page-before')) {
      setTip('没找到翻页按钮：请先切到「对照」或「影像」视图');
      return;
    }
    const total = totalPage();
    if (total && total > 80) {
      const mins = Math.ceil((total * 1.3) / 60);
      if (!confirm('本章共 ' + total + ' 页，采集要一页页翻过去，大约 ' + mins + ' 分钟，期间请不要动页面。继续？')) return;
    }

    busy = true;
    try {
      const start = curPage();

      // 1) 先往回翻到本章开头
      setTip('回到本章第一页…');
      let guard = 0;
      while (curPage() && curPage() > 1 && guard++ < 2000) {
        if (!(await turn('page-before'))) break;
      }

      // 2) 再一路向后翻到末尾
      setTip('从头翻到尾，共 ' + (total || '?') + ' 页…');
      guard = 0;
      while (guard++ < 2000) {
        const now = curPage();
        if (total && now != null && now >= total) break;
        if (!(await turn('page-next'))) break;
        if (guard % 10 === 0) {
          await refresh();
          setTip('已翻到第 ' + (curPage() || '?') + ' 页 / ' + (total || '?'));
        }
      }

      // 3) 回到你原来那一页
      if (start != null) {
        let back = 0;
        while (curPage() && curPage() > start && back++ < 2000) {
          if (!(await turn('page-before'))) break;
        }
      }

      autoSel = false;
      await refresh();
      setTip('采集完成，共 ' + lastPages.length + ' 页');
    } finally {
      busy = false;
    }
  }

  // ── 主世界推过来的「当前显示图」和「规范书名」─────────────────
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d !== 'object') return;

    if (d.__sdgj === 'book' && typeof d.name === 'string' && d.name) {
      const clean = safeName(t2s(d.name.trim()));
      if (clean !== bookTitle) bookTitle = clean;
      return;
    }

    if (d.__sdgj !== 'current' || typeof d.src !== 'string') return;
    const id = pageIdOf(d.src);
    if (!id) return;
    if (currentImg && currentImg.pageId === id) return;

    currentImg = { pageId: id, src: d.src, w: d.w, h: d.h };

    if (!lastPages.some((p) => p.pageId === id)) {
      // 装扩展之前就已经加载好的图，网络里不会有，直接补一条
      send({ type: 'add', url: d.src }).then(() => refresh());
    } else {
      refresh();
    }
  });

  // ── 开关 ─────────────────────────────────────────────────────
  function show(v) {
    panel.hidden = !v;
    if (v) {
      autoSel = true;
      lastSig = '';
      refresh();
    }
  }

  $('#sdgj-fab').addEventListener('click', () => show(panel.hidden));
  $('#sdgj-close').addEventListener('click', () => show(false));

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'toggle-panel') show(panel.hidden);
  });

  // 面板开着时定期同步（SPA 换章也不会丢）
  setInterval(() => {
    if (!panel.hidden && !busy) refresh();
  }, 2500);

  // 自我检查：繁简表没加载的话，书名会按原样使用，先留一句提示
  if (!initT2S()) {
    console.warn('[识典取图] 繁简转换表 t2s-table.js 没加载上，书名将按原样使用');
  }
})();
