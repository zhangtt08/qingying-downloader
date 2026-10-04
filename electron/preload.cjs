const { contextBridge, ipcRenderer } = require('electron');

// 只暴露具名方法，不暴露 ipcRenderer 本身；渲染进程拿不到 node 能力。
const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

function listener(channel, callback) {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('qingying', {
  getAppInfo: () => invoke('app:get-info'),
  readClipboard: () => invoke('clipboard:read'),

  analyze: (url, enginePreference) => invoke('media:analyze', { url, engine_preference: enginePreference }),
  writeClipboard: (text) => invoke('clipboard:write', { text }),

  // 下载一律走队列：批量、并发、暂停、重试都在主进程一处管理。
  submitQueue: (items, extra) => invoke('queue:submit', { items, ...(extra || {}) }),
  listQueue: () => invoke('queue:list'),
  pauseTask: (id) => invoke('queue:pause', { id }),
  resumeTask: (id) => invoke('queue:resume', { id }),
  retryTask: (id) => invoke('queue:retry', { id }),
  cancelTask: (id) => invoke('queue:cancel', { id }),
  removeTask: (id) => invoke('queue:remove', { id }),
  clearFinished: () => invoke('queue:clear-finished'),

  // 登录态：状态 + 登录 + 退出登录 + 导出给命令行（只回状态，绝不回 Cookie 值）
  authStatus: () => invoke('auth:status'),
  openLogin: (site) => invoke('auth:login', { site }),
  logoutSite: (site) => invoke('auth:logout', { site }),
  exportSiteCookies: (site, enabled) => invoke('auth:export', { site, enabled }),

  enginesProbe: () => invoke('engines:probe'),
  chooseEnginesDir: () => invoke('engines:choose-dir'),
  sitesList: () => invoke('sites:list'),

  // 未完成分片：看得见、能清掉（只碰 .part/.ytdl/.temp，不动成品文件）。
  scanTempFiles: (folder) => invoke('temp:scan', { folder }),
  cleanTempFiles: (folder) => invoke('temp:clean', { folder }),

  settingsGet: () => invoke('settings:get'),
  settingsSet: (patch) => invoke('settings:set', patch),
  previewTemplate: (template, sample) => invoke('template:preview', { template, sample }),

  // 本机接口的真实状态（监听成功与否、端口、令牌是否必需）——界面据此显示，不再只信文档。
  apiStatus: () => invoke('api:status'),
  onApiStatus: (callback) => listener('api:status', callback),

  historyList: () => invoke('history:list'),
  historyClear: () => invoke('history:clear'),

  chooseFolder: () => invoke('dialog:choose-folder'),
  openFolder: (folder) => invoke('folder:open', { folder }),
  revealFile: (file) => invoke('file:reveal', { file }),
  openExternal: (url) => invoke('external:open', { url }),

  onQueueChanged: (callback) => listener('queue:changed', callback),
  onAuthChanged: (callback) => listener('auth:changed', callback),
  onEnginesChanged: (callback) => listener('engines:changed', callback),

  windowControls: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggle-maximize'),
    close: () => invoke('window:close'),
    isMaximized: () => invoke('window:is-maximized'),
    onMaximizedChange: (callback) => listener('window:maximized', callback),
  },
});
