/**
 * 懒加载终结者 (LazyLoad Terminator) — 通用版
 *
 * 原理：绝大多数网页懒加载（原生 loading="lazy"、lazysizes、lozad、
 * 以及各种自研 IntersectionObserver 方案）都靠 "元素进入视口才加载" 实现。
 * 我们在 document_start 阶段拦截 IntersectionObserver，让 observe() 的目标
 * 立刻被判定为 "已相交"，于是所有图片一次性开始下载。
 *
 * 另外并行处理：
 *   - 移除 loading="lazy" 属性（关闭原生懒加载）
 *   - 提升 data-src / data-original 等通用懒加载属性
 *   - MutationObserver 持续接管动态插入的图片
 *   - 补发 scroll 事件，唤醒基于滚动位置的加载器
 *
 * 不绑定任何具体站点。
 */
(function () {
  'use strict';

  if (window.__LLT_LOADED__) return;
  window.__LLT_LOADED__ = true;

  const STATE = {
    enabled: true,       // 由 popup 的站点开关控制
    masterOn: true,      // 由 popup 的全局开关控制
    processed: new WeakSet(),
    hudShown: false,
    hudTimer: 0
  };

  /* ============================================================
   * 站点专属小规则（可选增强，不影响通用性）
   * ========================================================== */
  const SITE_RULES = {
    'reader.hipmh.top': {
      // 该站默认走腾讯节点（单张约 12s），切到 Cloudflare 约 1.2s
      init() {
        try {
          if (localStorage.getItem('chapterApiLine') !== 'line2') {
            localStorage.setItem('chapterApiLine', 'line2');
          }
        } catch (e) { /* ignore */ }
      }
    }
  };
  try {
    const rule = SITE_RULES[location.hostname];
    if (rule && rule.init) rule.init();
  } catch (e) { /* ignore */ }

  /* ============================================================
   * 1. 拦截 IntersectionObserver —— 核心手段
   * ========================================================== */
  const NativeIO = window.IntersectionObserver;

  function makeEntry(target, opts) {
    const w = target.offsetWidth || (target.getBoundingClientRect().width) || 1;
    const h = target.offsetHeight || (target.getBoundingClientRect().height) || 1;
    // 把元素伪装成 "正好在视口内"，兼容那些不只看 isIntersecting 的库
    const rect = {
      x: 0, y: 0, left: 0, top: 0,
      right: w, bottom: h, width: w, height: h
    };
    return {
      target: target,
      isIntersecting: true,
      intersectionRatio: 1,
      boundingClientRect: rect,
      intersectionRect: rect,
      rootBounds: rect,
      time: performance.now()
    };
  }

  if (NativeIO) {
    function PatchedIO(callback, options) {
      this._cb = callback;
      this._opts = options || {};
      this._targets = new Set();
      const self = this;
      this._native = new NativeIO(function (entries, obs) {
        // 仅在"被禁用"时才走原生结果
        if (STATE.enabled) return;
        self._cb(entries, obs);
      }, this._opts);
    }

    PatchedIO.prototype = {
      get root() { return this._native.root; },
      get rootMargin() { return this._native.rootMargin; },
      get thresholds() { return this._native.thresholds; },
      observe(target) {
        this._targets.add(target);
        if (!STATE.enabled) {
          this._native.observe(target);
          return;
        }
        // 立刻回调，伪装成已相交
        const self = this;
        setTimeout(function () {
          if (!self._targets.has(target)) return;
          try {
            self._cb([makeEntry(target, self._opts)], self);
          } catch (e) { /* ignore */ }
        }, 0);
      },
      unobserve(target) {
        this._targets.delete(target);
        try { this._native.unobserve(target); } catch (e) { /* ignore */ }
      },
      disconnect() {
        this._targets.clear();
        try { this._native.disconnect(); } catch (e) { /* ignore */ }
      },
      takeRecords() { return []; }
    };

    try {
      Object.defineProperty(PatchedIO, 'name', { value: 'IntersectionObserver' });
      window.IntersectionObserver = PatchedIO;
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
   * 2. 通用懒加载属性提升
   * ========================================================== */
  const SRC_ATTRS = [
    'data-src', 'data-original', 'data-original-src', 'data-lazy-src',
    'data-lazy', 'data-echo', 'data-url', 'data-image', 'data-hi-res-src',
    'data-img', 'data-real-src'
  ];
  const SRCSET_ATTRS = [
    'data-srcset', 'data-lazy-srcset', 'data-original-set', 'data-src-set'
  ];
  const BG_ATTRS = ['data-background-image', 'data-bg', 'data-bg-src'];

  function looksReal(u) {
    if (!u) return false;
    if (/^data:/i.test(u)) return false;
    if (/^about:blank/i.test(u)) return false;
    if (/placeholder|blank|loading|spacer|1x1|pixel/i.test(u)) return false;
    return true;
  }

  function promote(el) {
    if (STATE.processed.has(el)) return false;
    STATE.processed.add(el);

    // 原生懒加载 -> eager
    try {
      if (el.tagName === 'IMG' && el.getAttribute('loading') === 'lazy') {
        el.setAttribute('loading', 'eager');
      }
    } catch (e) { /* ignore */ }

    if (el.tagName === 'IMG') {
      const cur = el.getAttribute('src') || '';
      // 只有当当前 src 不是真实地址时，才用 data-* 提升
      if (!looksReal(cur)) {
        for (let i = 0; i < SRC_ATTRS.length; i++) {
          const v = el.getAttribute(SRC_ATTRS[i]);
          if (looksReal(v)) { el.setAttribute('src', v); break; }
        }
      }
      for (let i = 0; i < SRCSET_ATTRS.length; i++) {
        const v = el.getAttribute(SRCSET_ATTRS[i]);
        if (looksReal(v) && !el.getAttribute('srcset')) {
          el.setAttribute('srcset', v);
          break;
        }
      }
    } else if (el.tagName === 'SOURCE') {
      for (let i = 0; i < SRC_ATTRS.length; i++) {
        const v = el.getAttribute(SRC_ATTRS[i]);
        if (looksReal(v) && !el.getAttribute('srcset')) {
          el.setAttribute('srcset', v);
          break;
        }
      }
    } else {
      for (let i = 0; i < BG_ATTRS.length; i++) {
        const v = el.getAttribute(BG_ATTRS[i]);
        if (looksReal(v) && !el.style.backgroundImage) {
          el.style.backgroundImage = 'url("' + v + '")';
          break;
        }
      }
    }
    return true;
  }

  function scan(root) {
    const scope = root && root.querySelectorAll ? root : document;
    let n = 0;
    try {
      const imgs = scope.querySelectorAll('img, source, [data-background-image], [data-bg], [data-bg-src]');
      for (let i = 0; i < imgs.length; i++) {
        if (promote(imgs[i])) n++;
      }
    } catch (e) { /* ignore */ }
    return n;
  }

  /* ============================================================
   * 3. MutationObserver —— 持续接管动态插入的图片
   * ========================================================== */
  function startObserver() {
    try {
      const mo = new MutationObserver(function (records) {
        for (let i = 0; i < records.length; i++) {
          const r = records[i];
          if (r.type === 'attributes') {
            if (r.target && r.target.tagName === 'IMG' &&
                r.attributeName === 'loading' && r.target.getAttribute('loading') === 'lazy') {
              r.target.setAttribute('loading', 'eager');
            }
            continue;
          }
          for (let j = 0; j < r.addedNodes.length; j++) {
            const node = r.addedNodes[j];
            if (node.nodeType !== 1) continue;
            if (node.tagName === 'IMG' || node.tagName === 'SOURCE') {
              promote(node);
            }
            scan(node);
          }
        }
      });
      mo.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['loading']
      });
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
   * 4. 补发 scroll 事件 + 深度滚动扫描
   *    —— 唤醒基于滚动位置的加载器（它们检查 getBoundingClientRect）
   * ========================================================== */
  function fireScroll() {
    try {
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
      window.scrollTo(window.scrollX, window.scrollY);
    } catch (e) { /* ignore */ }
  }

  // 用户主动交互过就不再自动深滚，避免打断阅读
  let userInteracted = false;
  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (ev) {
    window.addEventListener(ev, function () { userInteracted = true; }, { passive: true, capture: true });
  });

  /**
   * 深度滚动扫描：
   * 有些加载器只在真实滚动到元素位置时才加载（不依赖 IntersectionObserver）。
   * 这里把 scrollTop 瞬间推到文档底部再还原，骗它们"全部进入视口"。
   * 只在页面刚打开、用户尚未交互时执行，避免干扰正常阅读。
   */
  function deepScrollScan() {
    try {
      if (userInteracted) return;
      const imgs = [].slice.call(document.images);
      const pending = imgs.filter(function (i) { return !i.complete || !i.naturalWidth; });
      if (!pending.length) return;

      const sx = window.scrollX, sy = window.scrollY;
      const max = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      );
      window.scrollTo(sx, max);
      fireScroll();
      setTimeout(function () {
        window.scrollTo(sx, sy);
        fireScroll();
      }, 80);
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
   * 5. 进度 HUD
   * ========================================================== */
  function ensureHud() {
    if (STATE.hudShown) return;
    const imgs = document.images ? document.images.length : 0;
    if (imgs < 3) return;
    STATE.hudShown = true;

    const bar = document.createElement('div');
    bar.id = '__llt_bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:3px;background:rgba(0,0,0,.12);z-index:2147483647;pointer-events:none';

    const fill = document.createElement('div');
    fill.id = '__llt_fill';
    fill.style.cssText = 'height:100%;width:0%;background:#6366f1;transition:width .25s ease;box-shadow:0 0 6px rgba(99,102,241,.85)';
    bar.appendChild(fill);

    const txt = document.createElement('div');
    txt.id = '__llt_text';
    txt.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;background:rgba(17,24,39,.9);color:#fff;font:12px/1.6 system-ui,-apple-system,sans-serif;padding:5px 10px;border-radius:6px;pointer-events:none;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.3)';
    txt.textContent = '预加载图片中…';

    (document.documentElement || document.body).appendChild(bar);
    (document.documentElement || document.body).appendChild(txt);

    STATE.hud = { bar: bar, fill: fill, txt: txt };
    updateHud();
  }

  function updateHud() {
    if (!STATE.hud) return;
    const all = document.images ? Array.prototype.slice.call(document.images) : [];
    // 排除 data: 占位图与空 src（不限于 http，兼容 file:// 与其他协议）
    const real = all.filter(function (i) {
      const s = i.getAttribute('src') || i.src || '';
      return s && !/^data:/i.test(s) && !/^about:blank/i.test(s);
    });
    const done = real.filter(function (i) {
      return i.complete && i.naturalWidth > 0;
    }).length;
    const pct = real.length ? Math.round((done / real.length) * 100) : 0;
    STATE.hud.fill.style.width = pct + '%';
    STATE.hud.txt.textContent = '图片预加载 ' + done + '/' + real.length + ' (' + pct + '%)';
    try {
      if (!STATE.origTitle) STATE.origTitle = document.title;
      document.title = done + '/' + real.length + ' 图片加载中…';
    } catch (e) { /* ignore */ }

    if (real.length && done >= real.length) {
      clearInterval(STATE.hudTimer);
      STATE.hudTimer = 0;
      restoreTitle();
      hideHud(1000);
    }
  }

  function restoreTitle() {
    try {
      if (STATE.origTitle) {
        document.title = STATE.origTitle;
        STATE.origTitle = '';
      }
    } catch (e) { /* ignore */ }
  }

  function hideHud(delay) {
    setTimeout(function () {
      restoreTitle();
      if (!STATE.hud) return;
      STATE.hud.bar.style.transition = 'opacity .3s';
      STATE.hud.txt.style.transition = 'opacity .3s';
      STATE.hud.bar.style.opacity = '0';
      STATE.hud.txt.style.opacity = '0';
      setTimeout(function () {
        if (STATE.hud) {
          if (STATE.hud.bar.parentNode) STATE.hud.bar.parentNode.removeChild(STATE.hud.bar);
          if (STATE.hud.txt.parentNode) STATE.hud.txt.parentNode.removeChild(STATE.hud.txt);
        }
        STATE.hud = null;
      }, 400);
    }, delay || 800);
  }

  /* ============================================================
   * 6. 启动流程
   * ========================================================== */
  function boot() {
    if (!STATE.enabled || !STATE.masterOn) return;

    scan(document);
    startObserver();
    ensureHud();
    STATE.hudTimer = setInterval(updateHud, 500);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        scan(document);
        fireScroll();
        setTimeout(fireScroll, 800);
        setTimeout(function () { deepScrollScan(); }, 400);
        setTimeout(function () { deepScrollScan(); }, 1600);
      });
    } else {
      fireScroll();
      setTimeout(fireScroll, 800);
      setTimeout(function () { deepScrollScan(); }, 400);
    }
    window.addEventListener('load', function () {
      scan(document);
      fireScroll();
      setTimeout(function () { deepScrollScan(); }, 600);
    });
  }

  // 读取 popup 的开关设置
  try {
    chrome.storage.local.get(['disabledHosts', 'masterOn'], function (d) {
      if (d && typeof d.masterOn === 'boolean') STATE.masterOn = d.masterOn;
      const host = location.hostname;
      if (d && Array.isArray(d.disabledHosts) && d.disabledHosts.indexOf(host) !== -1) {
        STATE.enabled = false;
        return;
      }
      boot();
    });
  } catch (e) {
    boot();
  }

  // 运行时开关变化
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.masterOn) {
        STATE.masterOn = changes.masterOn.newValue;
        if (STATE.masterOn) boot(); else hideHud(0);
      }
      if (changes.disabledHosts) {
        const list = changes.disabledHosts.newValue || [];
        const host = location.hostname;
        STATE.enabled = list.indexOf(host) === -1;
      }
    });
  } catch (e) { /* ignore */ }

  // 供 popup 调用：立即重扫并强制加载
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
      if (msg && msg.type === 'llt_rescan') {
        scan(document);
        document.querySelectorAll('img[loading="lazy"]').forEach(function (i) {
          i.setAttribute('loading', 'eager');
        });
        fireScroll();
        updateHud();
        respond({ ok: true, total: document.images.length });
      }
      if (msg && msg.type === 'llt_state') {
        respond({
          enabled: STATE.enabled,
          masterOn: STATE.masterOn,
          total: document.images ? document.images.length : 0
        });
      }
      return true;
    });
  } catch (e) { /* ignore */ }
})();
