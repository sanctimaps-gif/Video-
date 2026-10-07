// Garder la page éveillée pendant un rendu, téléphone en veille ou Safari en
// arrière-plan.
//
// iOS suspend une page web dès qu'on la quitte — sauf quand elle joue du son.
// Le studio joue donc une piste audio quasi silencieuse pendant le rendu
// (lancée par le toucher sur « Enregistrer », comme l'exige le téléphone).
// L'écran verrouillé affiche la progression (Media Session), et un carillon
// signale la fin.
//
// « Garder ma musique » (par défaut) : la piste se mélange aux autres sons
// (Audio Session « ambient », Safari 16.4+) au lieu de prendre la main — la
// musique du téléphone continue, et le studio ne s'affiche pas dans « À l'écoute »
// pour ne pas lui voler ses commandes. Le carillon final baisse la musique un
// instant (« transient ») sans l'arrêter.

function wav(samples, rate = 22050) {
  const data = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); data.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, 1, true);
  data.setUint32(24, rate, true); data.setUint32(28, rate * 2, true); data.setUint16(32, 2, true); data.setUint16(34, 16, true);
  str(36, 'data'); data.setUint32(40, samples.length * 2, true);
  samples.forEach((v, i) => data.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(v))), true));
  return URL.createObjectURL(new Blob([data], { type: 'audio/wav' }));
}

/** Une seconde de « silence » : un souffle inaudible, que le système ne prend pas pour du vide. */
function hush() {
  const n = 22050; const s = new Array(n);
  for (let i = 0; i < n; i++) s[i] = (Math.random() - 0.5) * 2;
  return wav(s);
}

/** Deux notes douces : la vidéo est prête. */
function chime() {
  const rate = 22050; const s = [];
  for (const [f, d] of [[880, 0.18], [1318.5, 0.42]]) {
    const n = Math.round(d * rate);
    for (let i = 0; i < n; i++) s.push(Math.sin(2 * Math.PI * f * i / rate) * 9000 * Math.exp(-3 * i / n));
  }
  return wav(s, rate);
}

export class KeepAlive {
  constructor() { this.audio = null; this.active = false; this.last = 0; this.mix = true; }

  /** Type de session audio du navigateur, quand il le permet (Safari 16.4+). */
  session(type) {
    try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* non pris en charge */ }
  }

  /** À appeler directement dans le toucher (avant tout « await »). */
  start(title = 'Rendu de la vidéo') {
    try {
      if (!this.audio) {
        this.audio = new Audio(hush());
        this.audio.loop = true;
        this.audio.playsInline = true;
        this.audio.setAttribute('playsinline', '');
        this.bell = new Audio(chime());
        this.bell.playsInline = true;
      }
      // Avant de jouer : se mélanger à la musique, ou prendre la main (rendu le plus sûr).
      this.session(this.mix ? 'ambient' : 'playback');
      this.audio.currentTime = 0;
      const p = this.audio.play();
      // Le carillon doit lui aussi être « débloqué » par ce même toucher.
      this.bell.muted = true;
      this.bell.play().then(() => { this.bell.pause(); this.bell.currentTime = 0; this.bell.muted = false; }).catch(() => {});
      this.active = true;
      this.title = title;
      this.update('0 %', true);
      if ('mediaSession' in navigator && !this.mix) {
        for (const action of ['play', 'pause', 'stop', 'seekbackward', 'seekforward']) {
          try { navigator.mediaSession.setActionHandler(action, () => this.audio?.play().catch(() => {})); } catch { /* action non prise en charge */ }
        }
      }
      return p?.catch?.(() => { this.active = false; });
    } catch { this.active = false; return null; }
  }

  /** Relancer la piste si le système l'a coupée (retour dans Safari, fin d'un appel). */
  resume() {
    if (this.active && this.audio?.paused) this.audio.play().catch(() => {});
  }

  /** Progression visible sur l'écran verrouillé. */
  update(text, force = false) {
    const now = performance.now();
    if (!force && now - this.last < 1000) return;
    this.last = now;
    if ('mediaSession' in navigator && window.MediaMetadata && !this.mix) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({ title: this.title || 'SanctiMaps', artist: text, album: 'Studio vidéo SanctiMaps',
          artwork: [{ src: new URL('studio/icons/icon-512.png', location.href).href, sizes: '512x512', type: 'image/png' },
            { src: new URL('studio/icons/icon-192.png', location.href).href, sizes: '192x192', type: 'image/png' }] });
        navigator.mediaSession.playbackState = 'playing';
      } catch { /* sans écran de lecture */ }
    }
  }

  /** Le carillon d'une vidéo terminée, sans arrêter la piste (d'autres vidéos peuvent attendre). */
  async ding(text = 'Vidéo prête') {
    this.update(text, true);
    if (this.mix) this.session('transient');
    try { this.bell.currentTime = 0; await this.bell.play(); await new Promise((r) => setTimeout(r, 900)); } catch { /* pas de son */ }
    if (this.mix && this.active) this.session('ambient');
  }

  async finish(text = 'Vidéo prête') {
    this.update(text, true);
    // Musique gardée : elle baisse le temps du carillon, puis reprend son volume.
    if (this.mix) this.session('transient');
    try { this.bell.currentTime = 0; await this.bell.play(); await new Promise((r) => setTimeout(r, 900)); } catch { /* pas de son */ }
    this.stop();
  }

  stop() {
    this.active = false;
    try { this.audio?.pause(); } catch { /* déjà arrêté */ }
    if ('mediaSession' in navigator && !this.mix) { try { navigator.mediaSession.playbackState = 'none'; } catch { /* rien */ } }
    this.session('auto');
  }
}
