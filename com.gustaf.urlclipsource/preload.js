'use strict';

const { contextBridge, ipcRenderer } = require('electron/renderer');

function invoke(channel) {
    return (...args) => ipcRenderer.invoke(channel, ...args);
}

contextBridge.exposeInMainWorld('hostAPI', {
    getBootData: invoke('api:getBootData'),
    loadVideo: invoke('api:loadVideo'),
    prepareClip: invoke('api:prepareClip'),
    cancelJob: invoke('api:cancelJob'),
    getLibrary: invoke('api:getLibrary'),
    removeClip: invoke('api:removeClip'),
    importClip: invoke('api:importClip'),
    insertClip: invoke('api:insertClip'),
    selectInMediaPool: invoke('api:selectInMediaPool'),
    getHostState: invoke('api:getHostState'),
    saveSettings: invoke('api:saveSettings'),
    probeTools: invoke('api:probeTools'),
    updateYtDlp: invoke('api:updateYtDlp'),
    getCacheStats: invoke('api:getCacheStats'),
    clearCache: invoke('api:clearCache'),
    revealFile: invoke('api:revealFile'),
    openCacheFolder: invoke('api:openCacheFolder'),
    openExternal: invoke('api:openExternal'),
    startDrag: (filePath) => ipcRenderer.send('drag:start', filePath),
    onProgress: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('job:progress', listener);
        return () => ipcRenderer.removeListener('job:progress', listener);
    },
    onLog: (callback) => {
        const listener = (_event, data) => callback(data);
        ipcRenderer.on('app:log', listener);
        return () => ipcRenderer.removeListener('app:log', listener);
    }
});
