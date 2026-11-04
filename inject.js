/**
 * 懒加载终结者 — inject.js  (MAIN world / 页面主世界)
 * ====================================================
 * 这是整个方案的命门。
 *
 * MV3 的普通 content script 运行在「隔离世界」，它改 window 上的任何东西，
 * 页面自己的 JS 都看不见。所以拦截 IntersectionObserver 必须注入主世界。
 * manifest 里通过 "world": "MAIN" 声明本文件，run_at: document_start，
 * 保证在页面任何脚本执行之前完成替换。
 *
 * 本文件不依赖任何 chrome.* API（MAIN world 里也没有），
 * 与 content.js 之间通过 window.postMessage 通信。
 */
(function () {
  'use strict';

  if (window.__LLT_MAIN__) return;
  window.__LLT_MAIN__ = true;

  var NativeIO = window.IntersectionObserver;
  if (!NativeIO) return;

  /* ---------- 与 content.js 的状态同步 ---------- */
  var STATE = {
    enabled: true,   // 默认拦截；content.js 若发现本站在黑名单会通知关闭
    observed: 0,     // 累计被拦截的 observe 次数
    fired: 0,        // 累计伪造回调次数
    queue: 0         // 错峰计数器
  };

  // 每 300ms 往页面广播一次统计，content.js 靠它给 HUD 提供诊断数据
  function report() {
    try {
      window.postMessage({
        __llt: 'stats',
        observed: STATE.observed,
        fired: STATE.fired,
        enabled: STATE.enabled
      }, '*');
    } catch (e) { /* ignore */ }
  }
  setInterval(report, 300);

  window.addEventListener('message', function (e) {
    if (e.source !== window) return;
    var d = e.data;
    if (!d || d.__llt !== 'setState') return;
    if (typeof d.enabled === 'boolean') STATE.enabled = d.enabled;
  });

  /* ---------- 伪造一条"已相交"的回调条目 ---------- */
  function fakeRect(target) {
    var w = 1, h = 1;
    try {
      var r = target.getBoundingClientRect();
      w = r.width || target.offsetWidth || 1;
      h = r.height || target.offsetHeight || 1;
    } catch (e) {
      w = target.offsetWidth || 1;
      h = target.offsetHeight || 1;
    }
    return { x: 0, y: 0, left: 0, top: 0, right: w, bottom: h, width: w, height: h };
  }

  function makeEntry(target) {
    var rect = fakeRect(target);
    return {
      target: target,
      isIntersecting: true,
      intersectionRatio: 1,
      boundingClientRect: rect,
      intersectionRect: rect,
      rootBounds: rect,
      time: (window.performance && performance.now) ? performance.now() : Date.now()
    };
  }

  /* ---------- 替换构造函数 ---------- */
  function PatchedIO(callback, options) {
    this._cb = callback;
    this._opts = options || {};
    this._targets = new Set();
    this._native = null;

    var self = this;
    try {
      // 保留一个真身：一旦用户关掉增强，立刻退回原生行为
      this._native = new NativeIO(function (entries, obs) {
        if (STATE.enabled) return;              // 拦截开启时丢弃原生结果
        try { self._cb(entries, obs); } catch (e) { /* ignore */ }
      }, this._opts);
    } catch (e) {
      this._native = null;
    }
  }

  PatchedIO.prototype = {
    get root() { return this._native ? this._native.root : null; },
    get rootMargin() { return this._native ? this._native.rootMargin : '0px'; },
    get thresholds() { return this._native ? this._native.thresholds : [0]; },

    observe: function (target) {
      if (!target) return;
      this._targets.add(target);

      if (!STATE.enabled) {
        try { this._native && this._native.observe(target); } catch (e) { /* ignore */ }
        return;
      }

      var self = this;
      STATE.observed++;
      STATE.queue++;

      // ★ 关键：错峰触发，模拟"元素依次进入视口"。
      // 站点普遍是「上一张加载完 → observe 下一张」的串行链，
      // 若同一 tick 内把 86 个元素一次性全回调，站点的序号/计数逻辑会乱，
      // 轻则顺序错乱，重则整条链直接卡死。
      var delay = Math.min(STATE.queue * 6, 260);

      setTimeout(function () {
        if (!self._targets.has(target)) return;   // 期间被 unobserve 了
        if (!STATE.enabled) {
          try { self._native && self._native.observe(target); } catch (e) { /* ignore */ }
          return;
        }
        STATE.fired++;
        try {
          self._cb([makeEntry(target)], self);
        } catch (e) { /* 站点回调自己报错与我们无关 */ }
      }, delay);
    },

    unobserve: function (target) {
      this._targets.delete(target);
      try { this._native && this._native.unobserve(target); } catch (e) { /* ignore */ }
    },

    disconnect: function () {
      this._targets.clear();
      try { this._native && this._native.disconnect(); } catch (e) { /* ignore */ }
    },

    takeRecords: function () {
      try { return this._native ? this._native.takeRecords() : []; } catch (e) { return []; }
    }
  };

  try {
    Object.defineProperty(PatchedIO, 'name', { value: 'IntersectionObserver' });
  } catch (e) { /* ignore */ }

  try {
    window.IntersectionObserver = PatchedIO;
  } catch (e) { /* ignore */ }

  // 广播一次"已就位"，content.js 收到后可提示用户
  try {
    window.postMessage({ __llt: 'ready', patched: window.IntersectionObserver === PatchedIO }, '*');
  } catch (e) { /* ignore */ }
})();
