// Le son de la vidéo : une musique composée sur l'appareil, et la voix off.
//
// La vidéo est fabriquée image par image (render.js) : il n'y a pas de micro
// ouvert pendant le rendu, ni de son « capturé ». Le son est donc calculé à
// part, puis encodé en AAC et rangé dans le même MP4 que les images :
//   * la musique : une nappe douce (accords tenus, quelques notes de cloche,
//     un écho), composée par OfflineAudioContext à la durée exacte de la vidéo,
//     avec une entrée et une sortie en fondu ; rien n'est téléchargé, aucun
//     droit d'auteur ;
//   * la voix off : enregistrée par l'utilisateur (« 🎙️ Enregistrer la voix
//     off ») pendant que le texte de chaque scène défile à son moment ; elle est
//     posée au début de la vidéo, et la musique baisse quand la voix parle.
// Sans AudioEncoder (navigateur trop ancien), la vidéo reste muette et on le dit.

export const RATE = 48000;

export function canEncodeAudio() {
  return typeof window !== 'undefined' && typeof window.AudioEncoder === 'function' && typeof window.AudioData === 'function'
    && typeof window.OfflineAudioContext === 'function';
}

/** La configuration AAC que le navigateur sait écrire, ou ``null``. */
export async function audioConfig() {
  if (!canEncodeAudio()) return null;
  // AAC d'abord : c'est ce que lisent Photos, l'iPhone et tous les réseaux ;
  // Opus seulement si le navigateur n'a pas d'encodeur AAC (Chromium libre).
  for (const [config, mux] of [[{ codec: 'mp4a.40.2', sampleRate: RATE, numberOfChannels: 2, bitrate: 160_000 }, 'aac'],
    [{ codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 2, bitrate: 128_000 }, 'aac'],
    [{ codec: 'opus', sampleRate: RATE, numberOfChannels: 2, bitrate: 128_000 }, 'opus']]) {
    try { if ((await AudioEncoder.isConfigSupported(config)).supported) return { ...config, mux }; } catch { /* suivant */ }
  }
  return null;
}

// Ré majeur, recueilli : Ré – Si mineur – Sol – La, puis Sol – Ré – Mi mineur – La.
const CHORDS = [[50, 57, 62, 66], [47, 54, 59, 62], [43, 50, 55, 59], [45, 52, 57, 61],
  [43, 50, 55, 62], [50, 57, 62, 66], [40, 52, 55, 59], [45, 52, 57, 64]];
const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

/** Une musique d'ambiance de ``seconds`` secondes (AudioBuffer stéréo). */
export async function composeMusic(seconds, sampleRate = RATE) {
  const length = Math.max(1, Math.ceil(seconds * sampleRate));
  const ctx = new OfflineAudioContext(2, length, sampleRate);
  const master = ctx.createGain();
  // Entrée et sortie en fondu : la musique ne commence ni ne s'arrête net.
  const fadeIn = Math.min(2, seconds / 4), fadeOut = Math.min(3, seconds / 3);
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(1.1, fadeIn);
  master.gain.setValueAtTime(1.1, Math.max(fadeIn, seconds - fadeOut));
  master.gain.linearRampToValueAtTime(0, seconds);
  // Un écho doux, comme dans une église.
  const dry = ctx.createGain(); dry.gain.value = 0.8;
  const delay = ctx.createDelay(1); delay.delayTime.value = 0.37;
  const feedback = ctx.createGain(); feedback.gain.value = 0.38;
  const wet = ctx.createGain(); wet.gain.value = 0.35;
  const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 2200;
  dry.connect(tone); delay.connect(feedback); feedback.connect(delay); delay.connect(wet); wet.connect(tone);
  tone.connect(master); master.connect(ctx.destination);
  const bus = ctx.createGain(); bus.connect(dry); bus.connect(delay);

  const bar = 4; // secondes par accord
  for (let t = 0, k = 0; t < seconds; t += bar, k++) {
    const chord = CHORDS[k % CHORDS.length];
    const end = Math.min(seconds, t + bar + 1.2);
    // La nappe : chaque note de l'accord, deux oscillateurs légèrement désaccordés.
    chord.forEach((note, i) => {
      for (const [type, detune, level] of [['triangle', -4, 0.05], ['sine', 5, 0.06]]) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = hz(note); o.detune.value = detune;
        const g = ctx.createGain();
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(level * (i === 0 ? 1.2 : 1), t + 1.4);
        g.gain.setValueAtTime(level * (i === 0 ? 1.2 : 1), Math.max(t + 1.4, end - 1.4));
        g.gain.linearRampToValueAtTime(0, end);
        o.connect(g);
        if (pan) { pan.pan.value = (i - 1.5) * 0.25; g.connect(pan); pan.connect(bus); } else g.connect(bus);
        o.start(t); o.stop(end);
      }
    });
    // Deux notes de cloche par accord, une octave au-dessus.
    for (const [offset, idx] of [[0.5, 2], [2.5, 3]]) {
      const at = t + offset; if (at >= seconds - 0.5) continue;
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = hz(chord[idx] + 12);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(0.07, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0005, at + 2.6);
      o.connect(g); g.connect(bus); o.start(at); o.stop(Math.min(seconds, at + 2.7));
    }
  }
  return ctx.startRendering();
}

