const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tc', {
  platform: process.platform,
  window: {
    minimize: () => ipcRenderer.invoke('win:minimize'),
    maximize: () => ipcRenderer.invoke('win:maximize'),
    close: () => ipcRenderer.invoke('win:close'),
    isMaximized: () => ipcRenderer.invoke('win:isMaximized'),
    onMaximize: (fn) => {
      const l = (_e, v) => fn(v);
      ipcRenderer.on('win:maximized', l);
      return () => ipcRenderer.removeListener('win:maximized', l);
    },
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (name) => ipcRenderer.invoke('projects:create', name),
    rename: (id, name) => ipcRenderer.invoke('projects:rename', id, name),
    delete: (id) => ipcRenderer.invoke('projects:delete', id),
    load: (id) => ipcRenderer.invoke('projects:load', id),
    save: (id, data) => ipcRenderer.invoke('projects:save', id, data),
    openFile: () => ipcRenderer.invoke('projects:openFile'),
    pickDir: (title) => ipcRenderer.invoke('projects:pickDir', title),
    pickFile: () => ipcRenderer.invoke('projects:pickFile'),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (s) => ipcRenderer.invoke('settings:set', s),
  },
  pty: {
    spawn: (opts) => ipcRenderer.invoke('pty:spawn', opts),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('pty:kill', id),
    which: (probes) => ipcRenderer.invoke('pty:which', probes),
    onData: (fn) => {
      const l = (_e, id, data) => fn(id, data);
      ipcRenderer.on('pty:data', l);
      return () => ipcRenderer.removeListener('pty:data', l);
    },
    onExit: (fn) => {
      const l = (_e, id, code) => fn(id, code);
      ipcRenderer.on('pty:exit', l);
      return () => ipcRenderer.removeListener('pty:exit', l);
    },
  },
  clip: {
    copy: (text) => ipcRenderer.invoke('term:copy', text),
    paste: () => ipcRenderer.invoke('term:paste'),
  },
  system: {
    accent: () => ipcRenderer.invoke('system:accent'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    onAccentChanged: (fn) => {
      const l = (_e, v) => fn(v);
      ipcRenderer.on('system:accent-changed', l);
      return () => ipcRenderer.removeListener('system:accent-changed', l);
    },
  },
  app: {
    version: () => ipcRenderer.invoke('app:version'),
  },
  updater: {
    check: () => ipcRenderer.invoke('updater:check'),
    quitInstall: () => ipcRenderer.invoke('updater:quitInstall'),
    onStatus: (fn) => {
      const l = (_e, s) => fn(s);
      ipcRenderer.on('updater:status', l);
      return () => ipcRenderer.removeListener('updater:status', l);
    },
  },
});
