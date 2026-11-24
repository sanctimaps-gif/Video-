// Voix off IA : la synthèse vocale d'ElevenLabs, appelée depuis l'appareil.
//
// Le texte de chaque scène (écrit par le narrateur) est lu par la voix choisie
// sur ElevenLabs — par défaut une voix de conteur française grave, comme
// « Christian Page – Storyteller ». La clé API et l'identifiant de la voix sont
// gardés sur l'appareil seulement (localStorage) ; ils ne vont qu'à ElevenLabs.
// Chaque phrase est demandée avec ses voisines (``previous_text`` /
// ``next_text``) pour que l'intonation s'enchaîne d'une scène à l'autre.

const KEY = 'sanctimaps-studio.voix-ia';
const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
// ``?tts=`` : un autre serveur compatible (tests du studio).
const BASE = (params.get('tts') || 'https://api.elevenlabs.io').replace(/\/$/, '');
export const DEFAULT_MODEL = 'eleven_multilingual_v2';

export function voiceSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { /* réglages illisibles */ }
  return { apiKey: '', voiceId: '', voiceName: '', model: DEFAULT_MODEL, enabled: true, ...s };
}
export function saveVoiceSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* sans stockage */ }
}
export const voiceReady = (s = voiceSettings()) => !!(s.apiKey && s.voiceId);

/**
 * L'identifiant d'une voix, à partir de ce qu'on colle : l'ID lui-même
 * (« Copier l'ID de voix »), ou le lien de la voix (« Copier le lien de la voix »).
 */
export function parseVoiceId(text) {
  const t = String(text || '').trim();
  if (/^[A-Za-z0-9]{16,32}$/.test(t)) return t;
  try {
    const u = new URL(t);
    for (const k of ['voiceId', 'voice_id', 'voice']) if (/^[A-Za-z0-9]{16,32}$/.test(u.searchParams.get(k) || '')) return u.searchParams.get(k);
    const seg = u.pathname.split('/').filter(Boolean).reverse().find((p) => /^[A-Za-z0-9]{16,32}$/.test(p));
    if (seg) return seg;
  } catch { /* pas un lien */ }
  const m = /\b([A-Za-z0-9]{20})\b/.exec(t);
  return m ? m[1] : '';
}

/** Durée d'un enregistrement audio, en secondes. */
export async function audioSeconds(blob) {
  const ctx = new OfflineAudioContext(1, 1, 48000);
  const buf = await ctx.decodeAudioData(await blob.arrayBuffer());
  return buf.duration;
}

class VoiceError extends Error {}

function explain(status, body) {
  const detail = body?.detail || {};
  const code = detail.status || detail.code || '';
  const msg = detail.message || (typeof body?.detail === 'string' ? body.detail : '') || '';
  if (status === 401 || /invalid_api_key|unauthorized/i.test(code)) return 'clé API ElevenLabs refusée (vérifiez-la dans les réglages de la voix off)';
  if (/quota|credits?|insufficient/i.test(`${code} ${msg}`) || status === 402) return 'crédits ElevenLabs épuisés pour ce mois';
  if (/voice_not_found|voice.*not.*found/i.test(`${code} ${msg}`) || status === 404) return 'voix introuvable : sur ElevenLabs, ajoutez-la à « Mes voix », puis recopiez son ID';
  if (/missing_permissions|permission/i.test(`${code} ${msg}`)) return 'la clé API n\'a pas la permission « Text to Speech »';
  return `ElevenLabs a répondu ${status}${msg ? ' : ' + msg : ''}`;
}

// Les phrases déjà lues pendant cette session : « Écouter » puis « Exporter » ne paient qu'une fois.
const cache = new Map();

/**
 * Lit ``text`` avec la voix réglée. Rend ``{ blob, seconds }`` (MP3).
 * ``prev`` / ``next`` : les phrases voisines, pour une intonation continue.
 */
export async function speak(text, { prev = '', next = '', settings = voiceSettings(), signal } = {}) {
  if (!voiceReady(settings)) throw new VoiceError('voix off IA non réglée (clé API et ID de la voix)');
  const body = {
    text, model_id: settings.model || DEFAULT_MODEL,
    ...(prev ? { previous_text: prev } : {}), ...(next ? { next_text: next } : {}),
    // Un conteur : posé mais vivant, fidèle à la voix choisie.
    voice_settings: { stability: 0.42, similarity_boost: 0.82, style: 0.4, use_speaker_boost: true },
  };
  const key = JSON.stringify([settings.voiceId, body]);
  if (cache.has(key)) return cache.get(key);
  const job = (async () => {
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(`${BASE}/v1/text-to-speech/${encodeURIComponent(settings.voiceId)}?output_format=mp3_44100_128`, {
          method: 'POST', signal,
          headers: { 'xi-api-key': settings.apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        if (signal?.aborted) throw e;
        if (attempt >= 2) throw new VoiceError(`ElevenLabs injoignable (${e.message}) — connexion internet ?`);
        await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
        continue;
      }
      if (r.ok) {
        const blob = await r.blob();
        return { blob, seconds: await audioSeconds(blob) };
      }
      let info = null; try { info = await r.json(); } catch { /* corps vide */ }
      // Trop de demandes à la fois : on patiente un peu.
      if ((r.status === 429 || r.status >= 500) && attempt < 3) { await new Promise((res) => setTimeout(res, 2000 * (attempt + 1))); continue; }
      throw new VoiceError(explain(r.status, info));
    }
  })();
  cache.set(key, job);
  job.catch(() => cache.delete(key));
  return job;
}

/**
 * Toutes les phrases d'un storyboard, dans l'ordre (une à la fois, pour ne
 * pas dépasser les limites d'ElevenLabs). Rend ``[{ id, text, blob, seconds }]``.
 */
export async function speakScenario(sc, { settings = voiceSettings(), onProgress = () => {}, signal } = {}) {
  const lines = sc.shots.map((s) => ({ id: s.id, text: (s.narration || '').trim() })).filter((l) => l.text);
  const out = [];
  for (const [i, l] of lines.entries()) {
    onProgress(i, lines.length, l);
    const { blob, seconds } = await speak(l.text, { prev: lines[i - 1]?.text || '', next: lines[i + 1]?.text || '', settings, signal });
    out.push({ ...l, blob, seconds });
  }
  onProgress(lines.length, lines.length);
  return out;
}
