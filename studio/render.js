// Rendu image par image dans le navigateur, sans capture d'écran.
//
// Chaque image de la vidéo est composée à partir de la page SanctiMaps du cadre :
//   1. la carte (SVG) est sérialisée avec ses styles calculés et dessinée —
//      quelques millisecondes ;
//   2. ce qui est posé dessus (fil d'Ariane, légende, fiche, panneau) est
//      rasterisé par modern-screenshot, seulement quand cela a changé.
// Chaque image est rangée aussitôt sur l'appareil (JPEG, IndexedDB) : si iOS
// met la page en pause ou la ferme, rien n'est perdu et le rendu reprend là où
// il s'était arrêté. Le MP4 (H.264, 30 images/s exactement, mp4-muxer) est
// assemblé à la fin à partir de ces images, par ``encodeJob``.
import { createContext, destroyContext, domToCanvas } from './vendor/modern-screenshot.mjs';
import { ArrayBufferTarget, Muxer } from './vendor/mp4-muxer.mjs';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray',
  'stroke-linejoin', 'stroke-linecap', 'opacity', 'display', 'visibility', 'font-family', 'font-size', 'font-weight',
  'font-style', 'letter-spacing', 'paint-order', 'text-anchor', 'dominant-baseline', 'vector-effect', 'filter',
  'color', 'stop-color'];
const TRANSPARENT = ['html', 'body', '.app', '.workspace', '#stage', '.stage', '#map-host'];

export function canRender() {
  return typeof window.VideoEncoder === 'function' && typeof window.VideoFrame === 'function';
}

// H.264 d'abord : c'est ce que lisent les iPhone, Photos et tous les réseaux
// sociaux. VP9 seulement si le navigateur n'a pas d'encodeur H.264.
async function pickCodec(width, height, fps) {
  const candidates = [
    ...['avc1.640028', 'avc1.4d0028', 'avc1.42e028', 'avc1.640033'].map((codec) => ({ codec, mux: 'avc', avc: { format: 'avc' } })),
    { codec: 'vp09.00.40.08', mux: 'vp9' },
  ];
  for (const c of candidates) {
    const config = { codec: c.codec, width, height, bitrate: 8_000_000, framerate: fps, ...(c.avc ? { avc: c.avc } : {}) };
    try { if ((await VideoEncoder.isConfigSupported(config)).supported) return { config, mux: c.mux }; } catch { /* suivant */ }
  }
  return null;
}

function untilVisible() {
  return new Promise((resolve) => {
    if (!document.hidden) return resolve();
    const on = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', on); resolve(); } };
    document.addEventListener('visibilitychange', on);
  });
}

function toJpeg(canvas, quality) {
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("image non enregistrée"))), 'image/jpeg', quality));
}

/** Charge une image ; si le décodage échoue (page suspendue), essaie à l'ancienne. */
async function loadImage(url) {
  const img = new Image(); img.src = url;
  try { await img.decode(); return img; } catch { /* repli */ }
  const again = new Image();
  await new Promise((resolve, reject) => { again.onload = resolve; again.onerror = () => reject(new Error('carte non dessinée')); again.src = url; });
  return again;
}

export class FrameRenderer {
  /**
   * ``store(batch, thumb)`` range un lot d'images ``{ i, blob }`` ; ``skip``
   * images sont seulement comptées (reprise d'un rendu interrompu : elles sont
   * déjà rangées).
   */
  constructor(iframe, { width, height, fps = 30, store, skip = 0, thumbAt = 0, quality = 0.86 }) {
    this.iframe = iframe; this.width = width; this.height = height; this.fps = fps;
    this.store = store; this.skip = skip; this.quality = quality; this.batch = []; this.bytes = 0;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.styleCache = new Map(); this.images = new Map();
    this.dirty = true; this.overlay = null; this.frames = 0; this.thumb = null; this.thumbAt = thumbAt; this.overlayRenders = 0; this.mapMs = 0; this.overlayMs = 0;
  }
  get D() { return this.iframe.contentDocument; }