/** Décode un enregistrement (Blob) en AudioBuffer au bon débit. */
export async function decodeVoice(blob, sampleRate = RATE) {
  const bytes = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(1, 1, sampleRate);
  return ctx.decodeAudioData(bytes);
}

/**
 * Le mélange final, en échantillons : la musique (si demandée), et la voix
 * par-dessus ; la musique s'efface sous la voix et revient entre les phrases.
 * Rend ``{ sampleRate, channels: [gauche, droite] }``.
 */
export function mix(seconds, { music = null, voice = null, sampleRate = RATE } = {}) {
  const n = Math.ceil(seconds * sampleRate);
  const L = new Float32Array(n), R = new Float32Array(n);
  const at = (buf, ch) => buf.getChannelData(Math.min(ch, buf.numberOfChannels - 1));
  let duck = null;
  if (voice) {
    const v = at(voice, 0), m = Math.min(n, v.length);
    // Enveloppe de la voix (fenêtres de 20 ms) → gain de la musique, lissé.
    const win = Math.round(sampleRate * 0.02);
    duck = new Float32Array(Math.ceil(n / win));
    for (let w = 0; w < duck.length; w++) {
      let e = 0; const from = w * win, to = Math.min(m, from + win);
      for (let i = from; i < to; i++) e += v[i] * v[i];
      duck[w] = to > from ? Math.sqrt(e / (to - from)) : 0;
    }
    let g = 1;
    for (let w = 0; w < duck.length; w++) {
      const want = duck[w] > 0.02 ? 0.3 : 1;
      g += (want - g) * (want < g ? 0.5 : 0.04); // baisse vite, remonte doucement
      duck[w] = g;
    }
    duck.win = win;
    for (let i = 0; i < m; i++) { const s = v[i] * 0.95; L[i] += s; R[i] += s; }
  }
  if (music) {
    const ml = at(music, 0), mr = at(music, 1), m = Math.min(n, ml.length);
    for (let i = 0; i < m; i++) {
      const g = duck ? duck[Math.min(duck.length - 1, Math.floor(i / duck.win))] : 1;
      L[i] += ml[i] * g; R[i] += mr[i] * g;
    }
  }
  // Limiteur simple : jamais de saturation.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  if (peak > 0.98) { const k = 0.98 / peak; for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; } }
  return { sampleRate, channels: [L, R] };
}

/** Encode le mélange (AAC, ou Opus à défaut) et le verse dans le muxer MP4. */
export async function encodeAudio(muxer, pcm, config) {
  let failure = null;
  const encoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { failure = e; } });
  const { mux, ...settings } = config;
  encoder.configure(settings);
  const [L, R] = pcm.channels; const n = L.length; const step = 1024;
  try {
    for (let from = 0; from < n; from += step) {
      if (failure) throw failure;
      const len = Math.min(step, n - from);
      const planar = new Float32Array(len * 2);
      planar.set(L.subarray(from, from + len), 0); planar.set(R.subarray(from, from + len), len);
      const data = new AudioData({ format: 'f32-planar', sampleRate: pcm.sampleRate, numberOfFrames: len, numberOfChannels: 2,
        timestamp: Math.round(from * 1e6 / pcm.sampleRate), data: planar });
      encoder.encode(data); data.close();
      if (encoder.encodeQueueSize > 32) await new Promise((r) => setTimeout(r, 0));
    }
    await encoder.flush();
    if (failure) throw failure;
  } finally { try { encoder.close(); } catch { /* déjà fermé */ } }
}

/** Le son d'une vidéo de ``seconds`` secondes, prêt à encoder ; ``null`` s'il n'y en a pas. */
export async function soundtrack(seconds, { music = false, voiceBlob = null, sampleRate = RATE } = {}) {
  if (!music && !voiceBlob) return null;
  const [m, v] = await Promise.all([music ? composeMusic(seconds, sampleRate) : null, voiceBlob ? decodeVoice(voiceBlob, sampleRate) : null]);
  return mix(seconds, { music: m, voice: v, sampleRate });
}
