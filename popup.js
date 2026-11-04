const $ = (id) => document.getElementById(id);

let currentHost = '';

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

(async function () {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = '';
  try { url = tabs[0] ? tabs[0].url : ''; } catch (e) {}
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
      const r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'llt_rescan' });
      $('st').textContent = r ? ('已触发重扫，本页 ' + r.total + ' 张图片') : '该页面未响应（可能不支持）';
    } catch (e) {
      $('st').textContent = '该页面未响应（可能不支持）';
    }
  });

  // 询问当前页状态
  try {
    const r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'llt_state' });
    if (r) $('st').textContent = '本页 ' + r.total + ' 张图片 · ' + (r.enabled ? '增强已生效' : '已停用');
    else $('st').textContent = '本页未检测到图片';
  } catch (e) {
    $('st').textContent = '本页未注入脚本';
  }
})();
