const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('qingying', {
  getAppInfo: () => ipcRenderer.invoke('app:get-info'),
  analyze: (url) => ipcRenderer.invoke('media:analyze', { url }),
  openDouyinLogin: () => ipcRenderer.invoke('douyin:login'),
  openTiktokLogin: () => ipcRenderer.invoke('tiktok:login'),
  openBilibiliLogin: () => ipcRenderer.invoke('bilibili:login'),
  openXiaohongshuLogin: () => ipcRenderer.invoke('xiaohongshu:login'),
  openInstagramLogin: () => ipcRenderer.invoke('instagram:login'),
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  startDownload: (options) => ipcRenderer.invoke('media:download', options),
  cancelDownload: () => ipcRenderer.invoke('media:cancel'),
  openFolder: (folder) => ipcRenderer.invoke('folder:open', { folder }),
  windowControls: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
    close: () => ipcRenderer.invoke('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (callback) => {
      const handler = (_event, payload) => callback(payload);
      ipcRenderer.on('window:maximized', handler);
      return () => ipcRenderer.removeListener('window:maximized', handler);
    },
  },
  onProgress: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('media:progress', handler);
    return () => ipcRenderer.removeListener('media:progress', handler);
  },
  onDouyinLoginStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('douyin:login-status', handler);
    return () => ipcRenderer.removeListener('douyin:login-status', handler);
  },
  onTiktokLoginStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('tiktok:login-status', handler);
    return () => ipcRenderer.removeListener('tiktok:login-status', handler);
  },
  onBilibiliLoginStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('bilibili:login-status', handler);
    return () => ipcRenderer.removeListener('bilibili:login-status', handler);
  },
  onXiaohongshuLoginStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('xiaohongshu:login-status', handler);
    return () => ipcRenderer.removeListener('xiaohongshu:login-status', handler);
  },
  onInstagramLoginStatus: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('instagram:login-status', handler);
    return () => ipcRenderer.removeListener('instagram:login-status', handler);
  }
});
