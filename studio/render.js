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
const XLINK = 'http://www.w3.org/1999/xlink';
const escAttr = (v) => String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const escText = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

/** Réduit une image à ``max`` pixels de côté ; ``null`` si ce n'est pas possible. */
async function shrink(blob, max) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (k === 1 && blob.size < 12000) { bmp.close(); return null; }
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); bmp.close();
    const url = c.toDataURL(/png|gif|svg/.test(blob.type) ? 'image/png' : 'image/jpeg', 0.85);
    c.width = 0; c.height = 0;
    return url;
  } catch { return null; }
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
    // Une seule toile pour le calque d'interface, réutilisée à chaque rendu.
    this.overlayCanvas = document.createElement('canvas');
    this.overlayCanvas.width = Math.floor(D.documentElement.clientWidth * this.scale);
    this.overlayCanvas.height = Math.floor(D.documentElement.clientHeight * this.scale);
    this.context.reuseCanvas = this.overlayCanvas;
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

  /**
   * Une image de la carte, recopiée dans le SVG de chaque image de la vidéo.
   * ``max`` : côté maximal en pixels — les portraits des repères, affichés en
   * vignettes de quelques dizaines de pixels, sont réduits : chaque image de la
   * vidéo pèse alors des centaines de Ko de moins, et la mémoire du téléphone
   * suit.
   */
  async inlineImage(url, max = 0) {
    if (!url || url.startsWith('data:')) return url;
    if (!this.images.has(url)) {
      // Les fonds de carte déjà vus restent en mémoire, dans une limite raisonnable.
      if (this.images.size >= 600) this.images.delete(this.images.keys().next().value);
      this.images.set(url, (async () => {
        try {
          const ctrl = new AbortController(); setTimeout(() => ctrl.abort(), 6000);
          const blob = await (await fetch(url, { mode: 'cors', signal: ctrl.signal })).blob();
          if (max) { const small = await shrink(blob, max); if (small) return small; }
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
    // Images de la carte (fonds, portraits) : recopiées en data: d'abord, car un
    // SVG dessiné comme image ne peut rien charger lui-même.
    const hrefs = new Map();
    await Promise.all([...svg.querySelectorAll('image')].map(async (el) => {
      const href = el.getAttribute('href') || el.getAttributeNS(XLINK, 'href');
      if (!href) return;
      if (href.startsWith('data:')) { hrefs.set(el, href); return; }
      const data = await this.inlineImage(new URL(href, D.baseURI).href, el.classList.contains('tile') ? 0 : 128);
      hrefs.set(el, data || null);
    }));
    // Puis la carte est écrite en texte directement depuis la page, sans copie
    // du DOM (des milliers d'éléments par image, que Safari met longtemps à
    // libérer). Les styles calculés vont dans une feuille partagée, une classe
    // par style distinct, au lieu d'être répétés sur chaque élément.
    const classes = new Map(); const out = [];
    const write = (el, parentSig) => {
      const cls = el.getAttribute('class') || '';
      const sig = `${parentSig}>${el.localName}.${cls}`;
      const style = this.styleFor(el, sig, win);
      if (el !== svg && style.includes('display:none')) return;
      const name = el.localName;
      if (name === 'image' && !hrefs.get(el)) return;
      out.push('<', name);
      if (el === svg) out.push(` xmlns="${SVG_NS}" xmlns:xlink="${XLINK}" width="${r.width}" height="${r.height}"`);
      for (const at of el.attributes) {
        const n = at.name;
        if (n === 'class' || n === 'aria-hidden' || (el === svg && (n === 'width' || n === 'height' || n.startsWith('xmlns')))) continue;
        if (name === 'image' && (n === 'href' || n === 'xlink:href')) continue;
        if (n.startsWith('on')) continue;
        out.push(' ', n, '="', escAttr(at.value), '"');
      }
      if (name === 'image') out.push(' href="', escAttr(hrefs.get(el)), '"');
      if (style) {
        let c = classes.get(style);
        if (!c) { c = `s${classes.size.toString(36)}`; classes.set(style, c); }
        out.push(' class="', c, '"');
      }
      out.push('>');
      if (el === svg) out.push('\u0000');
      for (let child = el.firstChild; child; child = child.nextSibling) {
        if (child.nodeType === 1) write(child, sig);
        else if (child.nodeType === 3) out.push(escText(child.nodeValue));
      }
      out.push('</', name, '>');
    };
    write(svg, root);
    const sheet = `<style>${[...classes].map(([st, c]) => `.${c}{${st}}`).join('\n').replace(/</g, '\\3c ')}</style>`;
    const text = out.join('').replace('\u0000', sheet);
    const blob = new Blob([text], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await loadImage(url);
      this.ctx.drawImage(img, r.left * s, r.top * s, r.width * s, r.height * s);
      // L'image décodée (plusieurs Mo) est libérée tout de suite, sans attendre Safari.
      img.removeAttribute('src');
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
    try { await this.renderOne(); } catch (e) {
      // Distinguer une panne du rendu d'un plan raté : le metteur en scène la laisse remonter.
      const err = e instanceof Error ? e : new Error(String(e));
      err.renderFailure = true;
      throw err;
    }
  }

  async renderOne() {
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
    this.drawCaption();
    this.drawCursor();
  }

  /**
   * La souris, par-dessus tout : une flèche blanche cerclée de noir, qui
   * « s'enfonce » au clic avec une onde rouge. ``cursorOf()`` donne sa
   * position (pixels de la page du site) et l'heure de l'horloge du studio.
   */
  drawCursor() {
    const c = this.cursorOf?.(); if (!c?.visible) return;
    const ctx = this.ctx, s = this.scale, x = c.x * s, y = c.y * s;
    const age = c.now - c.pressAt;
    const fade = Math.min(1, Math.max(0, (c.now - c.shownAt) / 250));
    ctx.save();
    ctx.globalAlpha = fade;
    if (age >= 0 && age < 450) {
      const k = age / 450;
      ctx.beginPath(); ctx.arc(x, y, (6 + 24 * k) * s, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(179, 38, 58, ${0.35 * (1 - k)})`; ctx.fill();
      ctx.lineWidth = 2.5 * s; ctx.strokeStyle = `rgba(255, 255, 255, ${0.8 * (1 - k)})`; ctx.stroke();
    }
    if (c.down) { ctx.beginPath(); ctx.arc(x, y, 9 * s, 0, Math.PI * 2); ctx.fillStyle = 'rgba(179, 38, 58, 0.3)'; ctx.fill(); }
    const u = 1.45 * s * (age >= 0 && age < 160 ? 0.86 : c.down ? 0.92 : 1);
    ctx.translate(x, y); ctx.scale(u, u);
    ctx.beginPath();
    ctx.moveTo(0, 0); ctx.lineTo(0, 17); ctx.lineTo(4.4, 13.2); ctx.lineTo(7.4, 20); ctx.lineTo(10.2, 18.8);
    ctx.lineTo(7.3, 12.2); ctx.lineTo(12.8, 12.2); ctx.closePath();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1.5;
    ctx.fillStyle = '#fff'; ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.lineJoin = 'round'; ctx.lineWidth = 1.3; ctx.strokeStyle = '#111'; ctx.stroke();
    ctx.restore();
  }

  /**
   * Titre à l'écran de la scène en cours (nom, dates, lieu…), posé par le
   * réalisateur. Son fondu se compte en images : une reprise après coupure
   * redessine exactement les mêmes.
   */
  setCaption(caption, seconds) {
    this.cap = caption?.title ? { ...caption, from: this.frames, to: this.frames + Math.round(seconds * this.fps) } : null;
  }

  drawCaption() {
    const c = this.cap; if (!c) return;
    const fade = Math.round(this.fps * 0.4);
    const a = Math.min(1, (this.frames - c.from + 1) / fade, (c.to - this.frames) / fade);
    if (a <= 0) return;
    const ctx = this.ctx, W = this.width, H = this.height, u = Math.min(W, H) / 1080, wide = W > H;
    const pad = 26 * u, maxW = W * (wide ? 0.5 : 0.84);
    const wrap = (text, font, max, lines) => {
      ctx.font = font; const out = []; let line = '';
      for (const word of String(text || '').split(/\s+/).filter(Boolean)) {
        const next = line ? `${line} ${word}` : word;
        if (ctx.measureText(next).width > max && line) { out.push(line); line = word; } else line = next;
        if (out.length === lines) break;
      }
      if (line && out.length < lines) out.push(line);
      else if (out.length === lines && line) out[lines - 1] = out[lines - 1].replace(/\s*\S*$/, '…');
      return out;
    };
    const tFont = `600 ${Math.round(48 * u)}px Georgia, "Times New Roman", serif`, sFont = `400 ${Math.round(28 * u)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    const title = wrap(c.title, tFont, maxW - 2 * pad, 2), sub = wrap(c.sub, sFont, maxW - 2 * pad, 3);
    const tH = 56 * u, sH = 36 * u;
    const boxH = pad * 2 + title.length * tH + (sub.length ? 8 * u + sub.length * sH : 0);
    ctx.font = tFont; let wMax = Math.max(...title.map((l) => ctx.measureText(l).width));
    ctx.font = sFont; if (sub.length) wMax = Math.max(wMax, ...sub.map((l) => ctx.measureText(l).width));
    const boxW = Math.min(maxW, wMax + 2 * pad + 10 * u);
    const x = wide ? W * 0.04 : (W - boxW) / 2, y = c.top ? H * (wide ? 0.11 : 0.08) : H - boxH - H * (wide ? 0.07 : 0.1);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = 'rgba(24, 18, 12, 0.74)';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x, y, boxW, boxH, 18 * u) : ctx.rect(x, y, boxW, boxH); ctx.fill();
    ctx.fillStyle = '#b3263a'; ctx.fillRect(x, y + 14 * u, 6 * u, boxH - 28 * u);
    ctx.textBaseline = 'top'; ctx.fillStyle = '#fff';
    ctx.font = tFont; title.forEach((l, i) => ctx.fillText(l, x + pad + 10 * u, y + pad + i * tH));
    ctx.font = sFont; ctx.fillStyle = 'rgba(255, 246, 232, 0.9)';
    sub.forEach((l, i) => ctx.fillText(l, x + pad + 10 * u, y + pad + title.length * tH + 8 * u + i * sH));
    ctx.restore();
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
    this.release();
    const drawn = Math.max(1, this.frames - this.skip);
    return { frames: this.frames, thumb: this.thumb ? await this.thumb : null, bytes: this.bytes,
      stats: { mapMs: this.mapMs / drawn, overlayMs: this.overlayMs / Math.max(1, this.overlayRenders), overlayRenders: this.overlayRenders } };
  }

  abort() { this.observer?.disconnect(); try { destroyContext(this.context); } catch { /* jamais créé */ } this.release(); }

  /** Rend la mémoire des toiles tout de suite (Safari les garde sinon longtemps). */
  release() {
    for (const c of [this.canvas, this.overlayCanvas]) if (c) { c.width = 0; c.height = 0; }
    this.images.clear(); this.styleCache.clear(); this.overlay = null;
  }
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
