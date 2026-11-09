'use strict';
/**
 * 识典古籍取图 —— 页面主世界脚本（world: MAIN）
 *
 * 隔离世界看不见页面自己的全局变量，而这里有两样东西必须从主世界拿：
 *
 *   1) window.Konva  —— 影像阅读器是 Konva 画的 canvas，图不在 DOM 里。
 *      从 Konva 节点上能精确读到"正在显示的那张图"的地址，不用靠猜。
 *   2) window._ROUTER_DATA 里的 bookInfo.bookName —— 站点自己给的书名。
 *      这个才是规范名（站点存的是简体），比读页面上的 h1 靠谱：
 *      h1 会跟着简/繁显示开关变成繁体。
 *
 * 两样都通过 postMessage 交给隔离世界（content.js）。
 */
(function () {
  let lastImg = '';
  let lastBook = '';

  function currentImage() {
    try {
      const stages = (window.Konva && window.Konva.stages) || [];
      for (const st of stages) {
        const nodes = st.find('Image');
        // 取最后一个可见的：阅读器只会显示一张
        for (let i = nodes.length - 1; i >= 0; i--) {
          const node = nodes[i];
          const img = node && node.image && node.image();
          if (!img || !img.src) continue;
          if (node.visible && !node.visible()) continue;
          return { src: img.src, w: img.naturalWidth || 0, h: img.naturalHeight || 0 };
        }
      }
    } catch (e) {
      /* Konva 还没就绪 */
    }
    return null;
  }

  /** 在 _ROUTER_DATA 里翻出 bookInfo（认 bookId + bookName 这组字段） */
  function findBookInfo(o, depth) {
    if (!o || typeof o !== 'object' || depth > 8) return null;
    if (typeof o.bookName === 'string' && o.bookName.trim() && (o.bookId || o.totalPage || o.catalog)) {
      return o;
    }
    const vals = Array.isArray(o) ? o : Object.values(o);
    for (const v of vals) {
      const hit = findBookInfo(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  }

  function bookName() {
    try {
      const info = findBookInfo(window._ROUTER_DATA, 0);
      if (info && typeof info.bookName === 'string' && info.bookName.trim()) {
        return info.bookName.trim();
      }
    } catch (e) {}
    return '';
  }

  function tick() {
    const c = currentImage();
    if (c && c.src !== lastImg) {
      lastImg = c.src;
      window.postMessage({ __sdgj: 'current', src: c.src, w: c.w, h: c.h }, '*');
    }
    const b = bookName();
    if (b && b !== lastBook) {
      lastBook = b;
      window.postMessage({ __sdgj: 'book', name: b }, '*');
    }
  }

  setInterval(tick, 700);
  setTimeout(tick, 300);
  setTimeout(tick, 2500);
})();
