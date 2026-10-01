// Rendu image par image dans le navigateur, sans capture d'écran.
//
// Chaque image de la vidéo est composée à partir de la page SanctiMaps du cadre :
//   1. la carte (SVG) est sérialisée avec ses styles calculés et dessinée —
//      quelques millisecondes ;
//   2. ce qui est posé dessus (fil d'Ariane, légende, fiche, panneau) est
//      rasterisé par modern-screenshot, seulement quand cela a changé.
// Les images sont encodées en H.264 par WebCodecs et rangées dans un MP4
// (mp4-muxer) : la vidéo a exactement 30 images par seconde, quelle que soit la
// vitesse du téléphone.

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

export class FrameRenderer {
  constructor(iframe, { width, height, fps = 30 }) {
    this.iframe = iframe; this.width = width; this.height = height; this.fps = fps;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width; this.canvas.height = height;
    this.ctx = this.canvas.getContext('2d');
    this.styleCache = new Map(); this.images = new Map();
    this.dirty = true; this.overlay = null; this.frames = 0; this.overlayRenders = 0; this.mapMs = 0; this.overlayMs = 0;
  }
  get D() { return this.iframe.contentDocument; }

  async start() {
    const D = this.D;
    this.scale = this.width / D.documentElement.clientWidth;
    const picked = await pickCodec(this.width, this.height, this.fps);
    if (!picked) throw new Error("ce navigateur ne sait pas encoder de vidéo");
    this.config = picked.config; this.codec = picked.mux;
    this.muxer = new Muxer({ target: new ArrayBufferTarget(), video: { codec: picked.mux, width: this.width, height: this.height, frameRate: this.fps }, fastStart: 'in-memory' });
    this.encoderError = null;
    this.encoder = new VideoEncoder({
      output: (chunk, meta) => this.muxer.addVideoChunk(chunk, meta),
      error: (e) => { this.encoderError = e; },
    });
    this.encoder.configure(this.config);
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

  async drawMap() {
    const D = this.D, win = this.iframe.contentWindow;
    const svg = D.querySelector('svg.map'); const host = D.querySelector('#map-host');
    if (!svg || !host) return;
    const r = svg.getBoundingClientRect(); const hr = host.getBoundingClientRect();
    const s = this.scale;
    this.ctx.fillStyle = win.getComputedStyle(host).backgroundColor || '#cfdde3';
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
      const img = new Image(); img.src = url; await img.decode();
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
    if (this.encoderError) throw this.encoderError;
    this.ctx.fillStyle = '#f8eede'; this.ctx.fillRect(0, 0, this.width, this.height);
    const t0 = performance.now();
    await this.drawMap();
    this.mapMs += performance.now() - t0;
    await this.drawOverlay();
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round(this.frames * 1e6 / this.fps), duration: Math.round(1e6 / this.fps) });
    this.encoder.encode(frame, { keyFrame: this.frames % (this.fps * 2) === 0 });
    frame.close();
    this.frames += 1;
    // Ne pas laisser la file d'encodage grossir sur un téléphone.
    while (this.encoder.encodeQueueSize > 4) await new Promise((r) => setTimeout(r, 5));
  }

  async finish() {
    await this.encoder.flush();
    this.muxer.finalize();
    this.observer.disconnect();
    destroyContext(this.context);
    const buffer = this.muxer.target.buffer;
    return { blob: new Blob([buffer], { type: 'video/mp4' }), ext: 'mp4', type: 'video/mp4', seconds: this.frames / this.fps,
      codec: this.codec, stats: { mapMs: this.mapMs / this.frames, overlayMs: this.overlayMs / Math.max(1, this.overlayRenders), overlayRenders: this.overlayRenders } };
  }

  abort() { try { this.encoder?.close(); } catch { /* déjà fermé */ } this.observer?.disconnect(); }
}
