// Enregistrement de la scène, dans le navigateur.
//
// Ordinateur (Chrome, Edge) : capture de l'onglet, rognée à la scène
// (Region Capture), encodée par MediaRecorder — MP4 (H.264) quand le navigateur
// sait l'écrire, WebM sinon. Firefox et Safari de bureau capturent l'écran ou
// l'onglet choisi, sans rognage.
// iPhone / iPad : le navigateur ne peut pas se filmer lui-même ; le studio
// passe en plein écran et l'on utilise l'enregistrement d'écran d'iOS.

export function canRecord() {
  return !!(navigator.mediaDevices?.getDisplayMedia && window.MediaRecorder);
}

// H.264 explicite d'abord (Chrome récent, Safari), puis WebM ; le « video/mp4 »
// générique en dernier : certains navigateurs l'annoncent sans savoir l'écrire.
const CANDIDATES = ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1',
  'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'];

function pickMime(stream) {
  for (const mime of CANDIDATES) {
    if (!MediaRecorder.isTypeSupported(mime)) continue;
    try { new MediaRecorder(stream, { mimeType: mime }); return mime; } catch { /* suivant */ }
  }
  return '';
}

export class StageRecorder {
  constructor(stageEl) { this.stageEl = stageEl; this.chunks = []; }

  async prepare() {
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30, displaySurface: 'browser' },
      audio: false, preferCurrentTab: true, selfBrowserSurface: 'include', surfaceSwitching: 'exclude',
    });
    const [track] = this.stream.getVideoTracks();
    this.cropped = false;
    try {
      // Region Capture (rognage) d'abord : Element Capture n'émet aucune image
      // quand l'élément ne remplit pas toutes ses conditions.
      if (window.CropTarget && track.cropTo) {
        await track.cropTo(await CropTarget.fromElement(this.stageEl)); this.cropped = true;
      } else if (window.RestrictionTarget && track.restrictTo) {
        await track.restrictTo(await RestrictionTarget.fromElement(this.stageEl)); this.cropped = true;
      }
    } catch { this.cropped = false; }
    track.addEventListener('ended', () => this.onEnded?.());
    return this.cropped;
  }

  /** Choisit un format que le navigateur sait réellement écrire. */
  async probe() { this.mime = pickMime(this.stream); return this.mime; }

  start() {
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, { mimeType: this.mime || undefined, videoBitsPerSecond: 12_000_000 });
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(500);
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.rec || this.rec.state === 'inactive') { resolve(null); return; }
      this.rec.onstop = () => {
        this.stream.getTracks().forEach((t) => t.stop());
        const type = this.rec.mimeType || this.mime || 'video/webm';
        const blob = new Blob(this.chunks, { type });
        resolve({ blob, ext: type.includes('mp4') ? 'mp4' : 'webm', type });
      };
      this.rec.stop();
    });
  }
}
