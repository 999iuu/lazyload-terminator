const $ = (id) => document.getElementById(id);

let currentHost = '';
let currentTabId = null;

function render(masterOn, disabledHosts) {
  const swM = $('swMaster');
  swM.classList.toggle('on', masterOn !== false);
  const siteOff = disabledHosts.indexOf(currentHost) !== -1;
  const swH = $('swHost');
  swH.classList.toggle('on', !siteOff);
}

function bind(el, get, set) {
  el.addEventListener('click', function () {
    const on = el.classList.contains('on');
    set(!on);
    render(get().masterOn, get().disabledHosts);
  });
}

function showDiag(state) {
  const el = $('diag');
  if (!state) {
    el.className = 'diag bad';
    el.textContent = '主世界拦截：未注入（刷新本页后生效）';
    return;
  }
  if (state.patched) {
    el.className = 'diag ok';
    el.textContent = '主世界拦截：已生效 · 已触发 ' + (state.ioFired || 0) + ' 个元素';
  } else {
    el.className = 'diag bad';
    el.textContent = '主世界拦截：未生效（页面可能未刷新，或浏览器版本过低）';
  }
}

(async function () {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = '';
  try { url = tabs[0] ? tabs[0].url : ''; } catch (e) {}
  currentTabId = tabs[0] ? tabs[0].id : null;
  try { currentHost = new URL(url).hostname; } catch (e) { currentHost = '(无)'; }
  $('host').textContent = currentHost;

  let data = { masterOn: true, disabledHosts: [] };
  async function load() {
    data = await chrome.storage.local.get(['masterOn', 'disabledHosts']);
    if (typeof data.masterOn !== 'boolean') data.masterOn = true;
    if (!Array.isArray(data.disabledHosts)) data.disabledHosts = [];
    return data;
  }
  async function save() {
    await chrome.storage.local.set({ masterOn: data.masterOn, disabledHosts: data.disabledHosts });
  }

  await load();
  render(data.masterOn, data.disabledHosts);

  bind($('swMaster'), () => data, (v) => { data.masterOn = v; save(); });
  bind($('swHost'), () => data, (v) => {
    const i = data.disabledHosts.indexOf(currentHost);
    if (v && i === -1) data.disabledHosts.push(currentHost);
    if (!v && i !== -1) data.disabledHosts.splice(i, 1);
    save();
  });

  $('rescan').addEventListener('click', async function () {
    try {
      const r = await chrome.tabs.sendMessage(currentTabId, { type: 'llt_rescan' });
      if (r) {
        $('st').textContent = '已重扫：共 ' + r.total + ' 张，仍待加载 ' + (r.pending || 0) + ' 张';
        showDiag(r);
      } else {
        $('st').textContent = '该页面未响应（可能不支持）';
      }
    } catch (e) {
      $('st').textContent = '该页面未响应（刷新本页后重试）';
    }
  });

  // 询问当前页状态
  try {
    const r = await chrome.tabs.sendMessage(currentTabId, { type: 'llt_state' });
    if (r) {
      $('st').textContent = '本页 ' + r.total + ' 张图片 · ' +
        (r.enabled ? '增强已生效' : '已停用') +
        (r.pending ? ' · 待加载 ' + r.pending + ' 张' : '');
      showDiag(r);
    } else {
      $('st').textContent = '本页未检测到图片';
      showDiag(null);
    }
  } catch (e) {
    $('st').textContent = '本页未注入脚本';
    showDiag(null);
  }
})();
