// Adaptateur SanctiMaps côté navigateur : pilote la carte chargée dans le cadre
// du studio, comme un lecteur (clics, molette, glisser, saisie), et vérifie
// chaque état obtenu. Même logique que sanctimaps_agent/adapter (Python).

export const TRANSITION_MS = 720;
const WHEEL_COEF = 0.0015;

export const CONTINENTS = {
  europe: ['europe'], africa: ['afrique', 'africa'], asia: ['asie', 'asia', 'moyen orient', 'proche orient'],
  'north-america': ['amerique du nord', 'north america', 'amerique centrale'],
  'south-america': ['amerique du sud', 'amerique latine', 'south america'],
  oceania: ['oceanie', 'oceania'],
};
export const CONTINENT_LABEL = {
  europe: "l'Europe", africa: "l'Afrique", asia: "l'Asie", oceania: "l'Océanie",
  'north-america': "l'Amérique du Nord", 'south-america': "l'Amérique du Sud",
};
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre',
  'octobre', 'novembre', 'décembre'];

export function fold(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’`\-_.,;:()"«»]/g, ' ').replace(/\s+/g, ' ').trim();
}
export const ease = (t) => 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, Math.max(0, t)));
export function roman(n) {
  let out = '';
  for (const [v, s] of [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]) while (n >= v) { out += s; n -= v; }
  return out;
}

export class ActionFailed extends Error {}

export class Report {
  constructor(action, ok, detail = '', data = {}) { Object.assign(this, { action, ok, detail, data }); }
  toString() { return `${this.ok ? '✓' : '✗'} ${this.action}${this.detail ? ' — ' + this.detail : ''}`; }
}

// ------------------------------------------------------------- horloge

/**
 * Le temps des animations de la carte avance au rythme fixé par le studio :
 * normal (1), ou ralenti pendant une transition du site.
 */
/** Une tâche plus tard — sans requestAnimationFrame ni minuterie bridée en arrière-plan. */
export function yieldTask() {
  return new Promise((resolve) => { const ch = new MessageChannel(); ch.port1.onmessage = () => resolve(); ch.port2.postMessage(0); });
}

/** Rendu « à blanc » : le temps avance, rien n'est dessiné. */
export const DRY = { renderFrame() {} };

export class Clock {
  constructor() { this.speed = 1; this.running = false; this.win = null; this.listeners = new Set(); this.renderer = null; this.vnow = 0; }
  attach(win) { this.win = win; win.__sm?.manual(true); if (!this.running) this.start(); }
  /** Temps du studio : réel en direct, virtuel (1/30 s par image) pendant un rendu. */
  now() { return this.renderer ? this.vnow : performance.now(); }
  start() {
    this.running = true;
    let last = performance.now();
    const loop = (t) => {
      if (!this.running) return;
      const dt = Math.min(100, t - last); last = t;
      if (this.win?.__sm && !this.renderer) this.win.__sm.tick(dt * this.speed);
      for (const fn of this.listeners) fn(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  /**
   * Rendu image par image : ``renderer.renderFrame()`` est appelé à chaque pas.
   * Le temps n'avance plus avec l'écran (requestAnimationFrame, arrêté quand la
   * page est en arrière-plan) mais pas à pas : le rendu continue écran éteint.
   * ``DRY`` fait avancer le temps sans rien dessiner (répétition, chargement).
   */
  beginRender(renderer, fps = 30) { this.renderer = renderer; this.fps = fps; }
  endRender() { this.renderer = null; this.resumeAnimations(); }
  resumeAnimations() {
    for (const a of this.win?.document.getAnimations?.() || []) if (a.__smPaused) { a.__smPaused = false; try { a.play(); } catch { /* fini */ } }
  }
  async frame() {
    if (!this.renderer) return new Promise((r) => requestAnimationFrame(() => r()));
    const dt = 1000 / this.fps;
    if (!this.win?.__sm) { this.vnow += dt; await yieldTask(); return; }
    this.win.__sm.tick(dt * this.speed);
    // Les transitions CSS du site avancent elles aussi d'une image exactement.
    // Une animation arrivée au bout est terminée pour de bon : sinon elle
    // resterait en pause, et les animations s'accumuleraient image après image.
    for (const a of this.win.document.getAnimations?.() || []) {
      try {
        if (!a.__smPaused) { a.pause(); a.__smPaused = true; }
        const end = a.effect?.getComputedTiming().endTime;
        const next = (a.currentTime || 0) + dt;
        if (Number.isFinite(end) && next >= end) { a.__smPaused = false; a.finish(); }
        else a.currentTime = next;
      } catch { /* animation terminée */ }
    }
    this.vnow += dt;
    await this.renderer.renderFrame();
    // Rendre la main sans dépendre de l'écran : réseau et décodages progressent.
    await yieldTask();
    for (const fn of this.listeners) fn(dt);
  }
  /**
   * Attendre sans filmer : pendant un rendu, si rien ne s'anime sur la carte
   * (on attend le réseau, des tuiles, une fiche), le temps de la vidéo ne
   * s'écoule pas — pas d'images immobiles en trop. Sinon, une image.
   */
  async idle() {
    if (this.renderer && this.win?.__sm && !this.win.__sm.pending()) {
      await new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => setTimeout(r, 25); ch.port2.postMessage(0); });
      return;
    }
    return this.frame();
  }
  async wait(ms) {
    if (this.renderer) { const n = Math.max(1, Math.round(ms * this.fps / 1000)); for (let i = 0; i < n; i++) await this.frame(); return; }
    const end = performance.now() + ms; while (performance.now() < end) await this.frame();
  }
}

// --------------------------------------------------------------- données

export class SiteData {
  constructor(base) { this.base = base.replace(/\/?$/, '/') + 'data/generated/'; this.cities = new Map(); }
  async get(path) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  }
  async load() {
    const [world, names] = await Promise.all([this.get('world.json'), this.get('country-names.json')]);
    this.world = world; this.names = names;
    this.countryById = new Map(world.countries.map((c) => [c.id, c]));
    this.continentById = new Map(world.continents.map((c) => [c.id, c]));
    const index = [];
    for (const c of world.countries) {
      const labels = new Set([c.name, ...Object.values(names[c.id] || {}).filter((v) => typeof v === 'string')]);
      for (const l of labels) if (l) index.push([fold(l), c.id]);
    }
    this.index = index.sort((a, b) => b[0].length - a[0].length);
  }
  countryName(iso) { return this.names[iso]?.fr || this.countryById.get(iso)?.name || iso; }
  findCountry(text) {
    const w = fold(text); if (!w) return null;
    if (this.countryById.has(String(text).trim().toUpperCase())) return String(text).trim().toUpperCase();
    for (const [l, iso] of this.index) if (l === w) return iso;
    const padded = ` ${w} `;
    for (const [l, iso] of this.index) if (l.length >= 4 && padded.includes(` ${l} `)) return iso;
    return null;
  }
  countriesIn(text) {
    let padded = ` ${fold(text)} `; const found = [];
    for (const [l, iso] of this.index) {
      if (l.length >= 4 && padded.includes(` ${l} `) && !found.includes(iso)) { found.push(iso); padded = padded.replace(` ${l} `, ' '); }
    }
    return found;
  }
  continentId(text) {
    const w = fold(text);
    for (const [id, names] of Object.entries(CONTINENTS)) if (w === id || names.includes(w)) return id;
    return null;
  }
  async citiesOf(iso) {
    if (!this.cities.has(iso)) this.cities.set(iso, this.get(`cities/${iso}.json`).catch(() => []));
    return this.cities.get(iso);
  }
  async findPlace(name, iso) {
    const w = fold(name); let best = null;
    for (const c of await this.citiesOf(iso)) if (fold(c.n) === w && (!best || (c.p || 0) > (best.p || 0))) best = c;
    return best;
  }
  async saints() { if (!this._saints) this._saints = this.get('saints.json').then((d) => d.saints); return this._saints; }
  async texts() { if (!this._texts) this._texts = this.get('saints-texts.json').catch(() => ({})); return this._texts; }
  async cityCountry(name) {
    const w = fold(name); const by = new Map();
    for (const s of await this.saints()) if (fold(s.city) === w) by.set(s.country, [...(by.get(s.country) || []), s]);
    if (!by.size) return null;
    const iso = [...by.keys()].sort((a, b) => by.get(b).length - by.get(a).length)[0];
    return { iso, saints: by.get(iso) };
  }
  richness(s, texts, { fame = false } = {}) {
    const bio = texts?.[s.id]?.bio?.fr || '';
    // Le patronage n'est renseigné que pour les saints les plus connus (≈ 5 % des fiches).
    return Math.min(bio.length, 3000) / 100 + (s.patronage ? 8 : 0) + (s.titles?.length || 0)
      + (s.statut === 'saint' ? 4 : 0) - (s.circa && !fame ? 3 : 0);
  }
  async interesting(iso, place) {
    const texts = await this.texts();
    let pool = (await this.saints()).filter((s) => !iso || s.country === iso);
    if (place) { const local = pool.filter((s) => fold(s.city) === fold(place)); if (local.length) pool = local; }
    pool.sort((a, b) => this.richness(b, texts) - this.richness(a, texts));
    const s = pool[0];
    return s ? (s.name?.fr || s.name) : null;
  }
  async fame() {
    if (!this._fame) {
      const texts = await this.texts(); const m = new Map();
      for (const s of await this.saints()) {
        const k = fold(s.name?.fr || s.name); m.set(k, Math.max(m.get(k) || 0, this.richness(s, texts, { fame: true })));
      }
      this._fame = m;
    }
    return this._fame;
  }
  async tour(iso, n = 3) {
    const counts = new Map();
    for (const s of await this.saints()) if (s.country === iso) counts.set(s.city, (counts.get(s.city) || 0) + 1);
    const box = this.countryById.get(iso).focus; const span = Math.max(box[2] - box[0], box[3] - box[1]);
    const chosen = [];
    for (const [city] of [...counts].sort((a, b) => b[1] - a[1])) {
      const c = await this.findPlace(city, iso); if (!c) continue;
      if (chosen.every((o) => Math.abs(o.x - c.x) + Math.abs(o.y - c.y) > span * 0.25)) chosen.push(c);
      if (chosen.length >= n) break;
    }
    return chosen.map((c) => c.n);
  }

  // ------------------------------------------- données pour le réalisateur

  /** Les lieux marqués par chaque saint (naissance, fondation, mort, sépulture…), et leurs liens. */
  async lieux() { if (!this._lieux) this._lieux = this.get('lieux.json').catch(() => ({ lieux: {}, liens: {} })); return this._lieux; }
  async saintById(id) {
    if (!this._byId) this._byId = this.saints().then((all) => new Map(all.map((s) => [s.id, s])));
    return (await this._byId).get(id) || null;
  }
  /**
   * Le saint que désigne un nom (« Louis », « saint Louis », « Jeanne d'Arc ») :
   * le nom le plus proche, puis le plus documenté — comme la recherche du site.
   * ``score`` dit la qualité de la correspondance (100 : nom exact).
   */
  async findSaint(name) {
    const q = fold(name).replace(/^(saint|sainte|saints|bienheureux|bienheureuse|st|ste) /, '');
    if (!q || q.length < 3) return null;
    const texts = await this.texts(); let best = null;
    for (const s of await this.saints()) {
      const n = fold(s.name?.fr || s.name);
      let score = n === q ? 100 : n.startsWith(q + ' ') ? 60 : ` ${n} `.includes(` ${q} `) ? 30 : 0;
      if (!score) continue;
      score += Math.min(25, this.richness(s, texts, { fame: true }));
      if (!best || score > best.score) best = { saint: s, score };
    }
    return best;
  }
  /** Le pays où tombe un point de la carte (contour exact du pays). */
  countryAt(x, y) {
    if (!this._paths) {
      this._ctx = (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas')).getContext('2d');
      this._paths = new Map();
    }
    let best = null;
    for (const c of this.world.countries) {
      const [x0, y0, x1, y1] = c.bbox;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (!this._paths.has(c.id)) this._paths.set(c.id, new Path2D(c.d));
      if (this._ctx.isPointInPath(this._paths.get(c.id), x, y) && (!best || c.area < best.area)) best = c;
    }
    return best?.id || null;
  }
  /** Les saints recensés dans un pays (données du site). */
  async saintsIn(iso) { return (await this.saints()).filter((s) => s.country === iso); }
}

// ------------------------------------------------------------- adaptateur

export class SanctiMaps {
  constructor(iframe, clock, style, log = () => {}) {
    this.iframe = iframe; this.clock = clock; this.style = style; this.log = log;
    this.memory = { view: null, continent: null, country: null, place: null, saint: null, mode: 'saints' };
    this.baseK = null; this.prev = null;
    // La souris visible dans la vidéo : position dans la page du site, dernier clic, bouton enfoncé.
    this.cursor = { x: 0, y: 0, visible: false, shownAt: 0, pressAt: -1e9, down: false };
    this.useCursor = true; this.onCursor = null;
  }
  get W() { return this.iframe.contentWindow; }
  get D() { return this.iframe.contentDocument; }
  q(sel) { return this.D.querySelector(sel); }

  // ---------------------------------------------------------- lecture d'état
  snapshot() {
    const D = this.D, q = (s) => D.querySelector(s);
    const host = q('#map-host'); const scene = q('#map-host svg.map g.scene');
    let transform = null;
    const m = scene && /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)\s*scale\(([-\d.e]+)\)/.exec(scene.getAttribute('transform') || '');
    if (m) transform = [parseFloat(m[3]), parseFloat(m[1]), parseFloat(m[2])];
    const fiche = q('#fiche'); const panel = q('#panel');
    const pressed = [...D.querySelectorAll('.corpus__btn')].findIndex((b) => b.getAttribute('aria-pressed') === 'true');
    const loader = q('#loader');
    return {
      loader: loader ? (loader.classList.contains('is-error') ? 'error' : loader.classList.contains('is-ready') ? 'ready' : 'loading') : null,
      mode: host?.dataset.mode || null, transform,
      trail: [...D.querySelectorAll('.trail .crumb')].map((c) => c.textContent.trim()),
      hint: q('.hint') && !q('.hint').hidden ? q('.hint').textContent : '',
      corpus: ['saints', 'apparitions', 'miracles'][pressed] || null,
      ficheOpen: !!(fiche && !fiche.hidden),
      ficheName: fiche && !fiche.hidden ? (q('.fiche__name')?.textContent || '').trim() : '',
      rows: fiche && !fiche.hidden ? fiche.querySelectorAll('.sheet__row').length : 0,
      picker: !!q('.picker.is-open'),
      panelOpen: !!panel?.classList.contains('is-open'),
      pending: this.W.__sm?.pending() || 0,
      tilesLoading: D.querySelectorAll('.tiles image.tile:not(.is-loaded):not(.is-stale)').length,
      rect: host ? host.getBoundingClientRect() : null,
    };
  }
  state() {
    const s = this.snapshot();
    let label = 'UNKNOWN';
    if (s.loader === 'error') label = 'ERROR';
    else if (s.loader === 'loading') label = 'LOADING';
    else if (s.loader === 'ready') label = 'INTRO_OPEN';
    else {
      label = { world: 'MAP_READY', continent: 'CONTINENT_VIEW', country: 'COUNTRY_VIEW' }[s.mode] || 'UNKNOWN';
      if (s.mode === 'country' && this.baseK && s.transform && s.transform[0] / this.baseK > 2.2) label = 'PLACE_VIEW';
      if (this.prev?.transform && s.transform) {
        if (Math.abs(s.transform[0] - this.prev.transform[0]) / this.prev.transform[0] > 1e-6) label = 'MAP_ZOOMING';
        else if (Math.abs(s.transform[1] - this.prev.transform[1]) > 0.5 || Math.abs(s.transform[2] - this.prev.transform[2]) > 0.5) label = 'MAP_MOVING';
      }
      if (!label.startsWith('MAP_') || label === 'MAP_READY') {
        if (s.ficheOpen) label = s.ficheName && s.rows ? 'SAINT_PROFILE_OPEN' : 'SAINT_PANEL_OPEN';
        else if (s.picker) label = 'SAINT_SELECTED';
        else if (s.panelOpen && this.q('#panel .daily')) label = 'CALENDAR_VIEW';
        else if (s.panelOpen && this.q('#panel .chip--century')) label = 'CENTURY_VIEW';
        else if (s.panelOpen && this.q('#panel .search')) label = 'SEARCH_ACTIVE';
      }
      if (s.corpus === 'apparitions' && label === 'MAP_READY') label = 'APPARITIONS_MODE';
    }
    this.prev = s;
    this.memory.view = s.mode; this.memory.mode = s.corpus || this.memory.mode;
    return { label, ...s };
  }

  // ------------------------------------------------------------- attentes
  async waitFor(what, predicate, timeout = 15000) {
    const end = performance.now() + timeout;
    while (performance.now() < end) {
      if (await predicate()) return true;
      await this.clock.idle();
    }
    throw new ActionFailed(`délai dépassé : ${what}`);
  }
  async waitStable(frames = 4) {
    let streak = 0, prev = null;
    await this.waitFor('carte stable', () => {
      const s = this.snapshot();
      const same = s.transform && prev && s.transform.every((v, i) => v === prev[i]);
      prev = s.transform;
      streak = same && !s.pending && !s.tilesLoading ? streak + 1 : 0;
      return streak >= frames;
    });
  }
  async stabilize() { await this.waitStable(); await this.clock.wait(this.style.settle * 1000); }
  async waitFiche() { await this.waitFor('fiche complète', () => { const s = this.snapshot(); return s.ficheOpen && s.ficheName && s.rows > 0; }); }

  // ---------------------------------------------------------- ouverture
  async open(data) {
    this.data = data;
    await this.waitFor('chargement de la carte', () => {
      const s = this.snapshot();
      if (s.loader === 'error') throw new ActionFailed('SanctiMaps signale une erreur de chargement');
      return s.loader === 'ready' || (s.loader === null && s.transform);
    }, 60000);
    (this.q('#loader-go') || this.q('#loader-close'))?.click();
    await this.waitFor('fermeture de la présentation', () => !this.q('#loader'), 5000);
    await this.closePanel();
    this.paintSea();
    // Le thème du téléphone peut changer (clair ↔ sombre) : la mer suit.
    this.W.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => setTimeout(() => this.paintSea(), 50));
    this.clock.attach(this.W);
    await this.stabilize();
    this.baseK = this.snapshot().transform?.[0];
    return new Report('open', true, 'carte prête');
  }
  /**
   * Autour du planisphère, la page laisse voir son fond (bandes claires en haut
   * et en bas en format vertical). On y met la couleur de la mer de la carte.
   */
  paintSea() {
    const sheet = this.q('svg.map .sheet'); const host = this.q('#map-host');
    if (!sheet || !host) return;
    host.style.background = '';
    const fill = this.W.getComputedStyle(sheet).fill;
    if (fill && fill !== 'none' && !fill.startsWith('url')) host.style.background = fill;
  }

  async closePanel() {
    if (this.q('#panel.is-open')) { await this.click(this.q('.panel__close')); await this.clock.wait(250); }
  }

  // ------------------------------------------------------------ géométrie
  geometry() {
    const s = this.snapshot(); const r = s.rect;
    return { k: s.transform[0], x: s.transform[1], y: s.transform[2], left: r.left, top: r.top, width: r.width, height: r.height, mode: s.mode };
  }
  toPage(px, py) { const g = this.geometry(); return [g.left + g.x + px * g.k, g.top + g.y + py * g.k]; }
  center() { const g = this.geometry(); return [g.left + g.width / 2, g.top + g.height / 2]; }
  safePoint(near) {
    const D = this.D; const h = this.q('#map-host').getBoundingClientRect();
    const ok = (x, y) => { const e = D.elementFromPoint(x, y); return e?.closest?.('svg.map') && !e.closest('.marker, .label, [data-cluster], [data-lieu]'); };
    const [cx, cy] = near || [h.left + h.width / 2, h.top + h.height / 2];
    if (ok(cx, cy)) return [cx, cy];
    for (let r = 10; r < Math.max(h.width, h.height) / 2; r += 10) {
      for (let a = 0; a < 16; a++) {
        const x = cx + r * Math.cos(a * Math.PI / 8), y = cy + r * Math.sin(a * Math.PI / 8);
        if (x > h.left + 4 && x < h.right - 4 && y > h.top + 4 && y < h.bottom - 4 && ok(x, y)) return [x, y];
      }
    }
    return [cx, cy];
  }
  countryPoint(iso) {
    const D = this.D; const path = D.querySelector(`path.country[data-country="${iso}"]`);
    if (!path) return null;
    const host = this.q('#map-host').getBoundingClientRect();
    const blockers = [...D.querySelectorAll('.trail, .corpus, .hint, .legend, .zoom, .scale, .attribution, .panel-toggle, .topbar, #panel.is-open, #fiche:not([hidden])')]
      .filter((e) => e.getClientRects().length).map((e) => e.getBoundingClientRect());
    const r = path.getBoundingClientRect();
    const x0 = Math.max(r.left, host.left + 8), x1 = Math.min(r.right, host.right - 8);
    const y0 = Math.max(r.top, host.top + 8), y1 = Math.min(r.bottom, host.bottom - 8);
    if (x1 <= x0 || y1 <= y0) return null;
    const pts = []; const N = 36;
    for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
      const x = x0 + (x1 - x0) * i / N, y = y0 + (y1 - y0) * j / N;
      if (blockers.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)) continue;
      const e = D.elementFromPoint(x, y); const c = e?.closest?.('[data-country]');
      if (c && c.dataset.country === iso && !e.closest('.marker, .label, .overlay')) pts.push([x, y]);
    }
    if (!pts.length) return null;
    const step = Math.max((x1 - x0) / N, (y1 - y0) / N) * 1.6;
    let best = pts[0], score = -1;
    for (const p of pts) {
      const s = pts.filter((o) => Math.abs(o[0] - p[0]) <= step * 2 && Math.abs(o[1] - p[1]) <= step * 2).length;
      if (s > score) { score = s; best = p; }
    }
    return best;
  }

  // ------------------------------------------------------------ souris

  /** Le point à viser sur un élément : son centre, ramené dans l'écran. */
  aim(target) {
    if (Array.isArray(target)) return target;
    const r = target?.getBoundingClientRect?.();
    if (!r || (!r.width && !r.height)) return null;
    const W = this.D.documentElement.clientWidth, H = this.D.documentElement.clientHeight;
    return [Math.min(W - 4, Math.max(4, r.left + Math.min(r.width / 2, 60))), Math.min(H - 4, Math.max(4, r.top + r.height / 2))];
  }

  /**
   * La souris va jusqu'à la cible comme une main : départ en douceur, léger
   * arc, arrêt, puis clic (``press``). Le temps est celui de l'horloge du
   * studio : dans la vidéo, le geste dure exactement le même nombre d'images.
   */
  async point(target, { press = true } = {}) {
    if (!this.useCursor) return;
    const goal = this.aim(target); if (!goal) return;
    const c = this.cursor; const [tx, ty] = goal;
    if (!c.visible) {
      // Première apparition : elle entre depuis le bas de l'écran.
      c.x = this.D.documentElement.clientWidth * 0.62; c.y = this.D.documentElement.clientHeight * 0.92;
      c.visible = true; c.shownAt = this.clock.now();
    }
    const x0 = c.x, y0 = c.y, d = Math.hypot(tx - x0, ty - y0);
    if (d > 3) {
      const dur = Math.min(850, 280 + d * 0.5);
      const nx = -(ty - y0) / d, ny = (tx - x0) / d;
      const bend = Math.min(50, d * 0.1) * (Math.round(x0 + ty) % 2 ? 1 : -1);
      const t0 = this.clock.now();
      for (;;) {
        await this.clock.frame();
        const p = Math.min(1, (this.clock.now() - t0) / dur), e = ease(p), arc = Math.sin(Math.PI * e) * bend;
        c.x = x0 + (tx - x0) * e + nx * arc; c.y = y0 + (ty - y0) * e + ny * arc;
        this.onCursor?.(c);
        if (p >= 1) break;
      }
    }
    c.x = tx; c.y = ty; this.onCursor?.(c);
    await this.clock.wait(90);
    if (press) { c.pressAt = this.clock.now(); this.onCursor?.(c, 'press'); await this.clock.wait(120); }
  }

  /** Clic sur un élément du site, souris comprise. */
  async click(el) { if (!el) return; await this.point(el); el.click(); }

  // ------------------------------------------------------------ gestes
  pointer(type, x, y, target) {
    const W = this.W;
    const el = target || this.D.elementFromPoint(x, y) || this.q('svg.map');
    el.dispatchEvent(new W.PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y,
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
    return el;
  }
  tap(x, y) {
    const el = this.pointer('pointerdown', x, y);
    this.pointer('pointerup', x, y, el);
  }
  wheel(x, y, deltaY) {
    const W = this.W; const svg = this.q('svg.map');
    svg.dispatchEvent(new W.WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: x, clientY: y, deltaY, deltaMode: 0 }));
  }

  /** Une transition du site (monde → continent → pays), rendue au ralenti. */
  async transition(trigger, seconds = this.style.transition) {
    this.clock.speed = TRANSITION_MS / (seconds * 1000);
    try {
      trigger();
      await this.clock.wait(seconds * 1000);
      await this.waitFor('fin de transition', () => !this.snapshot().pending, 8000);
    } finally { this.clock.speed = 1; }
    await this.stabilize();
    this.baseK = this.snapshot().transform[0];
  }

  async wheelZoom(factor, anchor, seconds) {
    const s = this.snapshot();
    if (s.mode === 'world') return { ok: false, achieved: 1, note: 'zoom libre indisponible au niveau monde' };
    seconds ??= Math.max(0.6, Math.abs(Math.log2(factor)) * this.style.zoom);
    const before = s.transform[0];
    const [ax, ay] = this.safePoint(anchor || this.center());
    await this.point([ax, ay], { press: false });
    const total = Math.log(factor); let done = 0; const t0 = this.clock.now();
    while (true) {
      await this.clock.frame();
      const p = Math.min(1, (this.clock.now() - t0) / (seconds * 1000));
      const target = total * ease(p); const step = target - done; done = target;
      if (Math.abs(step) > 1e-9) this.wheel(ax, ay, -step / WHEEL_COEF);
      if (p >= 1) break;
    }
    await this.stabilize();
    const achieved = this.snapshot().transform[0] / before;
    return { ok: Math.abs(Math.log(achieved) - total) < 0.15 || (factor > 1) === (achieved > 1.0001), achieved,
      note: Math.abs(Math.log(achieved) - total) < 0.15 ? '' : 'zoom borné par le site' };
  }

  async drag(dx, dy, seconds) {
    const dist = Math.hypot(dx, dy);
    if (dist < 8) return { ok: true, moved: 0 };
    seconds ??= Math.max(0.6, dist / this.style.pan);
    const g = this.geometry();
    const cx = g.left + g.width / 2, cy = g.top + g.height / 2;
    const [sx, sy] = this.safePoint([Math.min(Math.max(cx - dx / 2, g.left + 10), g.left + g.width - 10),
      Math.min(Math.max(cy - dy / 2, g.top + 10), g.top + g.height - 10)]);
    const before = [g.x, g.y]; const svg = this.q('svg.map');
    await this.point([sx, sy], { press: false });
    this.cursor.down = true; this.onCursor?.(this.cursor);
    this.pointer('pointerdown', sx, sy, svg);
    const t0 = this.clock.now(); let p = 0;
    while (p < 1) {
      await this.clock.frame();
      p = Math.min(1, (this.clock.now() - t0) / (seconds * 1000));
      let mx = dx * ease(p), my = dy * ease(p);
      if (Math.hypot(mx, my) < 5 && p < 1) { mx = dx / dist * 5; my = dy / dist * 5; }
      this.pointer('pointermove', sx + mx, sy + my, svg);
      if (this.useCursor) { this.cursor.x = sx + mx; this.cursor.y = sy + my; this.onCursor?.(this.cursor); }
    }
    this.pointer('pointerup', sx + dx, sy + dy, svg);
    this.cursor.down = false; this.onCursor?.(this.cursor);
    await this.stabilize();
    const g2 = this.geometry();
    const moved = Math.hypot(g2.x - before[0], g2.y - before[1]);
    return { ok: moved > dist * 0.5, moved };
  }
  async panTo(px, py) { const [tx, ty] = this.toPage(px, py); const [cx, cy] = this.center(); return this.drag(cx - tx, cy - ty); }
  async zoomTo(px, py, ratio) {
    await this.panTo(px, py);
    const g = this.geometry(); const factor = ((this.baseK || g.k) * ratio) / g.k;
    if (Math.abs(Math.log(factor)) < 0.05) return { ok: true, achieved: 1 };
    return this.wheelZoom(factor, this.toPage(px, py));
  }
  async pan(direction, fraction = 0.3) {
    const g = this.geometry(); const ax = g.width * fraction, ay = g.height * fraction;
    const [dx, dy] = { north: [0, ay], south: [0, -ay], east: [-ax, 0], west: [ax, 0] }[direction];
    return this.drag(dx, dy);
  }
  async fit() {
    const b = this.q('.zoom__fit');
    if (b && !b.disabled && !b.closest('[hidden]')) { await this.point(b); await this.transition(() => b.click()); }
  }

  // ------------------------------------------------------------ géographie
  continentOfTrail(s) { return s.trail.length > 1 ? this.data.continentId(s.trail[1]) : null; }

  async goWorld() {
    const s = this.snapshot();
    if (s.ficheOpen) await this.closeProfile();
    if (s.mode === 'world') return new Report('monde', true, 'déjà au monde');
    await this.point(this.q('.trail .crumb'));
    await this.transition(() => this.q('.trail .crumb').click());
    this.memory.continent = this.memory.country = this.memory.place = null;
    return new Report('monde', this.snapshot().mode === 'world', 'vue mondiale');
  }

  async goContinent(cid) {
    const cont = this.data.continentById.get(cid);
    if (!cont) return new Report('continent', false, `continent inconnu : ${cid}`);
    let s = this.snapshot();
    if (s.ficheOpen) { await this.closeProfile(); s = this.snapshot(); }
    if (s.mode === 'continent' && this.continentOfTrail(s) === cid) return new Report('continent', true, 'déjà sur ce continent');
    if (s.mode === 'country' && this.continentOfTrail(s) === cid) {
      await this.point(this.D.querySelectorAll('.trail .crumb')[1]);
      await this.transition(() => this.D.querySelectorAll('.trail .crumb')[1].click());
    } else {
      if (s.mode !== 'world') await this.goWorld();
      const members = cont.countries.map((c) => this.data.countryById.get(c)).filter(Boolean).sort((a, b) => (b.area || 0) - (a.area || 0));
      let point = null;
      for (const c of members.slice(0, 6)) { point = this.countryPoint(c.id); if (point) break; }
      if (!point) return new Report('continent', false, 'aucun pays cliquable');
      await this.point(point);
      await this.transition(() => this.tap(...point));
    }
    s = this.snapshot();
    const ok = s.mode === 'continent' && this.continentOfTrail(s) === cid;
    if (ok) { this.memory.continent = cid; this.memory.country = null; }
    return new Report('continent', ok, s.trail.join(' › '));
  }

  async goCountry(nameOrIso) {
    const iso = this.data.findCountry(nameOrIso);
    if (!iso) return new Report('pays', false, `« ${nameOrIso} » n'est pas un pays de SanctiMaps`);
    const country = this.data.countryById.get(iso); const label = this.data.countryName(iso);
    let s = this.snapshot();
    if (s.ficheOpen) { await this.closeProfile(); s = this.snapshot(); }
    if (s.mode === 'country' && s.trail[2] === label) { this.memory.country = iso; return new Report('pays', true, `déjà sur ${label}`); }
    if (!(s.mode === 'continent' && this.continentOfTrail(s) === country.continent)) {
      const r = await this.goContinent(country.continent);
      if (!r.ok) return new Report('pays', false, `continent non atteint : ${r.detail}`);
    }
    let point = this.countryPoint(iso); let tries = 0;
    while (!point && tries++ < 4) {
      const [lx, ly] = country.label || [(country.bbox[0] + country.bbox[2]) / 2, (country.bbox[1] + country.bbox[3]) / 2];
      await this.panTo(lx, ly);
      await this.wheelZoom(2.5, this.toPage(lx, ly));
      point = this.countryPoint(iso);
    }
    if (!point) return new Report('pays', false, `${label} introuvable sur la carte`);
    await this.point(point);
    await this.transition(() => this.tap(...point));
    s = this.snapshot();
    const ok = s.mode === 'country' && s.trail[2] === label;
    if (ok) Object.assign(this.memory, { country: iso, continent: country.continent, place: null });
    return new Report('pays', ok, `${s.trail.join(' › ')}${s.hint ? ' — ' + s.hint : ''}`);
  }

  async locatePlace(name, countryHint) {
    let iso = (countryHint && this.data.findCountry(countryHint)) || this.memory.country;
    let city = iso ? await this.data.findPlace(name, iso) : null;
    let saints = [];
    if (!city) {
      const found = await this.data.cityCountry(name);
      if (found) { iso = found.iso; saints = found.saints; city = await this.data.findPlace(name, iso); }
    }
    if (city) return { name: city.n, iso, x: city.x, y: city.y, kind: 'ville', approximate: false };
    if (saints.length) {
      const x = saints.reduce((a, s) => a + s.x, 0) / saints.length, y = saints.reduce((a, s) => a + s.y, 0) / saints.length;
      return { name: saints[0].city, iso, x, y, kind: 'région ou lieu approximatif', approximate: true };
    }
    return null;
  }

  async goPlace(name, countryHint, ratio, panOnly = false) {
    const place = await this.locatePlace(name, countryHint);
    if (!place) return new Report('lieu', false, `« ${name} » introuvable dans les données de SanctiMaps`);
    if (this.snapshot().ficheOpen) await this.closeProfile();
    if (this.memory.country !== place.iso || this.snapshot().mode !== 'country') {
      const r = await this.goCountry(place.iso);
      if (!r.ok) return new Report('lieu', false, `pays non atteint : ${r.detail}`);
      panOnly = false;
    }
    if (panOnly) await this.panTo(place.x, place.y);
    else await this.zoomTo(place.x, place.y, ratio || (place.approximate ? 3 : 6));
    const [px, py] = this.toPage(place.x, place.y); const [cx, cy] = this.center(); const g = this.geometry();
    const centered = Math.abs(px - cx) < g.width * 0.2 && Math.abs(py - cy) < g.height * 0.2;
    this.memory.place = place.name;
    return new Report('lieu', centered, `${place.name} (${place.kind})${place.approximate ? ' — position approximative selon SanctiMaps' : ''}`, place);
  }

  // ------------------------------------------------------------- panneau
  async openTab(tab) {
    // Les jeux s'ouvrent sur leur accueil, même si une partie était en cours.
    if (tab === 'jeux' && this.q('#panel.is-open .jeux .jeux__retour')) {
      await this.click(this.q('#panel.is-open .jeux .jeux__retour')); await this.clock.wait(400); return;
    }
    const VIEW = { search: '.search', daily: '.daily', jeux: '.jeux', add: 'form.add', settings: '.settings-view' };
    const panel = this.q('#panel');
    const here = tab === 'menu' ? panel.classList.contains('is-menu') : !!panel.querySelector(VIEW[tab]);
    if (panel.classList.contains('is-open') && here && (tab === 'menu' || !panel.classList.contains('is-menu'))) return;
    if (!panel.classList.contains('is-open')) { await this.click(this.q('.panel-toggle')); await this.clock.wait(250); }
    if (!panel.classList.contains('is-menu')) { await this.click(this.q('.panel__back')); await this.clock.wait(150); }
    if (tab === 'menu') { await this.clock.wait(300); return; }
    await this.click(this.q(`.menu__item[data-tab="${tab}"]`));
    await this.waitFor('panneau', () => panel.querySelector(VIEW[tab]), 5000);
    await this.clock.wait(400);
  }
  async type(input, text) {
    await this.point(input);
    input.focus(); input.value = ''; input.dispatchEvent(new this.W.Event('input', { bubbles: true }));
    const per = 1000 / this.style.typing;
    for (const ch of text) {
      input.value += ch; input.dispatchEvent(new this.W.Event('input', { bubbles: true }));
      await this.clock.wait(per);
    }
    input.blur();
  }
  async search(query, scope) {
    await this.openTab('search');
    if (scope) {
      const label = { saints: 'Saints', apparitions: 'Apparitions', miracles: 'Miracles' }[scope];
      const chip = [...this.D.querySelectorAll('.search .chip--scope')].find((c) => c.textContent.trim() === label);
      if (chip && chip.getAttribute('aria-pressed') !== 'true') { await this.click(chip); await this.clock.wait(150); }
    }
    await this.type(this.q('.search__input'), query);
    await this.clock.wait(300);
    return this.results();
  }
  results() {
    return [...this.D.querySelectorAll('.search .results .result, .daily .results .result')].map((r, index) => ({
      index, el: r, name: r.querySelector('.result__name')?.textContent.trim() || '',
      meta: r.querySelector('.result__meta')?.textContent.trim() || '',
      dates: r.querySelector('.result__dates')?.textContent.trim() || '',
    }));
  }
  static score(query, r) {
    const stop = new Set(['saint', 'sainte', 'saints', 'st', 'ste', 'bienheureux', 'bienheureuse', 'venerable', 'le', 'la']);
    const q = fold(query).split(' ').filter((w) => w && !stop.has(w));
    const words = fold(r.name).split(' ').filter((w) => w && !stop.has(w));
    if (!q.length) return 0;
    let s = 0;
    if (words.join(' ') === q.join(' ')) s += 100;
    if (words.slice(0, q.length).join(' ') === q.join(' ')) s += 40;
    s += 10 * q.filter((w) => words.includes(w)).length - 0.5 * Math.max(0, words.length - q.length);
    if (fold(r.name).includes(fold(query))) s += 5;
    return s;
  }
  async best(query, results) {
    const scored = results.map((r) => [SanctiMaps.score(query, r), r]);
    const top = Math.max(...scored.map((x) => x[0]));
    // Un mot de plus dans le nom (« de Lisieux ») ne doit pas suffire à écarter le saint le plus connu.
    const tied = scored.filter((x) => x[0] >= top - 2).map((x) => x[1]);
    if (tied.length === 1) return tied[0];
    const fame = await this.data.fame();
    return tied.sort((a, b) => (fame.get(fold(b.name)) || 0) - (fame.get(fold(a.name)) || 0))[0];
  }
  async openResult(chosen) {
    chosen.el.scrollIntoView({ block: 'nearest' });
    await this.clock.wait(300);
    await this.point(chosen.el);
    await this.transition(() => chosen.el.click());
    await this.waitFiche();
    const s = this.snapshot();
    const ok = fold(s.ficheName) === fold(chosen.name);
    if (ok) this.memory.saint = s.ficheName;
    const iso = s.trail[2] && this.data.findCountry(s.trail[2]);
    if (iso) this.memory.country = iso;
    return new Report('fiche', ok, `« ${s.ficheName} »${ok ? '' : ` au lieu de « ${chosen.name} »`}`);
  }
  async searchSaint(query) {
    const cleaned = query.replace(/^(saint|sainte|st|ste|bienheureux|bienheureuse|vénérable)\s+/i, '');
    const results = await this.search(cleaned, 'saints');
    if (!results.length) return new Report('fiche', false, `aucun résultat pour « ${query} »`);
    const r = await this.openResult(await this.best(query, results));
    if (r.ok) { await this.closePanel(); await this.stabilize(); }
    return r;
  }
  async openSaintOnMap(name) {
    const D = this.D; const h = this.q('#map-host').getBoundingClientRect();
    for (const m of D.querySelectorAll('.overlay [data-cluster]')) {
      if (m.classList.contains('is-crowded')) continue;
      const l = m.querySelector('.marker__label');
      if (!l || fold(l.textContent) !== fold(name)) continue;
      const r = (m.querySelector('.marker__badge, .marker__ring, circle')).getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x > h.left + 10 && x < h.right - 10 && y > h.top + 60 && y < h.bottom - 10) {
        await this.clock.wait(300); await this.point([x, y]); this.tap(x, y);
        await this.waitFiche(); await this.stabilize();
        const s = this.snapshot(); const ok = fold(s.ficheName) === fold(name);
        if (ok) this.memory.saint = s.ficheName;
        return new Report('fiche', ok, `« ${s.ficheName} » (depuis la carte)`);
      }
    }
    return new Report('fiche', false, 'croix non visible');
  }
  /** Les fiches de la liste affichée à l'écran : saint du jour, recherche, ou « N saints ici ». */
  visibleList() {
    const panel = this.q('#panel.is-open');
    const rows = [];
    if (panel) {
      for (const r of panel.querySelectorAll('.daily .results .result, .search .results .result')) {
        rows.push({ el: r, name: r.querySelector('.result__name')?.textContent.trim() || '', kind: 'result' });
      }
    }
    for (const r of this.D.querySelectorAll('.picker.is-open .picker__item')) {
      rows.push({ el: r, name: r.querySelector('.picker__name')?.textContent.trim() || '', kind: 'picker' });
    }
    return rows.map((r, index) => ({ ...r, index }));
  }

  /** Touche une fiche dans la liste déjà ouverte, sans passer par la barre de recherche. */
  async openFromList({ name, index } = {}) {
    const rows = this.visibleList();
    if (!rows.length) return new Report('liste', false, 'aucune liste de saints ouverte');
    let chosen = name ? rows.find((r) => fold(r.name) === fold(name)) : null;
    if (!chosen && name) chosen = rows.find((r) => fold(r.name).includes(fold(name)));
    if (!chosen && Number.isInteger(index)) chosen = rows[index < 0 ? rows.length + index : index];
    if (!chosen) return new Report('liste', false, `« ${name ?? index + 1} » n'est pas dans la liste affichée`);
    return this.openResult(chosen);
  }

  /** Ouvre une fiche par le chemin le plus court : liste affichée, croix visible, sinon recherche. */
  async openSaint(name) {
    if (this.visibleList().some((r) => fold(r.name) === fold(name))) {
      const fromList = await this.openFromList({ name });
      if (fromList.ok) return fromList;
    }
    const onMap = await this.openSaintOnMap(name);
    return onMap.ok ? onMap : this.searchSaint(name);
  }
  async openNearestMarker() {
    const D = this.D; const h = this.q('#map-host').getBoundingClientRect();
    const cx = h.left + h.width / 2, cy = h.top + h.height / 2;
    const pts = [...D.querySelectorAll('.overlay [data-cluster]')].filter((m) => !m.classList.contains('is-crowded')).map((m) => {
      const r = m.querySelector('.marker__badge, .marker__ring, circle').getBoundingClientRect();
      const count = parseInt(m.querySelector('.marker__count')?.textContent || '1', 10) || 1;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, count };
    }).filter((p) => p.x > h.left + 20 && p.x < h.right - 20 && p.y > h.top + 60 && p.y < h.bottom - 20)
      .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy));
    if (!pts.length) return new Report('repère', false, 'aucun repère visible');
    const t = pts.find((p) => p.count === 1) || pts[0];
    await this.point([t.x, t.y]);
    this.tap(t.x, t.y);
    await this.waitFor('liste ou fiche', () => { const s = this.snapshot(); return s.picker || s.ficheOpen; }, 4000);
    if (this.snapshot().picker) { await this.clock.wait(800); await this.click(this.q('.picker.is-open .picker__item')); }
    await this.waitFiche(); await this.stabilize();
    this.memory.saint = this.snapshot().ficheName;
    return new Report('fiche', true, `« ${this.memory.saint} »`);
  }

  readProfile() {
    const f = this.q('#fiche'); if (!f || f.hidden) return null;
    const t = (s) => f.querySelector(s)?.textContent.trim() || null;
    const rows = [...f.querySelectorAll('.sheet__row')].map((r) => [r.querySelector('dt')?.textContent.trim(), r.querySelector('dd')?.textContent.trim()]);
    return { title: this.q('.fiche__name')?.textContent.trim(), aka: t('.detail__aka'), rows,
      description: t('.detail__desc'), biography: t('.detail__bio'),
      sources: [...f.querySelectorAll('.detail__sources a')].map((a) => a.textContent.trim()) };
  }
  async showProfile(seconds) {
    await this.waitFiche();
    const p = this.readProfile();
    const body = this.q('.fiche__body');
    const textLen = (p.biography || '').length + (p.description || '').length;
    seconds ||= Math.max(this.style.hold, Math.min(12, textLen / 100 * this.style.reading));
    await this.clock.wait(seconds * 350);
    const overflow = body ? body.scrollHeight - body.clientHeight : 0;
    if (overflow > 20) {
      const distance = Math.min(overflow, body.clientHeight * 1.2); const t0 = this.clock.now();
      let q = 0;
      while (q < 1) { await this.clock.frame(); q = Math.min(1, (this.clock.now() - t0) / (seconds * 500)); body.scrollTop = distance * ease(q); }
      await this.clock.wait(seconds * 150);
    } else await this.clock.wait(seconds * 650);
    return new Report('lecture', true, p.title || '', { profile: p });
  }
  async closeProfile() {
    if (!this.snapshot().ficheOpen) return new Report('fermeture', true, 'aucune fiche');
    await this.click(this.q('.fiche__close'));
    await this.waitFor('fiche fermée', () => !this.snapshot().ficheOpen, 5000);
    await this.stabilize();
    return new Report('fermeture', true);
  }

  // ------------------------------------------------- siècles, calendrier
  async century(n, countryIso) {
    const query = `${countryIso ? this.data.countryName(countryIso) + ' ' : ''}${roman(n)}e siècle`;
    const results = await this.search(query, 'saints');
    const chip = this.q('.search .chip--century');
    const ok = !!chip && new RegExp(`(^|\\D)${n}(\\D|$)`).test(chip.textContent);
    const summary = this.q('.search .results__summary')?.textContent || '';
    return new Report('siècle', ok, `${summary} — ${[...this.D.querySelectorAll('.search .chip--token')].map((c) => c.textContent.replace('×', '').trim()).join(', ')}`, { results });
  }
  static parseDay(text, today) {
    const t = fold(text);
    if (!t || /aujourd|ce jour|today/.test(t)) return today;
    if (t === 'demain') return new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    if (t === 'hier') return new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    const m = /(\d{1,2})(?:er)?\s+([a-z]+)/.exec(t);
    if (m) {
      const i = MONTHS.map(fold).findIndex((x) => x.startsWith(m[2].slice(0, 3)));
      if (i >= 0) return new Date(today.getFullYear(), i, +m[1]);
    }
    return null;
  }
  async feastDay(day) {
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const target = SanctiMaps.parseDay(day, today);
    if (!target) return new Report('calendrier', false, `date non comprise : « ${day} »`);
    const offset = Math.round((target - today) / 86400000);
    if (Math.abs(offset) <= 7) {
      await this.openTab('daily');
      const btns = this.D.querySelectorAll('.daily__nav button');
      for (let i = 0; i < Math.abs(offset); i++) { await this.click(btns[offset > 0 ? 1 : 0]); await this.clock.wait(500); }
      const date = this.q('.daily__date')?.textContent || '';
      const ok = date.includes(String(target.getDate())) && fold(date).includes(fold(MONTHS[target.getMonth()]));
      return new Report('calendrier', ok, `${date} — ${this.results().length} fiche(s)`);
    }
    const label = `${target.getDate()} ${MONTHS[target.getMonth()]}`;
    const results = await this.search(label, 'saints');
    return new Report('calendrier', !!this.q('.search .chip--feast'), `${label} — ${results.length} fiche(s)`);
  }

  // -------------------------------------------------- nouvelles actions

  /** Remonte d'un niveau : pays → continent → monde (fil d'Ariane du site). */
  async levelUp() {
    let s = this.snapshot();
    if (s.ficheOpen) { await this.closeProfile(); s = this.snapshot(); }
    if (s.mode === 'world') return new Report('niveau', true, 'déjà au monde');
    const crumbs = this.D.querySelectorAll('.trail .crumb');
    const target = s.mode === 'country' ? crumbs[1] : crumbs[0];
    await this.point(target);
    await this.transition(() => target.click());
    s = this.snapshot();
    if (s.mode === 'continent') { this.memory.country = null; this.memory.place = null; }
    if (s.mode === 'world') Object.assign(this.memory, { country: null, continent: null, place: null });
    return new Report('niveau', true, s.trail.join(' › '));
  }

  /** Les lieux marqués par le saint ouvert, ou ceux qu'il a pu croiser (boutons de la fiche). */
  async ficheButton(kind) {
    await this.waitFiche();
    const btn = this.q(kind === 'lieux' ? '.detail__lieux-btn' : '.detail__croises-btn');
    const what = kind === 'lieux' ? 'lieux marqués' : 'saints croisés';
    if (!btn) return new Report(what, false, `la fiche de ${this.snapshot().ficheName} n'en indique pas`);
    if (!btn.classList.contains('is-on')) { await this.point(btn); await this.transition(() => btn.click()); }
    const on = !!this.q(kind === 'lieux' ? '.detail__lieux-btn.is-on' : '.detail__croises-btn.is-on');
    return new Report(what, on, btn.textContent.trim());
  }

  async searchList(query) {
    const results = await this.search(query, 'saints');
    const summary = this.q('.search .results__summary')?.textContent || '';
    return new Report('recherche', results.length > 0, `« ${query} » : ${summary}`, { results });
  }

  /** Le cadrage actuel, en coordonnées de la carte : centre et rapport à l'échelle d'arrivée. */
  view() {
    const g = this.geometry(); const [cx, cy] = this.center();
    return { x: (cx - g.left - g.x) / g.k, y: (cy - g.top - g.y) / g.k, ratio: this.baseK ? g.k / this.baseK : 1, k: g.k, mode: g.mode };
  }
  /** Le nom qui résume un cadrage : la ville la plus peuplée près du centre de l'écran. */
  async nearestPlace(x, y, iso) {
    if (!iso) return null;
    const g = this.geometry(); const radius = (Math.min(g.width, g.height) / g.k) * 0.25;
    let best = null, score = -1, nearest = null, d = Infinity;
    for (const c of await this.data.citiesOf(iso)) {
      const dd = Math.hypot(c.x - x, c.y - y);
      if (dd < d) { d = dd; nearest = c; }
      if (dd <= radius && (c.p || 0) > score) { score = c.p || 0; best = c; }
    }
    return (best || nearest)?.n || null;
  }
  /** Retrouve un cadrage montré à la main : pays, centre, échelle. */
  async frameView({ x, y, ratio, country }) {
    if (this.snapshot().ficheOpen) await this.closeProfile();
    if (country && (this.memory.country !== country || this.snapshot().mode !== 'country')) {
      const r = await this.goCountry(country);
      if (!r.ok) return r;
    }
    const r = await this.zoomTo(x, y, ratio || 1);
    return new Report('cadrage', r.ok !== false, `×${(ratio || 1).toFixed(1)}`);
  }

  // ------------------------------------------- toutes les interactions du site

  /** Ce qu'on peut toucher à l'écran : boutons, résumés dépliables, puces, cases. */
  pressables(scope) {
    const root = scope ? this.q(scope) : this.D;
    if (!root) return [];
    return [...root.querySelectorAll('button, summary, a[href], [role=button], label.check, .chip')]
      .filter((e) => e.getClientRects().length && !e.disabled && !e.closest('[hidden], svg.map'));
  }

  /**
   * Boutons qui feraient sortir de la vidéo : téléchargement, autorisation du
   * téléphone, installation, compte, envoi d'une proposition. Jamais pressés.
   */
  static unsafe(el) {
    const txt = fold(el.textContent);
    return !!(el.closest('form.add') && (el.type === 'submit' || /envoyer|proposer|publier|enregistrer/.test(txt)))
      || /calendrier du telephone|ajouter ces .* au calendrier|installer|activer|notification|se connecter|connexion|deconnect|code|lettre|courriel|e-mail|mailto/.test(txt)
      || (el.tagName === 'A' && /^(mailto|https?):/.test(el.getAttribute('href') || '') && !el.closest('.trail'));
  }

  /** Appuie sur un élément de l'interface, désigné par son texte (ou un sélecteur et un rang). */
  async press({ label, selector, index = 0, scope } = {}) {
    let el = null;
    if (selector) {
      const list = [...this.D.querySelectorAll(selector)].filter((e) => e.getClientRects().length && !e.disabled);
      el = list[index < 0 ? list.length + index : index];
    } else if (label) {
      const want = fold(label);
      const all = this.pressables(scope);
      const text = (e) => fold(e.getAttribute('aria-label') || e.textContent);
      el = all.find((e) => text(e) === want) || all.find((e) => text(e).startsWith(want))
        || all.find((e) => text(e).includes(want));
    }
    if (!el) return new Report('bouton', false, `« ${label ?? selector} » introuvable à l'écran`);
    if (SanctiMaps.unsafe(el)) return new Report('bouton', false, `« ${el.textContent.trim()} » n'est pas pressé : il ferait sortir de la vidéo (téléchargement, autorisation, envoi)`);
    const name = (el.textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    await this.clock.wait(350);
    await this.point(el);
    el.click();
    await this.clock.wait(150);
    // Le bouton a fait bouger la carte (« Voir sur la carte », « Voir la fiche ») : on suit au ralenti.
    if (this.snapshot().pending) {
      this.clock.speed = TRANSITION_MS / (this.style.transition * 1000);
      try { await this.waitFor('carte', () => !this.snapshot().pending, 8000); } finally { this.clock.speed = 1; }
      await this.stabilize();
    } else await this.clock.wait(450);
    if (this.snapshot().ficheOpen) this.memory.saint = this.snapshot().ficheName;
    return new Report('bouton', true, `« ${name} »`);
  }

  /** Choisit une valeur dans les paramètres : langue, thème, fond de carte. */
  async selectOption(field, value) {
    await this.openTab('settings');
    // Reconnus à leurs valeurs, pas à leur libellé : la langue du site peut avoir changé.
    const SIGN = { language: 'fr', theme: 'dark', basemap: 'off' };
    const select = [...this.D.querySelectorAll('.settings select')].find((sel) => [...sel.options].some((o) => o.value === SIGN[field]));
    const box = select?.closest('label.field');
    if (!select) return new Report('paramètre', false, `réglage « ${field} » introuvable`);
    const want = fold(value);
    const opt = [...select.options].find((o) => fold(o.value) === want || fold(o.textContent) === want)
      || [...select.options].find((o) => fold(o.textContent).startsWith(want));
    if (!opt) return new Report('paramètre', false, `valeur « ${value} » inconnue (${[...select.options].map((o) => o.textContent).join(', ')})`);
    select.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    await this.clock.wait(400);
    await this.point(select);
    select.value = opt.value;
    select.dispatchEvent(new this.W.Event('change', { bubbles: true }));
    await this.clock.wait(600);
    this.paintSea();
    await this.stabilize();
    return new Report('paramètre', select.value === opt.value, `${box?.querySelector('.field__label')?.textContent || field} : ${opt.textContent}`);
  }

  /** Écrit dans le champ visible du panneau (réponse du quiz, indice de « Qui est-ce ? »), puis valide. */
  async typeField(text, submit = true) {
    const input = [...this.D.querySelectorAll('#panel.is-open input[type=text], #panel.is-open input:not([type])')]
      .find((e) => e.getClientRects().length && !e.disabled);
    if (!input) return new Report('saisie', false, 'aucun champ à remplir à l\'écran');
    input.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    await this.type(input, text);
    if (submit) {
      const form = input.closest('form');
      if (form?.requestSubmit) form.requestSubmit(); else input.dispatchEvent(new this.W.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await this.clock.wait(700);
    }
    return new Report('saisie', true, `« ${text} »`);
  }

  /** Fait défiler le panneau ou la fiche, en douceur ; ou jusqu'à un titre (« Rappel quotidien »). */
  async scrollPanel({ target = 'auto', to = 'down', text, section } = {}) {
    const fiche = this.q('#fiche:not([hidden]) .fiche__body');
    const panel = this.q('#panel.is-open .panel__body');
    const box = target === 'fiche' ? fiche : target === 'panel' ? panel : (panel || fiche);
    if (!box) return new Report('défilement', false, 'rien à faire défiler');
    let goal;
    if (section || text) {
      const el = section ? box.querySelector(section)  // le libellé ne sert alors qu'à l'affichage
        : [...box.querySelectorAll('h2, h3, legend, summary, .panel__section, .field__label')].find((e) => fold(e.textContent).includes(fold(text)));
      if (!el) return new Report('défilement', false, `« ${text} » introuvable`);
      goal = box.scrollTop + el.getBoundingClientRect().top - box.getBoundingClientRect().top - 12;
    } else if (to === 'top') goal = 0;
    else if (to === 'bottom') goal = box.scrollHeight;
    else goal = box.scrollTop + (to === 'up' ? -1 : 1) * box.clientHeight * 0.8;
    goal = Math.max(0, Math.min(goal, box.scrollHeight - box.clientHeight));
    const from = box.scrollTop; const t0 = this.clock.now(); const dur = 1200;
    let q = 0;
    while (q < 1) { await this.clock.frame(); q = Math.min(1, (this.clock.now() - t0) / dur); box.scrollTop = from + (goal - from) * ease(q); }
    await this.clock.wait(300);
    return new Report('défilement', true, text || section ? `jusqu'à « ${text || section} »` : to);
  }

  /** Déplie ou replie : bandeau d'en-tête, légende, paliers ou idées d'indices des jeux. */
  async toggle(what, open) {
    const SEL = { intro: 'details.intro__fold', legend: 'details.legend', paliers: 'details.jeux__paliers', idees: 'details.jeux__idees', bio: 'details.jeux__fiche-bio' };
    if (what === 'paliers' && !this.q(SEL.paliers)) await this.openTab('jeux');   // ils sont sur l'accueil des jeux
    const d = this.q(SEL[what]);
    if (!d) return new Report('dépliage', false, `« ${what} » absent de l'écran`);
    if (open === undefined || d.open !== open) { await this.click(d.querySelector('summary')); await this.clock.wait(500); }
    await this.stabilize();
    return new Report('dépliage', true, `${what} ${d.open ? 'déplié' : 'replié'}`);
  }

  /** Quiz : la bonne réponse (affichée d'abord, comme le jeu le permet). */
  async quizCorrect() {
    if (!this.q('.jeux__quiz')) return new Report('quiz', false, 'aucune question de quiz à l\'écran');
    if (!this.q('.jeux__revele')) {
      const show = this.pressables('#panel').find((e) => fold(e.textContent).startsWith('afficher la reponse'));
      if (show) { await this.click(show); await this.clock.wait(900); }
    }
    const revealed = this.q('.jeux__revele')?.textContent.replace(/^[^:]*:\s*/, '').trim();
    if (!revealed) return new Report('quiz', false, 'réponse non affichable dans ce mode');
    const choice = [...this.D.querySelectorAll('.jeux__reponse')].find((b) => fold(b.textContent) === fold(revealed));
    if (choice) { choice.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); await this.clock.wait(400); await this.click(choice); }
    else return this.typeField(revealed, true);
    await this.clock.wait(700);
    return new Report('quiz', true, `réponse : ${revealed}`);
  }

  // ------------------------------------------------------------- apparitions
  async setCorpus(corpus) {
    const label = { saints: 'Saints', apparitions: 'Apparitions', miracles: 'Miracles' }[corpus];
    const btn = [...this.D.querySelectorAll('.corpus__btn')].find((b) => b.textContent.trim() === label)
      || this.D.querySelectorAll('.corpus__btn')[['saints', 'apparitions', 'miracles'].indexOf(corpus)];
    if (btn.getAttribute('aria-pressed') !== 'true') { await this.click(btn); await this.clock.wait(400); }
    await this.stabilize();
    const ok = this.snapshot().corpus === corpus;
    this.memory.mode = corpus;
    return new Report(`mode ${label.toLowerCase()}`, ok, this.q('.legend')?.textContent.trim().slice(0, 100) || '');
  }
  async openApparition(name) {
    if (!name) { await this.setCorpus('apparitions'); return this.openNearestMarker(); }
    const results = await this.search(name, 'apparitions');
    if (!results.length) return new Report('apparition', false, `aucune apparition pour « ${name} »`);
    const r = await this.openResult(await this.best(name, results));
    await this.closePanel(); await this.stabilize();
    return r;
  }
}
