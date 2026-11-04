/**
 * 懒加载终结者 — content.js  (ISOLATED world / 隔离世界)
 * ======================================================
 * 分工说明：
 *   - inject.js（MAIN world）负责拦截 IntersectionObserver —— 那是命门
 *   - 本文件负责所有 DOM 侧的活：属性提升、动态节点接管、失败重试、
 *     加载看护、HUD 统计、以及 popup 的开关与消息
 *
 * v1.1.0 相比 v1.0.0 的三处关键修复：
 *   1. 删掉此处无效的 IO 拦截（隔离世界改不到页面），改由 inject.js 在主世界做
 *   2. 新增「加载看护」循环：持续补扫 + 对加载失败的图自动重试（上限 3 次），
 *      专门治「串行加载链中间断掉、后面永远不出来」的问题
 *   3. 模拟滚动从「两个固定时间点打两枪」改为「按需节流触发」，
 *      只要还有图没加载完就会一直补，不再依赖那一瞬间的时机
 */
(function () {
  'use strict';

  if (window.__LLT_LOADED__) return;
  window.__LLT_LOADED__ = true;

  var STATE = {
    enabled: true,
    masterOn: true,
    patched: false,       // 主世界拦截是否已就位
    ioObserved: 0,        // 主世界累计拦截次数
    ioFired: 0,           // 主世界累计伪造回调次数
    processed: new WeakSet(),
    hudShown: false,
    hud: null,
    origTitle: '',
    guardTimer: 0,
    guardTicks: 0,
    lastDeepScroll: 0,
    stateSent: 0
  };

  /* ============================================================
   * 0. 站点专属小规则
   * ========================================================== */
  var SITE_RULES = {
    'reader.hipmh.top': {
      init: function () {
        try {
          if (localStorage.getItem('chapterApiLine') !== 'line2') {
            localStorage.setItem('chapterApiLine', 'line2');
          }
        } catch (e) { /* ignore */ }
      }
    }
  };
  try {
    var rule = SITE_RULES[location.hostname];
    if (rule && rule.init) rule.init();
  } catch (e) { /* ignore */ }

  /* ============================================================
   * 1. 通用懒加载属性提升
   * ========================================================== */
  var SRC_ATTRS = [
    'data-src', 'data-original', 'data-original-src', 'data-lazy-src',
    'data-lazy', 'data-echo', 'data-url', 'data-image', 'data-hi-res-src',
    'data-img', 'data-real-src', 'data-actualsrc', 'data-ks-lazyload'
  ];
  var SRCSET_ATTRS = [
    'data-srcset', 'data-lazy-srcset', 'data-original-set', 'data-src-set'
  ];
  var BG_ATTRS = ['data-background-image', 'data-bg', 'data-bg-src'];

  function looksReal(u) {
    if (!u) return false;
    if (/^data:/i.test(u)) return false;
    if (/^about:blank/i.test(u)) return false;
    if (/placeholder|blank|loading|spacer|1x1|pixel|transparent/i.test(u)) return false;
    return true;
  }

  function promote(el) {
    if (STATE.processed.has(el)) return false;
    STATE.processed.add(el);

    try {
      if (el.tagName === 'IMG' && el.getAttribute('loading') === 'lazy') {
        el.setAttribute('loading', 'eager');
      }
    } catch (e) { /* ignore */ }

    if (el.tagName === 'IMG') {
      var cur = el.getAttribute('src') || '';
      if (!looksReal(cur)) {
        for (var i = 0; i < SRC_ATTRS.length; i++) {
          var v = el.getAttribute(SRC_ATTRS[i]);
          if (looksReal(v)) { el.setAttribute('src', v); break; }
        }
      }
      for (var j = 0; j < SRCSET_ATTRS.length; j++) {
        var vs = el.getAttribute(SRCSET_ATTRS[j]);
        if (looksReal(vs) && !el.getAttribute('srcset')) {
          el.setAttribute('srcset', vs);
          break;
        }
      }
    } else if (el.tagName === 'SOURCE') {
      for (var k = 0; k < SRC_ATTRS.length; k++) {
        var vs2 = el.getAttribute(SRC_ATTRS[k]);
        if (looksReal(vs2) && !el.getAttribute('srcset')) {
          el.setAttribute('srcset', vs2);
          break;
        }
      }
    } else {
      for (var m = 0; m < BG_ATTRS.length; m++) {
        var vb = el.getAttribute(BG_ATTRS[m]);
        if (looksReal(vb) && !el.style.backgroundImage) {
          el.style.backgroundImage = 'url("' + vb + '")';
          break;
        }
      }
    }
    return true;
  }

  function scan(root) {
    var scope = (root && root.querySelectorAll) ? root : document;
    var n = 0;
    try {
      var els = scope.querySelectorAll('img, source, [data-background-image], [data-bg], [data-bg-src]');
      for (var i = 0; i < els.length; i++) {
        if (promote(els[i])) n++;
      }
    } catch (e) { /* ignore */ }
    return n;
  }

  /* ============================================================
   * 2. 加载看护：待加载统计 + 失败重试
   * ========================================================== */
  function isRealSrc(img) {
    var s = img.getAttribute('src') || '';
    if (!s) return false;
    if (/^data:/i.test(s)) return false;
    if (/^about:blank/i.test(s)) return false;
    return true;
  }

  /** 统计"还没加载成功"的真实图片数量 */
  function countPending() {
    var imgs = document.images || [];
    var n = 0;
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (!isRealSrc(img)) continue;
      if (!img.complete || img.naturalWidth === 0) n++;
    }
    return n;
  }

  /**
   * 对"已经判定失败"的图片重新发起请求。
   * 判定失败的条件：complete === true 但 naturalWidth === 0
   * （complete === false 说明还在下载中，不能动它）
   */
  function retryFailed() {
    var imgs = document.images || [];
    var n = 0;
    for (var i = 0; i < imgs.length; i++) {
      var img = imgs[i];
      if (!isRealSrc(img)) continue;
      if (!img.complete) continue;            // 还在加载
      if (img.naturalWidth > 0) continue;     // 成功

      var tries = img.__lltRetry || 0;
      if (tries >= 3) continue;               // 重试上限，避免死循环拖垮带宽

      img.__lltRetry = tries + 1;
      var s = img.getAttribute('src');
      try {
        img.removeAttribute('src');
        img.setAttribute('src', s);
        n++;
      } catch (e) { /* ignore */ }
    }
    return n;
  }

  /* ============================================================
   * 3. 模拟滚动（唤醒基于滚动位置/rect 的加载器）
   * ========================================================== */
  var userInteracted = false;
  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (ev) {
    window.addEventListener(ev, function () { userInteracted = true; }, { passive: true, capture: true });
  });

  function fireScroll() {
    try {
      window.dispatchEvent(new Event('scroll'));
      document.dispatchEvent(new Event('scroll'));
    } catch (e) { /* ignore */ }
  }

  function deepScrollScan() {
    try {
      var sx = window.scrollX, sy = window.scrollY;
      var max = Math.max(
        document.body ? document.body.scrollHeight : 0,
        document.documentElement ? document.documentElement.scrollHeight : 0
      );
      if (max <= 0) return;
      window.scrollTo(sx, max);
      fireScroll();
      setTimeout(function () {
        window.scrollTo(sx, sy);
        fireScroll();
      }, 80);
    } catch (e) { /* ignore */ }
  }

  function maybeDeepScroll(pending) {
    if (userInteracted) return;                 // 用户已经在自己滚了，别再抢滚动条
    var now = Date.now();
    if (now - STATE.lastDeepScroll < 1500) return;
    STATE.lastDeepScroll = now;
    deepScrollScan();
  }

  /* ============================================================
   * 4. MutationObserver —— 动态插入的节点立刻接管
   * ========================================================== */
  function startObserver() {
    try {
      var mo = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var r = records[i];
          if (r.type === 'attributes') {
            if (r.target && r.target.tagName === 'IMG' &&
                r.attributeName === 'loading' &&
                r.target.getAttribute('loading') === 'lazy') {
              r.target.setAttribute('loading', 'eager');
            }
            continue;
          }
          for (var j = 0; j < r.addedNodes.length; j++) {
            var node = r.addedNodes[j];
            if (node.nodeType !== 1) continue;
            if (node.tagName === 'IMG' || node.tagName === 'SOURCE') promote(node);
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
   * 5. 看护循环（核心修复点）
   *    前 30 秒每 600ms 跑一次，之后退到 2500ms 低频长期值守
   * ========================================================== */
  function guardTick() {
    STATE.guardTicks++;

    if (!document.hidden) {
      scan(document);
      retryFailed();
      var pending = countPending();
      if (pending > 0) maybeDeepScroll(pending);
      updateHud();
    }

    var interval = STATE.guardTicks <= 50 ? 600 : 2500;
    STATE.guardTimer = setTimeout(guardTick, interval);
  }

  function startGuard() {
    if (STATE.guardTimer) return;
    STATE.guardTimer = setTimeout(guardTick, 600);
  }

  /* ============================================================
   * 6. 进度 HUD
   * ========================================================== */
  function ensureHud() {
    if (STATE.hudShown) return;
    var imgs = document.images ? document.images.length : 0;
    if (imgs < 3) return;
    STATE.hudShown = true;

    var bar = document.createElement('div');
    bar.id = '__llt_bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;height:3px;background:rgba(0,0,0,.12);z-index:2147483647;pointer-events:none';

    var fill = document.createElement('div');
    fill.id = '__llt_fill';
    fill.style.cssText = 'height:100%;width:0%;background:#6366f1;transition:width .25s ease;box-shadow:0 0 6px rgba(99,102,241,.85)';
    bar.appendChild(fill);

    var txt = document.createElement('div');
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
    var all = document.images ? Array.prototype.slice.call(document.images) : [];
    var real = all.filter(function (i) { return isRealSrc(i); });
    var done = real.filter(function (i) {
      return i.complete && i.naturalWidth > 0;
    }).length;
    var pct = real.length ? Math.round((done / real.length) * 100) : 0;

    STATE.hud.fill.style.width = pct + '%';
    var tag = STATE.patched ? ' · 拦截' + STATE.ioFired : '';
    STATE.hud.txt.textContent = '图片 ' + done + '/' + real.length + ' (' + pct + '%)' + tag;

    try {
      if (!STATE.origTitle) STATE.origTitle = document.title;
      document.title = done + '/' + real.length + ' 图片加载中…';
    } catch (e) { /* ignore */ }

    if (real.length && done >= real.length) {
      restoreTitle();
      // 全部完成：先别急着撤，站点可能还会追加图片
      if (STATE.guardTicks > 3) hideHud(1200);
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
      var h = STATE.hud;
      STATE.hud = null;
      h.bar.style.transition = 'opacity .3s';
      h.txt.style.transition = 'opacity .3s';
      h.bar.style.opacity = '0';
      h.txt.style.opacity = '0';
      setTimeout(function () {
        if (h.bar.parentNode) h.bar.parentNode.removeChild(h.bar);
        if (h.txt.parentNode) h.txt.parentNode.removeChild(h.txt);
      }, 400);
    }, delay || 800);
  }

  /* ============================================================
   * 7. 与主世界（inject.js）通信
   * ========================================================== */
  function pushStateToMain() {
    try {
      window.postMessage({ __llt: 'setState', enabled: STATE.enabled && STATE.masterOn }, '*');
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || !d.__llt) return;

    if (d.__llt === 'ready') {
      STATE.patched = !!d.patched;
      pushStateToMain();
      return;
    }
    if (d.__llt === 'stats') {
      STATE.ioObserved = d.observed || 0;
      STATE.ioFired = d.fired || 0;
      if (typeof d.enabled === 'boolean') {
        STATE.patched = d.enabled;
      }
      return;
    }
  });

  // inject.js 可能在 content.js 之前/之后执行，前几秒多发几次确保它收到
  function syncStateLoop() {
    pushStateToMain();
    STATE.stateSent++;
    if (STATE.stateSent < 20) setTimeout(syncStateLoop, 250);
  }

  /* ============================================================
   * 8. 启动
   * ========================================================== */
  function boot() {
    if (!STATE.enabled || !STATE.masterOn) return;

    scan(document);
    startObserver();
    ensureHud();
    startGuard();
    syncStateLoop();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () {
        scan(document);
        fireScroll();
        updateHud();
        setTimeout(fireScroll, 800);
      });
    } else {
      fireScroll();
      setTimeout(fireScroll, 800);
    }

    window.addEventListener('load', function () {
      scan(document);
      fireScroll();
      ensureHud();
      updateHud();
    });

    // 页面从后台切回前台时立刻补一轮（很多站点此刻才会继续加载）
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        scan(document);
        retryFailed();
        updateHud();
        fireScroll();
      }
    });
  }

  /* ---------- 读开关 ---------- */
  try {
    chrome.storage.local.get(['disabledHosts', 'masterOn'], function (d) {
      if (d && typeof d.masterOn === 'boolean') STATE.masterOn = d.masterOn;
      var host = location.hostname;
      if (d && Array.isArray(d.disabledHosts) && d.disabledHosts.indexOf(host) !== -1) {
        STATE.enabled = false;
        pushStateToMain();
        return;
      }
      boot();
    });
  } catch (e) {
    boot();
  }

  /* ---------- 运行时开关 ---------- */
  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (changes.masterOn) {
        STATE.masterOn = changes.masterOn.newValue;
        if (STATE.masterOn) boot(); else hideHud(0);
        pushStateToMain();
      }
      if (changes.disabledHosts) {
        var list = changes.disabledHosts.newValue || [];
        STATE.enabled = list.indexOf(location.hostname) === -1;
        pushStateToMain();
        if (STATE.enabled) boot();
      }
    });
  } catch (e) { /* ignore */ }

  /* ---------- popup 消息 ---------- */
  try {
    chrome.runtime.onMessage.addListener(function (msg, sender, respond) {
      if (msg && msg.type === 'llt_rescan') {
        scan(document);
        var els = document.querySelectorAll('img[loading="lazy"]');
        for (var i = 0; i < els.length; i++) els[i].setAttribute('loading', 'eager');
        var revived = retryFailed();
        // 手动重扫时清掉重试计数，允许再试一轮
        var imgs = document.images || [];
        for (var k = 0; k < imgs.length; k++) imgs[k].__lltRetry = 0;
        fireScroll();
        maybeForceDeepScroll();
        updateHud();
        respond({
          ok: true,
          total: document.images.length,
          pending: countPending(),
          revived: revived,
          ioFired: STATE.ioFired,
          patched: STATE.patched
        });
      }

      if (msg && msg.type === 'llt_state') {
        respond({
          enabled: STATE.enabled,
          masterOn: STATE.masterOn,
          total: document.images ? document.images.length : 0,
          pending: countPending(),
          patched: STATE.patched,
          ioObserved: STATE.ioObserved,
          ioFired: STATE.ioFired
        });
      }
      return true;
    });
  } catch (e) { /* ignore */ }

  function maybeForceDeepScroll() {
    var guard = userInteracted;
    userInteracted = false;      // 用户手动点"重扫"时允许抢一次滚动
    STATE.lastDeepScroll = 0;
    deepScrollScan();
    setTimeout(function () { userInteracted = guard; }, 200);
  }
})();
