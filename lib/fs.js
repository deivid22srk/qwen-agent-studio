/**
 * lib/fs.js — Wrapper sobre a File System Access API.
 *
 * Tudo opera contra o FileSystemDirectoryHandle salvo no IndexedDB (a "pasta
 * de projetos" que o usuário escolheu no popup).
 *
 * A API é async e cada chamada precisa de permissão explícita na primeira
 * vez que a sessão é iniciada. O handle persiste entre sessões mas o
 * navegador pedirá confirmação ao usuário.
 */

(function (global) {
  'use strict';

  /**
   * Verifica/pede permissão para um handle.
   * @param {FileSystemHandle} handle
   * @param {'read'|'readwrite'} mode
   */
  async function verifyPermission(handle, mode = 'readwrite') {
    if (!handle) return false;
    const opts = { mode };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if ((await handle.requestPermission(opts)) === 'granted') return true;
    return false;
  }

  /**
   * Resolve um caminho relativo dentro da pasta de projetos.
   * @param {FileSystemDirectoryHandle} root
   * @param {string} path ex: "src/lib/utils.js"
   * @returns {Promise<{dir: FileSystemDirectoryHandle, name: string}>}
   */
  async function resolvePath(root, path) {
    if (!path) return { dir: root, name: '' };
    const clean = path.replace(/^\.?\//, '').replace(/\/$/, '');
    if (!clean) return { dir: root, name: '' };
    const parts = clean.split('/');
    const fileName = parts.pop();
    let current = root;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, { create: false });
    }
    return { dir: current, name: fileName };
  }

  /**
   * Garante que os diretórios pais de um caminho existam; cria se necessário.
   */
  async function ensureDirs(root, path) {
    const clean = path.replace(/^\.?\//, '');
    const parts = clean.split('/');
    const fileName = parts.pop();
    let current = root;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, { create: true });
    }
    return { dir: current, name: fileName };
  }

  /**
   * Lê um arquivo de texto dentro da pasta de projetos.
   */
  async function readFile(root, path) {
    const { dir, name } = await resolvePath(root, path);
    const fileHandle = await dir.getFileHandle(name);
    const file = await fileHandle.getFile();
    return await file.text();
  }

  /**
   * Lê como ArrayBuffer (para binários).
   */
  async function readFileBytes(root, path) {
    const { dir, name } = await resolvePath(root, path);
    const fileHandle = await dir.getFileHandle(name);
    const file = await fileHandle.getFile();
    return await file.arrayBuffer();
  }

  /**
   * Escreve conteúdo em um arquivo (cria se não existir).
   */
  async function writeFile(root, path, content) {
    const { dir, name } = await ensureDirs(root, path);
    const fileHandle = await dir.getFileHandle(name, { create: true });
    // createWritable está disponível em Chromium/Chrome
    const writable = await fileHandle.createWritable();
    await writable.write(content);
    await writable.close();
    return { path, bytes: typeof content === 'string' ? content.length : content.byteLength };
  }

  /**
   * Anexa conteúdo a um arquivo existente (ou cria novo).
   */
  async function appendFile(root, path, content) {
    let prev = '';
    try {
      prev = await readFile(root, path);
    } catch (_) { /* arquivo não existe ainda */ }
    return await writeFile(root, path, prev + content);
  }

  /**
   * Apaga um arquivo.
   */
  async function deleteFile(root, path) {
    const { dir, name } = await resolvePath(root, path);
    await dir.removeEntry(name);
    return { path, deleted: true };
  }

  /**
   * Apaga um diretório recursivamente.
   */
  async function deleteDir(root, path) {
    const parts = path.replace(/^\.?\//, '').replace(/\/$/, '').split('/');
    const target = parts.pop();
    let current = root;
    for (const p of parts) {
      current = await current.getDirectoryHandle(p, { create: false });
    }
    await current.removeEntry(target, { recursive: true });
    return { path, deleted: true };
  }

  /**
   * Lista o conteúdo de um diretório.
   */
  async function listDir(root, path = '.') {
    const parts = path === '.' ? [] : path.replace(/^\.?\//, '').replace(/\/$/, '').split('/').filter(Boolean);
    let current = root;
    for (const p of parts) {
      current = await current.getDirectoryHandle(p, { create: false });
    }
    const entries = [];
    for await (const [name, handle] of current.entries()) {
      entries.push({
        name,
        kind: handle.kind, // 'file' | 'directory'
        path: parts.length ? parts.join('/') + '/' + name : name
      });
    }
    entries.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return entries;
  }

  /**
   * Percorre a árvore inteira (até depth) e retorna uma lista linear.
   */
  async function tree(root, path = '.', depth = 5, currentDepth = 0, ignore = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__']) {
    if (currentDepth > depth) return [];
    const entries = await listDir(root, path);
    const out = [];
    for (const e of entries) {
      out.push({ ...e, depth: currentDepth });
      if (e.kind === 'directory' && !ignore.includes(e.name)) {
        const sub = await tree(root, e.path, depth, currentDepth + 1, ignore);
        out.push(...sub);
      }
    }
    return out;
  }

  /**
   * Busca recursiva por nome de arquivo (glob simples com *).
   */
  async function findByName(root, pattern, path = '.') {
    const all = await tree(root, path, 10);
    const re = globToRegExp(pattern);
    return all.filter((e) => re.test(e.name)).map((e) => e.path);
  }

  /**
   * Busca conteúdo em arquivos (grep simples).
   */
  async function grep(root, needle, path = '.', opts = {}) {
    const { maxResults = 200, ignoreCase = true } = opts;
    const all = await tree(root, path, 10);
    const files = all.filter((e) => e.kind === 'file');
    const results = [];
    const re = new RegExp(escapeRegExp(needle), ignoreCase ? 'i' : '');
    for (const f of files) {
      if (results.length >= maxResults) break;
      try {
        const text = await readFile(root, f.path);
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push({
              path: f.path,
              line: i + 1,
              content: lines[i].slice(0, 500)
            });
            if (results.length >= maxResults) break;
          }
        }
      } catch (_) { /* ignore binary / unreadable */ }
    }
    return results;
  }

  /**
   * Cria um diretório (recursive).
   */
  async function createDir(root, path) {
    await ensureDirs(root, path + '/.keep');
    try { await deleteFile(root, path + '/.keep'); } catch (_) {}
    return { path, created: true };
  }

  /**
   * Stats básicos de um arquivo.
   */
  async function stat(root, path) {
    const { dir, name } = await resolvePath(root, path);
    try {
      const fh = await dir.getFileHandle(name);
      const file = await fh.getFile();
      return {
        path,
        size: file.size,
        lastModified: file.lastModified,
        type: file.type || 'unknown'
      };
    } catch (_) {
      // pode ser diretório
      try {
        const parts = path.replace(/^\.?\//, '').replace(/\/$/, '').split('/').filter(Boolean);
        const target = parts.pop();
        let current = root;
        for (const p of parts) {
          current = await current.getDirectoryHandle(p, { create: false });
        }
        await current.getDirectoryHandle(target, { create: false });
        return { path, isDirectory: true };
      } catch (e) {
        throw new Error('Not found: ' + path);
      }
    }
  }

  // ---- helpers ----
  function globToRegExp(glob) {
    const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp('^' + escaped.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
  }
  function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  global.QwenFS = {
    verifyPermission,
    resolvePath,
    ensureDirs,
    readFile,
    readFileBytes,
    writeFile,
    appendFile,
    deleteFile,
    deleteDir,
    listDir,
    tree,
    findByName,
    grep,
    createDir,
    stat
  };
})(window);