  async start() {
    const D = this.D;
    this.scale = this.width / D.documentElement.clientWidth;
    // Tout changement hors de la carte rend le calque d'interface périmé.
    this.observer = new this.iframe.contentWindow.MutationObserver((list) => {
      const svg = D.querySelector('svg.map');
      if (list.some((m) => !svg || !svg.contains(m.target))) this.dirty = true;
    });
    this.observer.observe(D.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    this.context = await createContext(D.documentElement, {
      width: D.documentElement.clientWidth, height: D.documentElement.clientHeight, scale: this.scale,
      filter: (node) => this.keep(node),
      fetch: { requestInit: { mode: 'cors' } },
    });
  }

  /**
   * Ce que le calque d'interface doit cloner. La carte est dessinée à part ; les
   * listes (recherche, saint du jour, « N saints ici ») peuvent compter des
   * milliers de lignes, dont seules celles visibles à l'écran sont gardées.
   */
  keep(node) {
    if (node.nodeType !== 1) return true;
    if (['NOSCRIPT', 'SCRIPT', 'TEMPLATE'].includes(node.tagName) || node.matches('svg.map')) return false;
    if (node.matches('.result, .picker__item, .detail__lie, .detail__croise, .detail__lieu')) {
      const r = node.getBoundingClientRect();
      return r.bottom > 0 && r.top < this.D.documentElement.clientHeight && r.right > 0 && r.left < this.D.documentElement.clientWidth;
    }
    return true;
  }

  // ------------------------------------------------------------ calque carte

  async inlineImage(url) {
    if (!url || url.startsWith('data:')) return url;
    if (!this.images.has(url)) {
      this.images.set(url, (async () => {
        try {
          const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 6000);
          const blob = await (await fetch(url, { mode: 'cors', signal: ctrl.signal })).blob();
          return await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.onerror = () => r(null); fr.readAsDataURL(blob); });
        } catch { return null; }
      })());
    }
    return this.images.get(url);
  }

  styleFor(el, sig, win) {
    let style = this.styleCache.get(sig);
    if (style === undefined) {
      const cs = win.getComputedStyle(el);
      style = PROPS.map((p) => { const v = cs.getPropertyValue(p); return v && v !== 'none' && v !== 'normal' && v !== 'auto' ? `${p}:${v}` : (p === 'display' && v === 'none' ? 'display:none' : (p === 'fill' && v === 'none' ? 'fill:none' : (p === 'stroke' && v === 'none' ? 'stroke:none' : ''))); })
        .filter(Boolean).join(';');
      this.styleCache.set(sig, style);
    }
    return style;
  }

  /** La couleur de la mer de la carte (clair ou sombre, selon le thème du site). */
  seaColor() {
    const win = this.iframe.contentWindow, D = this.D;
    const sheet = D.querySelector('svg.map .sheet');
    const fill = sheet && win.getComputedStyle(sheet).fill;
    if (fill && fill !== 'none' && !fill.startsWith('url')) return fill;
    for (let el = D.querySelector('#map-host'); el; el = el.parentElement) {
      const bg = win.getComputedStyle(el).backgroundColor;
      if (bg && bg !== 'transparent' && !/rgba\(.*,\s*0\)$/.test(bg)) return bg;
    }
    return '#cddbe4';
  }

  async drawMap() {
    const D = this.D, win = this.iframe.contentWindow;
    const svg = D.querySelector('svg.map'); const host = D.querySelector('#map-host');
    if (!svg || !host) return;
    const r = svg.getBoundingClientRect(); const hr = host.getBoundingClientRect();
    const s = this.scale;
    // Autour du planisphère, la mer : pas de bandes de fond de page dans la vidéo.
    this.ctx.fillStyle = this.seaColor();
    this.ctx.fillRect(hr.left * s, hr.top * s, hr.width * s, hr.height * s);
    const root = `${D.documentElement.dataset.theme || ''}|${host.dataset.mode}|${host.className}|${D.documentElement.dataset.tiles || ''}`;
    const clone = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll('*')]; const dst = [clone, ...clone.querySelectorAll('*')];
    const sigs = new Map();
    const pending = [];
    for (let i = 0; i < src.length; i++) {
      const el = src[i], copy = dst[i];
      const cls = el.getAttribute('class') || '';
      const sig = `${sigs.get(el.parentNode) || root}>${el.localName}.${cls}`;
      sigs.set(el, sig);
      const style = this.styleFor(el, sig, win);
      if (style) copy.setAttribute('style', style + (copy.getAttribute('style') ? ';' + copy.getAttribute('style') : ''));
      if (el.localName === 'image') {
        const href = el.getAttribute('href') || el.getAttributeNS('http://www.w3.org/1999/xlink', 'href');
        if (href && !href.startsWith('data:')) {
          const abs = new URL(href, D.baseURI).href;
          pending.push(this.inlineImage(abs).then((data) => { if (data) copy.setAttribute('href', data); else copy.remove(); }));
        }
      }
    }
    await Promise.all(pending);
    clone.setAttribute('xmlns', SVG_NS);
    clone.setAttribute('width', r.width); clone.setAttribute('height', r.height);
    clone.removeAttribute('aria-hidden');
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      this.ctx.drawImage(img, r.left * s, r.top * s, r.width * s, r.height * s);
    } finally { URL.revokeObjectURL(url); }
  }

  // --------------------------------------------------------- calque interface

  async drawOverlay() {
    const D = this.D;
    const svg = D.querySelector('svg.map');
    const animating = D.getAnimations?.().some((a) => {
      const target = a.effect?.target; if (target && svg?.contains(target)) return false;
      const p = a.effect?.getComputedTiming().progress; return p != null && p < 1;
    });
    // Le défilement (fiche, panneau) ne laisse aucune trace dans le DOM.
    const scrolls = [...D.querySelectorAll('.fiche__body, .panel__body, .results')].map((e) => Math.round(e.scrollTop)).join(',');
    if (scrolls !== this.scrolls) { this.scrolls = scrolls; this.dirty = true; }
    if (this.dirty || animating || !this.overlay) {
      this.dirty = false;
      // Les fonds placés derrière la carte ne doivent pas la recouvrir.
      const saved = [];
      for (const sel of TRANSPARENT) for (const el of D.querySelectorAll(sel)) { saved.push([el, el.style.background]); el.style.background = 'transparent'; }
      try {
        this.observer.takeRecords();
        const t0 = performance.now();
        this.overlay = await domToCanvas(this.context);
        this.overlayMs += performance.now() - t0; this.overlayRenders += 1;
      } finally {
        for (const [el, bg] of saved) el.style.background = bg;
        this.observer.takeRecords();
      }
    }
    this.ctx.drawImage(this.overlay, 0, 0, this.width, this.height);
  }

  // ----------------------------------------------------------------- images

  async renderFrame() {
    // Reprise : ces images sont déjà sur l'appareil ; le temps avance seulement.
    if (this.frames < this.skip) { this.frames += 1; this.dirty = true; return; }
    // Une image ratée (page suspendue au mauvais moment) est refaite au retour.
    for (let attempt = 0; ; attempt++) {
      try { await this.drawFrame(); break; } catch (e) {
        if (attempt >= 2) throw e;
        if (document.hidden) await untilVisible();
        this.dirty = true;
      }
    }
    // La vignette de la bibliothèque : une image prise vers le premier tiers.
    if (!this.thumb && this.thumbAt >= 0 && this.frames >= this.thumbAt) this.captureThumb();
    const blob = await toJpeg(this.canvas, this.quality);
    this.bytes += blob.size;
    this.batch.push({ i: this.frames, blob });
    this.frames += 1;
    if (this.batch.length >= 15) await this.flush();
  }

  async drawFrame() {
    this.ctx.fillStyle = this.seaColor(); this.ctx.fillRect(0, 0, this.width, this.height);
    const t0 = performance.now();
    await this.drawMap();
    this.mapMs += performance.now() - t0;
    await this.drawOverlay();
  }

  /** Range les dernières images (et la vignette) : au pire 15 images perdues si la page est fermée. */
  async flush() {
    if (!this.batch.length) return;
    const batch = this.batch; this.batch = [];
    const thumb = this.thumb && !this.thumbStored ? await this.thumb : null;
    if (thumb) this.thumbStored = true;
    await this.store(batch, thumb, this.frames);
  }

  captureThumb() {
    const w = 360, h = Math.round(360 * this.height / this.width);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(this.canvas, 0, 0, w, h);
    this.thumb = new Promise((r) => c.toBlob((b) => r(b), 'image/jpeg', 0.8));
  }

  async finish() {
    await this.flush();
    this.observer.disconnect();
    destroyContext(this.context);
    const drawn = Math.max(1, this.frames - this.skip);
    return { frames: this.frames, thumb: this.thumb ? await this.thumb : null, bytes: this.bytes,
      stats: { mapMs: this.mapMs / drawn, overlayMs: this.overlayMs / Math.max(1, this.overlayRenders), overlayRenders: this.overlayRenders } };
  }

  abort() { this.observer?.disconnect(); try { destroyContext(this.context); } catch { /* jamais créé */ } }
}

