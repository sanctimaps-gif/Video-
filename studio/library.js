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

/** Une vidéo rangée en octets bruts redevient un fichier. */
function revive(item) {
  if (item && !item.blob && item.data) item.blob = new Blob([item.data], { type: item.type || 'video/mp4' });
  return item;
}

export class Library {
  constructor() { this.db = null; }

  async open() {
    if (this.db) return this.db;
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('created', 'created');
      // Rendus en cours : leurs images sont gardées au fur et à mesure, pour
      // survivre à une page mise en pause ou fermée par le téléphone.
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('frames')) db.createObjectStore('frames', { keyPath: ['job', 'i'] });
    };
    this.db = await request(req);
    // Base fermée par le système (page en arrière-plan sur iPhone) : on rouvrira au prochain accès.
    this.db.onclose = () => { this.db = null; };
    this.db.onversionchange = () => { try { this.db?.close(); } catch { /* déjà fermée */ } this.db = null; };
    return this.db;
  }

  /**
   * Une transaction, avec reconnexion : iOS coupe parfois la base d'une page
   * restée en arrière-plan (« Connection to Indexed Database server lost »).
   * On se reconnecte et on refait l'opération (toutes sont rejouables).
   */
  async tx(mode, fn, stores = STORE) {
    for (let attempt = 0; ; attempt++) {
      try { return await this.run(mode, fn, stores); } catch (e) {
        const lost = /connection|closing|closed|lost|invalidstate|unknownerror|abort/i.test(`${e?.name} ${e?.message}`);
        if (!lost || attempt >= 3) throw e;
        try { this.db?.close(); } catch { /* déjà fermée */ }
        this.db = null;
        await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      }
    }
  }

  async run(mode, fn, stores) {
    const db = await this.open();
    const tx = db.transaction(stores, mode);
    const result = await fn(Array.isArray(stores) ? stores.map((n) => tx.objectStore(n)) : tx.objectStore(stores));
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });
    return result;
  }

  /** Range une vidéo ; demande au navigateur de ne pas effacer la bibliothèque. */
  async add({ blob, thumb, title, seconds, aspect, codec, ext, scenario }) {
    const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const item = { id, created: Date.now(), blob, thumb: thumb || null, title: title || 'Vidéo SanctiMaps',
      seconds, aspect, codec, ext: ext || 'mp4', size: blob.size, scenario: scenario ? JSON.parse(JSON.stringify(scenario)) : null };
    try { await this.tx('readwrite', (s) => request(s.put(item))); } catch (e) {
      // Certains Safari refusent de ranger un gros fichier tel quel : on le range en octets bruts.
      const data = await blob.arrayBuffer();
      await this.tx('readwrite', (s) => request(s.put({ ...item, blob: null, data, type: blob.type || 'video/mp4' })));
    }
    try { await navigator.storage?.persist?.(); } catch { /* le navigateur décide */ }
    return item;
  }

  async list() {
    const all = await this.tx('readonly', (s) => request(s.getAll()));
    return all.map(revive).sort((a, b) => b.created - a.created);
  }

  async get(id) { return revive(await this.tx('readonly', (s) => request(s.get(id)))); }

  async rename(id, title) {
    return this.tx('readwrite', async (s) => { const item = await request(s.get(id)); if (item) { item.title = title; await request(s.put(item)); } });
  }

  async remove(id) { return this.tx('readwrite', (s) => request(s.delete(id))); }

  // --------------------------------------------------- rendus en cours

  async saveJob(job) { return this.tx('readwrite', (s) => request(s.put(job)), 'jobs'); }
  async jobs() { return this.tx('readonly', (s) => request(s.getAll()), 'jobs'); }

  /** Range un lot d'images et l'avancement du rendu, ensemble. */
  async putFrames(job, frames) {
    return this.tx('readwrite', async ([jobs, store]) => {
      for (const f of frames) store.put({ job: job.id, i: f.i, blob: f.blob });
      jobs.put(job);
    }, ['jobs', 'frames']);
  }

  async frame(jobId, i) {
    const row = await this.tx('readonly', (s) => request(s.get([jobId, i])), 'frames');
    return row?.blob || null;
  }

  /** Les images ``from`` à ``to`` (exclu) d'un rendu, dans l'ordre ; ``null`` pour une image manquante. */
  async frames(jobId, from, to) {
    const rows = await this.tx('readonly', (s) => request(s.getAll(IDBKeyRange.bound([jobId, from], [jobId, to - 1]))), 'frames');
    const out = new Array(to - from).fill(null);
    for (const r of rows) out[r.i - from] = r.blob;
    return out;
  }

  /** Efface un rendu en cours et ses images. */
  async dropJob(jobId) {
    return this.tx('readwrite', async ([jobs, frames]) => {
      jobs.delete(jobId);
      frames.delete(IDBKeyRange.bound([jobId, 0], [jobId, Number.MAX_SAFE_INTEGER]));
    }, ['jobs', 'frames']);
  }

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
