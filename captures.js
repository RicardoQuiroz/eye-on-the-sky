/**
 * Eye on the Sky — captures.js
 * Almacén PORTABLE de capturas de evidencia.
 *
 * Estrategia:
 *  • Cada captura recibe un nombre estable (cap_<fecha>_<azar>.jpg) y se registra en
 *    project.captures[nombre] = { sha256, original_sha256, mime, size, width, height, … }.
 *  • El archivo binario vive en IndexedDB (funciona en PC, Android e iPhone) y, si hay
 *    carpeta vinculada (Chrome/Edge en PC), también en capturas/ como espejo.
 *  • Para cambiar de dispositivo o entregar, se usa el PAQUETE .zip:
 *      proyecto.json + capturas/<nombre>  → al abrirlo en otro equipo, las capturas se
 *    restauran en IndexedDB y los enlaces del documento siguen vivos.
 *  • La huella SHA-256 permite comprobar que la captura que llega al docente es la
 *    misma que el estudiante adjuntó.
 */
(function (global) {
  'use strict';

  const DB_NAME = 'eots-captures';
  const STORE = 'files';
  let dbPromise = null;
  const urlCache = new Map();

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in global)) { reject(new Error('IndexedDB no disponible')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(mode, fn) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      Promise.resolve(fn(store)).then(r => { result = r; });
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  const key = (projectId, filename) => `${projectId}/${filename}`;

  async function put(projectId, filename, blob) {
    await tx('readwrite', s => { s.put(blob, key(projectId, filename)); });
    const k = key(projectId, filename);
    if (urlCache.has(k)) { URL.revokeObjectURL(urlCache.get(k)); urlCache.delete(k); }
  }

  async function get(projectId, filename) {
    try {
      return await tx('readonly', s => new Promise(res => {
        const r = s.get(key(projectId, filename));
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => res(null);
      }));
    } catch (_) { return null; }
  }

  async function has(projectId, filename) { return !!(await get(projectId, filename)); }

  async function getURL(projectId, filename) {
    const k = key(projectId, filename);
    if (urlCache.has(k)) return urlCache.get(k);
    const blob = await get(projectId, filename);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urlCache.set(k, url);
    return url;
  }

  async function sha256Hex(blobOrBuffer) {
    const buf = blobOrBuffer instanceof ArrayBuffer ? blobOrBuffer : await blobOrBuffer.arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /** Reduce la imagen a ≤ maxSide px y la comprime (JPEG 0.85) para que el paquete sea liviano. */
  async function processImage(file, maxSide = 1600) {
    const fallback = { blob: file, mime: file.type || 'image/png', width: null, height: null };
    try {
      const bitmapURL = URL.createObjectURL(file);
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = bitmapURL;
      });
      URL.revokeObjectURL(bitmapURL);
      const w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, maxSide / Math.max(w, h));
      // Imagen ya pequeña y liviana: se guarda tal cual (sin pérdida)
      if (scale === 1 && file.size < 600 * 1024) return { blob: file, mime: file.type || 'image/png', width: w, height: h };
      const cw = Math.round(w * scale), ch = Math.round(h * scale);
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
      if (!blob) return fallback;
      return { blob, mime: 'image/jpeg', width: cw, height: ch };
    } catch (_) {
      return fallback;
    }
  }

  function extFromMime(mime) {
    if (/png/.test(mime)) return 'png';
    if (/webp/.test(mime)) return 'webp';
    if (/gif/.test(mime)) return 'gif';
    return 'jpg';
  }

  function newFilename(mime) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    return `cap_${stamp}_${Math.random().toString(36).slice(2, 7)}.${extFromMime(mime)}`;
  }

  global.CaptureStore = { openDB, put, get, has, getURL, sha256Hex, processImage, newFilename, extFromMime };
})(typeof window !== 'undefined' ? window : globalThis);