/**
 * Assemble le MP4 d'un rendu à partir des images rangées sur l'appareil.
 * ``onProgress(i, n)`` suit l'avancement. Lève une erreur si l'encodeur est
 * perdu (iOS le reprend parfois aux pages en arrière-plan) : il suffit de
 * relancer, les images ne bougent pas.
 */
export async function encodeJob(library, job, onProgress = () => {}) {
  const { width, height, fps } = job; const n = job.frames;
  const picked = await pickCodec(width, height, fps);
  if (!picked) throw new Error("ce navigateur ne sait pas encoder de vidéo");
  const muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: picked.mux, width, height, frameRate: fps }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { failure = e; } });
  encoder.configure(picked.config);
  let last = null;
  try {
    for (let from = 0; from < n; from += 30) {
      const blobs = await library.frames(job.id, from, Math.min(n, from + 30));
      for (let k = 0; k < blobs.length; k++) {
        if (failure) throw failure;
        const i = from + k;
        // Une image manquante (page fermée entre deux rangements) : on répète la précédente.
        if (blobs[k]) { last?.close(); last = await createImageBitmap(blobs[k]); }
        if (!last) continue;
        const frame = new VideoFrame(last, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
        frame.close();
        while (encoder.encodeQueueSize > 4 && !failure) {
          await new Promise((r) => { encoder.addEventListener?.('dequeue', r, { once: true }); setTimeout(r, 50); });
        }
        if (i % 15 === 0) onProgress(i, n);
      }
    }
    await encoder.flush();
    if (failure) throw failure;
    muxer.finalize();
  } finally {
    last?.close();
    try { encoder.close(); } catch { /* déjà fermé */ }
  }
  onProgress(n, n);
  return { blob: new Blob([muxer.target.buffer], { type: 'video/mp4' }), ext: 'mp4', type: 'video/mp4', seconds: n / fps, codec: picked.mux };
}
