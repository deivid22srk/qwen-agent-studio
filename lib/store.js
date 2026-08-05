/**
 * lib/store.js — Persistência de estado da extensão.
 *
 * Usa chrome.storage.local para metadados simples (config, atalhos, histórico
 * de tool calls recentes) e IndexedDB para guardar o FileSystemFileHandle /
 * FileSystemDirectoryHandle (a pasta de projetos que o usuário selecionou).
 *
 * Os handles NÃO podem ser serializados em JSON, então precisamos do
 * IndexedDB diretamente. O chrome.storage não os preserva.
 */

(function (global) {
  'use strict';

  const DB_NAME = 'qwen_agent_studio';
  const DB_VERSION = 1;
  const STORE_HANDLES = 'fs_handles';
  const STORE_LOG = 'tool_log';

  let _dbPromise = null;

  function openDB() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains(STORE_HANDLES)) {
          db.createObjectStore(STORE_HANDLES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_LOG)) {
          const logStore = db.createObjectStore(STORE_LOG, {
            keyPath: 'id',
            autoIncrement: true
          });
          logStore.createIndex('ts', 'ts', { unique: false });
          logStore.createIndex('session', 'session', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  async function putHandle(handle, meta = {}) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readwrite');
      const store = tx.objectStore(STORE_HANDLES);
      store.put({
        id: 'project_root',
        handle,
        name: handle.name,
        meta,
        savedAt: Date.now()
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getHandle() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readonly');
      const store = tx.objectStore(STORE_HANDLES);
      const req = store.get('project_root');
      req.onsuccess = () => resolve(req.result ? req.result : null);
      req.onerror = () => reject(req.error);
    });
  }

  async function clearHandle() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_HANDLES, 'readwrite');
      tx.objectStore(STORE_HANDLES).delete('project_root');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function appendLog(entry) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_LOG, 'readwrite');
      const store = tx.objectStore(STORE_LOG);
      store.add({
        ...entry,
        ts: Date.now()
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  async function getRecentLog(limit = 50) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_LOG, 'readonly');
      const store = tx.objectStore(STORE_LOG);
      const idx = store.index('ts');
      const results = [];
      const req = idx.openCursor(null, 'prev');
      req.onsuccess = () => {
        const cur = req.result;
        if (cur && results.length < limit) {
          results.push(cur.value);
          cur.continue();
        } else {
          resolve(results);
        }
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function clearLog() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_LOG, 'readwrite');
      tx.objectStore(STORE_LOG).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    });
  }

  // ---- chrome.storage wrappers (configs simples) ----
  async function setConfig(key, value) {
    return new Promise((resolve) => {
      const patch = {};
      patch[key] = value;
      chrome.storage.local.set(patch, () => resolve(true));
    });
  }

  async function getConfig(key, defaultValue = null) {
    return new Promise((resolve) => {
      chrome.storage.local.get([key], (res) => {
        resolve(res[key] !== undefined ? res[key] : defaultValue);
      });
    });
  }

  async function getAllConfig() {
    return new Promise((resolve) => {
      chrome.storage.local.get(null, (res) => resolve(res || {}));
    });
  }

  global.QwenStore = {
    putHandle,
    getHandle,
    clearHandle,
    appendLog,
    getRecentLog,
    clearLog,
    setConfig,
    getConfig,
    getAllConfig
  };
})(window);
