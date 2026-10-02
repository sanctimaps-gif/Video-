// Bibliothèque des vidéos, sur l'appareil.
//
// Chaque vidéo terminée est rangée dans la base IndexedDB du navigateur, avec
// sa vignette, son titre, sa date, sa durée, son format et le scénario qui l'a
// produite. Rien ne quitte le téléphone : pas de serveur, pas de compte.

const DB = 'sanctimaps-studio';
const STORE = 'videos';

function request(req) {
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}

export class Library {
  constructor() { this.db = null; }

  async open() {
    if (this.db) return this.db;
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(STORE, { keyPath: 'id' });
      store.createIndex('created', 'created');
    };
    this.db = await request(req);
    return this.db;
  }

  async tx(mode, fn) {
    const db = await this.open();
    const tx = db.transaction(STORE, mode);
    const result = await fn(tx.objectStore(STORE));
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    return result;
  }

  /** Range une vidéo ; demande au navigateur de ne pas effacer la bibliothèque. */
  async add({ blob, thumb, title, seconds, aspect, codec, ext, scenario }) {
    const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const item = { id, created: Date.now(), blob, thumb: thumb || null, title: title || 'Vidéo SanctiMaps',
      seconds, aspect, codec, ext: ext || 'mp4', size: blob.size, scenario: scenario ? JSON.parse(JSON.stringify(scenario)) : null };
    await this.tx('readwrite', (s) => request(s.put(item)));
    try { await navigator.storage?.persist?.(); } catch { /* le navigateur décide */ }
    return item;
  }

  async list() {
    const all = await this.tx('readonly', (s) => request(s.getAll()));
    return all.sort((a, b) => b.created - a.created);
  }

  async get(id) { return this.tx('readonly', (s) => request(s.get(id))); }

  async rename(id, title) {
    return this.tx('readwrite', async (s) => { const item = await request(s.get(id)); if (item) { item.title = title; await request(s.put(item)); } });
  }

  async remove(id) { return this.tx('readwrite', (s) => request(s.delete(id))); }

  async usage() {
    let persisted = null, quota = null, used = null;
    try { persisted = await navigator.storage?.persisted?.(); } catch { /* inconnu */ }
    try { const e = await navigator.storage?.estimate?.(); quota = e?.quota ?? null; used = e?.usage ?? null; } catch { /* inconnu */ }
    return { persisted, quota, used };
  }
}

export function fileName(item) {
  const d = new Date(item.created);
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}h${String(d.getMinutes()).padStart(2, '0')}`;
  const slug = (item.title || 'sanctimaps').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'sanctimaps';
  return `${slug}-${stamp}.${item.ext || 'mp4'}`;
}
