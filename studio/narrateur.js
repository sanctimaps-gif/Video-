// Narrateur : le texte de la voix off, écrit comme une histoire.
//
// Le réalisateur (realisateur.js) décide de ce que la caméra montre ; le
// narrateur écrit ce que la voix raconte pendant ce temps-là :
//   * une ACCROCHE dès la première seconde (âge, énigme, flash-back, date,
//     question…) pour retenir l'auditeur ;
//   * une HISTOIRE scène après scène (le pays, la naissance, la vie, les lieux
//     et leurs anecdotes), au rythme des images ;
//   * une FIN qui donne envie d'aller sur SanctiMaps.
// Tout vient des données du site (fiches, dates, lieux, anecdotes, patronages) :
// rien n'est inventé. Le hasard (une graine différente à chaque génération)
// choisit parmi plusieurs accroches, tournures et fins, et évite celles des
// dernières vidéos : deux vidéos sur le même saint ne se ressemblent pas.
// Ce que la demande impose (texte exact de la voix off, ton, type d'accroche)
// passe toujours avant le hasard.
import { fold } from './sanctimaps.js';

/** Débit de la voix off (mots par seconde) : une voix de conteur, posée. */
export const WPS = 2.35;
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const ROLE = {
  king: ['roi', 'reine'], queen: ['roi', 'reine'], bishop: ['évêque', 'évêque'], priest: ['prêtre', 'religieuse'], monk: ['moine', 'moniale'],
  nun: ['religieux', 'religieuse'], martyr: ['martyr', 'martyre'], missionary: ['missionnaire', 'missionnaire'], pope: ['pape', 'pape'],
  founder: ['fondateur', 'fondatrice'], hermit: ['ermite', 'ermite'], soldier: ['soldat', 'soldate'], abbot: ['abbé', 'abbesse'],
  abbess: ['abbé', 'abbesse'], mystic: ['mystique', 'mystique'], apostle: ['apôtre', 'apôtre'], doctor: ['docteur de l\'Église', 'docteur de l\'Église'],
  virgin: ['', 'jeune femme'], preacher: ['prédicateur', 'prédicatrice'], pilgrim: ['pèlerin', 'pèlerine'], widow: ['', 'veuve'],
};

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const words = (t) => (String(t || '').trim().match(/\S+/g) || []).length;
/** Durée parlée estimée d'un texte, en secondes. */
export const speechSeconds = (t) => (t ? words(t) / WPS + 0.35 : 0);
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);
const low = (t) => (t ? t[0].toLowerCase() + t.slice(1) : t);
const dot = (t) => (t && !/[.!?…]$/.test(t.trim()) ? `${t.trim()}.` : t.trim());
const andList = (t) => String(t || '').replace(/,\s*([^,]+)$/, ' et $1');
const year = (y) => (y < 0 ? `${-y} avant Jésus-Christ` : String(y));

// Le français des noms de pays : « en Hongrie », « au Portugal », « aux États-Unis » ; « la Hongrie », « le Portugal ».
const MASC_E = /^(mexique|cambodge|mozambique|zimbabwe|belize|bélize|suriname|vatican)/i;
const PLURAL = /^(états-unis|etats-unis|pays-bas|philippines|émirats|emirats|comores|maldives|seychelles|bahamas|fidji|îles|iles|samoa)/i;
const NO_ARTICLE = /^(israël|israel|cuba|madagascar|malte|chypre|singapour|monaco|haïti|haiti|bahreïn|oman|djibouti|taïwan|taiwan|sainte-|saint-|andorre)/i;
/** « basilique Saint-Martin » → « la basilique Saint-Martin » ; un nom de ville reste tel quel. */
export function withArticle(nom) {
  const n = String(nom || '').trim();
  // Quelques lieux célèbres qui prennent l'article malgré leur majuscule.
  if (/^(Sainte-Chapelle|Portioncule|Verna|Grande-Chartreuse|Chartreuse|Sorbonne|Salette|Trappe)\b/.test(n)) return `la ${n}`;
  // Un nom commun en tête, avec majuscule (« Institut biblique pontifical », « Université de Rome ») : il prend l'article.
  const cm = /^(Institut|Université|Séminaire|Collège|Basilique|Cathédrale|Abbaye|Église|Monastère|Couvent|Sanctuaire|Hôpital|Palais|Château|Prieuré|Chapelle|Grotte|Carmel|Oratoire|Académie|École)(?=\s|$)/.exec(n);
  if (cm) return `${/^[AEIOUÉÈÊÂÎÔÛH]/.test(cm[1]) ? "l'" : /^(Université|Basilique|Cathédrale|Abbaye|Église|Chapelle|Grotte|Académie|École)$/.test(cm[1]) ? 'la ' : 'le '}${n}`;
  const m = /^([a-zàâçéèêëîïôûùüÿœ]+)\b/.exec(n);
  if (!m) return n;
  const w = m[1];
  if (/^(basilique|église|eglise|abbaye|cathédrale|cathedrale|chapelle|collégiale|maison|grotte|prison|place|ville|cité|paroisse|crypte)$/.test(w)) return `${/^[aeiouéèêâîôû]/.test(w) ? "l'" : 'la '}${n}`;
  if (/^(monastère|monastere|couvent|carmel|sanctuaire|prieuré|prieure|château|chateau|palais|séminaire|seminaire|collège|college|mont|tombeau|village|hôpital|hopital|oratoire|ermitage)$/.test(w)) return `${/^[aeiouéèêâîôûh]/.test(w) ? "l'" : 'le '}${n}`;
  return n;
}
/**
 * Certaines anecdotes du site commencent sans verbe principal (« Le carmel où
 * elle entra à quinze ans… ») : pour la voix, elles deviennent une vraie
 * phrase (« Voici le carmel où elle entra à quinze ans… »).
 */
function asSentence(text) {
  const t = String(text || '').trim();
  const first = t.split(/(?<=[.!?])\s+/)[0] || '';
  const head = first.split(/,/)[0];
  // (\b ne connaît pas les accents : « où » se repère entre espaces.)
  const REL = /(?:^|\s)(?:où|qui|que|dont)(?=\s|$)/;
  if (/^(Le|La|Les|L')\s?\S/.test(first) && REL.test(head) && !/(?:^|\s)(?:est|sont|fut|furent|était|a|ont)(?=\s|$)/.test(head.split(REL)[0])) {
    return `Voici ${low(t)}`;
  }
  return t;
}

/**
 * Une anecdote dite loin de son lieu : « Il y meurt… » devient « À Candes, il
 * meurt… » — une seule phrase, qui dit où l'on est et qu'on ne peut pas couper.
 */
function placed(nom, t) {
  if (!t || !/(?:^|\s)(?:y|ici|là)(?=\s|[,.])/.test(t)) return t;
  const [first, ...rest] = t.split(/(?<=[.!?])\s+/);
  if (/(?:^|\s)(?:il|elle|ils|elles|on) y(?=\s)/i.test(first)) {
    const body = first.replace(/(^|\s)(il|elle|ils|elles|on) y(?=\s)/i, '$1$2');
    const lowered = /^(Il|Elle|Ils|Elles|On|C'est|Le|La|Les|Un|Une|Sa|Son|Ses|Soldat|Jeune|Enfant)\b/.test(body) ? low(body) : body;
    return [`${cap(atPlace(nom))}, ${lowered}`, ...rest].join(' ');
  }
  return `Nous sommes ${atPlace(nom)}. ${t}`;
}

/**
 * Anecdotes sourcées (Wikipédia, confirmées par Nominis quand c'est possible),
 * rassemblées par tools/anecdotes.py : un petit fichier par première lettre de
 * l'identifiant du saint, chargé seulement quand on en a besoin.
 */
const anecdoteFiles = new Map();
export async function sourcedAnecdotes(saintId) {
  const key = fold(saintId).slice(0, 1) || '_';
  if (!anecdoteFiles.has(key)) {
    anecdoteFiles.set(key, fetch(new URL(`./data/anecdotes/${key}.json`, import.meta.url)).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
  }
  return (await anecdoteFiles.get(key))[saintId] || [];
}

/** Une légende est toujours dite comme telle (« Selon la tradition, … »). */
function asLegend(text) {
  if (/\b(selon|légende|légendaire|tradition|on raconte|raconte-t-on|dit-on|rapporte-t-on|on lui attribue)\b/i.test(text)) return text;
  return `Selon la tradition, ${low(text)}`;
}

/** « de Antoine » → « d'Antoine ». */
const deName = (name) => (/^[aeiouyéèêâîôûhAEIOUYÉÈÊÂÎÔÛH]/.test(name) ? `d'${name}` : `de ${name}`);
// « à Le Caire » → « au Caire », « à Les Sables » → « aux Sables ».
const atPlace = (nom) => { const a = withArticle(nom); return /^le /i.test(a) ? `au ${a.slice(3)}` : /^les /i.test(a) ? `aux ${a.slice(4)}` : `à ${a}`; };

export function countryGrammar(name) {
  const n = String(name || '');
  // « la Hongrie », « le Honduras » : le h des pays est aspiré.
  const vowel = /^[aeiouyéèêâîôûAEIOUYÉÈÊÂÎÔÛ]/.test(n);
  if (NO_ARTICLE.test(n)) return { en: `${/^(cuba|madagascar|malte|chypre|singapour|monaco|haïti|haiti|bahreïn|oman|djibouti|taïwan|taiwan)/i.test(n) ? 'à' : 'en'} ${n}`, le: n, de: vowel ? `d'${n}` : `de ${n}` };
  if (PLURAL.test(n)) return { en: `aux ${n}`, le: `les ${n}`, de: `des ${n}` };
  const fem = /e$/i.test(n) && !MASC_E.test(n);
  if (vowel) return { en: `en ${n}`, le: `l'${n}`, de: `d'${n}` };
  return fem ? { en: `en ${n}`, le: `la ${n}`, de: `de ${n}` } : { en: `au ${n}`, le: `le ${n}`, de: `du ${n}` };
}

/**
 * Coupe un texte à ``max`` mots, entre deux phrases : jamais au milieu d'une
 * phrase (une idée coupée ne veut plus rien dire). ``allowComma`` : pour une
 * énumération (« Roi de France, bâtisseur…, mort à Tunis »), on peut couper à
 * une virgule.
 */
export function fit(text, max, allowComma = false) {
  text = String(text || '').replace(/\s+/g, ' ').trim();
  if (!text || max < 2) return '';
  if (words(text) <= max) return text;
  const sentences = text.split(/(?<=[.!?…])\s+/);
  let out = '', kept = 0;
  for (const s of sentences) { const next = out ? `${out} ${s}` : s; if (words(next) > max) break; out = next; kept++; }
  // Une question dont la réponse ne tient plus n'est pas posée : on la retire aussi.
  while (kept && kept < sentences.length && (/\?\s*$/.test(out) || /^Nous sommes\b/.test(sentences[kept - 1]))) { kept--; out = sentences.slice(0, kept).join(' '); }
  if (out || !allowComma) return out;
  const parts = sentences[0].split(/,\s+/);
  out = '';
  for (const p of parts) { const next = out ? `${out}, ${p}` : p; if (words(next) > max) break; out = next; }
  return out && words(out) >= 3 ? dot(out) : '';
}

/** Une biographie de fiche, rendue racontable : sans parenthèses ni noms à rallonge. */
export function storySentences(bio) {
  return String(bio || '')
    .replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '')
    .replace(/,\s*(?:aussi|parfois|plus communément|plus connue?)\s+(?:nommée?|appelée?|dite?|sous les noms? de)[^,]*,/g, ',')
    .replace(/\s+/g, ' ').replace(/\s*,(\s*,)+/g, ',').replace(/\s+([,.])/g, '$1')
    .split(/(?<=[.!?])\s+(?=[A-ZÉÈÀÂÎÔ«])/)
    .map((s) => s.trim()).filter((s) => words(s) >= 5);
}

/**
 * Ce que la demande impose à la voix off : un texte exact, un ton, un type
 * d'accroche, ou pas de voix du tout.
 */
export function voiceWishes(request) {
  const text = String(request || '').replace(/[’`]/g, "'");
  const t = fold(text);
  const w = { verbatim: null, tone: null, hook: null, none: false, cta: true };
  const m = /\b(?:voix off|voix|narrat\w*|narration|commentaire)\b[^«"“]{0,40}?(?:dit|dise|raconte|lit|lise|prononce|:)\s*[«"“]\s*([^»"”]{3,600}?)\s*[»"”]/i.exec(text);
  if (m) w.verbatim = m[1].trim();
  if (/\b(sans|pas de|aucune) (voix|narration|commentaire)\b/.test(t)) w.none = true;
  if (/\b(mysteri\w*|enigm\w*|intrig\w*|suspense)\b/.test(t)) w.tone = 'mystere';
  else if (/\b(epique|heroique|grandiose|puissant\w*|spectaculaire)\b/.test(t)) w.tone = 'epique';
  else if (/\b(emouv\w*|emotion\w*|touchant\w*|poignant\w*|douce?|tendre)\b/.test(t)) w.tone = 'emotion';
  else if (/\b(enfants?|jeunes?|ado\w*|ludique|fun|drole|humour)\b/.test(t)) w.tone = 'ludique';
  if (/\b(commence|debute|ouvre|accroche)\w*\b[^.]{0,30}\bquestion\b/.test(t)) w.hook = 'question';
  else if (/\b(commence|debute|ouvre|accroche)\w*\b[^.]{0,30}\b(chiffre|date|annee|age)\b/.test(t)) w.hook = 'chiffre';
  else if (/\b(commence|debute|ouvre|accroche)\w*\b[^.]{0,30}\b(fin|mort|deces)\b/.test(t)) w.hook = 'flashback';
  if (/\b(sans|pas d) (appel|invitation|publicite|pub)\b/.test(t)) w.cta = false;
  Object.assign(w, ideeGenerale(text));
  return w;
}

// Les angles qu'une demande peut donner à une vie de saint : chacun oriente
// l'accroche, les phrases choisies dans la fiche et la révélation de la fin.
const ANGLES = {
  jeunesse: { re: /\b(jeune|jeunesse|ado\w*|adolescen\w*|si jeune|a \d+ ans|tres tot|enfance)\b/, words: ['ans', 'jeune', 'enfant', 'âge', 'treize', 'quinze', 'dix-neuf', 'vingt'], label: 'sa jeunesse' },
  courage: { re: /\b(courag\w*|combat\w*|guerr\w*|bataill\w*|hero\w*|bravoure|resist\w*|force|audace|lutt\w*)\b/, words: ['délivr', 'guerre', 'siège', 'combat', 'armée', 'mission', 'affirme', 'refuse', 'résist'], label: 'son courage' },
  mort: { re: /\b(morte?s?|meur\w*|mourir|mourut|martyr\w*|bucher|brule\w*|supplice|tombeau|sepulture|reliques?|deces)\b/, words: ['mort', 'meurt', 'mourut', 'bûcher', 'brûlé', 'martyr', 'tombeau', 'repose', 'reliques'], label: 'sa mort et ce qu\'il en reste' },
  miracle: { re: /\b(miracles?|prodiges?|merveill\w*|guerison\w*|stigmates|apparitions?|visions?|voix)\b/, words: ['miracle', 'vision', 'voix', 'stigmates', 'apparu', 'fleurirent', 'guéri'], label: 'le merveilleux de sa vie' },
  voyage: { re: /\b(voyag\w*|parcours|chemins?|traces?|pas|itineraire|lieux|traverse\w*|route)\b/, words: ['part', 'quitte', 'voyage', 'route', 'traverse', 'rejoint'], label: 'son parcours' },
  charite: { re: /\b(charite|pauvres?|partag\w*|manteau|humble|humilite|pauvrete|aide\w*|genero\w*|soign\w*|malades?)\b/, words: ['pauvre', 'partag', 'manteau', 'pauvreté', 'charité', 'soign', 'malade', 'humble', 'mendiant', 'donn', 'aumône'], label: 'sa charité' },
  protection: { re: /\b(patron\w*|protect\w*|invoqu\w*|prier|prie|intercession)\b/, words: ['patron', 'veille', 'protège'], label: 'ceux qu\'il protège' },
  fondation: { re: /\b(fond\w*|ordre|monasteres?|abbayes?|construi\w*|bati\w*|batisseur|oeuvre)\b/, words: ['fonde', 'fonda', 'ordre', 'bâtisseur', 'construit', 'abbaye', 'monastère'], label: 'ce qu\'il a fondé' },
  foi: { re: /\b(vocation|appel|conversion|convert\w*|foi|priere|mystique|dieu)\b/, words: ['convertit', 'foi', 'prière', 'mystique', 'vocation', 'entre', 'carmel'], label: 'sa foi' },
};
const STOP = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'd', 'l', 'et', 'ou', 'a', 'au', 'aux', 'en', 'sur', 'pour', 'par', 'avec', 'sans', 'dans', 'que', 'qui', 'quoi', 'son', 'sa', 'ses', 'ce', 'cette', 'il', 'elle', 'est', 'fais', 'fait', 'faire', 'cree', 'creer', 'moi', 'video', 'videos', 'secondes', 'seconde', 'minute', 'minutes', 'montre', 'montrer', 'raconte', 'raconter', 'saint', 'sainte', 'saints', 'vie', 'histoire', 'tiktok', 'reel', 'short', 'format', 'vertical', 'verticale', 'horizontal', 'dynamique', 'pourquoi', 'comment', 'voix', 'off', 'musique', 'je', 'veux', 'une', 'presente', 'parle', 'parler']);

/**
 * L'idée générale d'une demande, au-delà des mots-clés : l'angle de la vidéo
 * (courage, jeunesse, miracle, parcours…), le public, la question que se pose
 * l'auteur, et la façon de s'adresser à l'auditeur. Tout le script s'aligne
 * sur cette idée unique (« une seule idée par vidéo »).
 */
export function ideeGenerale(request) {
  const text = String(request || '').replace(/[’`]/g, "'");
  const t = fold(text);
  // L'angle : le premier qui correspond à la demande, en dehors des noms propres.
  const plain = fold(text.replace(/\b(?:saint|sainte)\s+[A-ZÉÈ][\wéèêàâîôûç'-]+(?:\s+(?:de|d'|du|la|le)\s*[A-ZÉÈ][\wéèêàâîôûç'-]+)*/g, ' '));
  const angles = Object.entries(ANGLES).filter(([, a]) => a.re.test(plain)).map(([k]) => k);
  const audience = /\b(enfants?|petits|ecoliers?|eleves?|classe|catechisme|caté)\b/.test(t) ? 'enfants'
    : /\b(jeunes|ados?|adolescents?|etudiants?|lyceens?|collegiens?|tiktok|reels?|shorts?)\b/.test(t) ? 'jeunes'
      : /\b(touristes?|visiteurs?|pelerins?|voyageurs?)\b/.test(t) ? 'visiteurs' : 'tous';
  // Une question posée dans la demande (« pourquoi saint Martin a-t-il coupé son manteau ? ») :
  // la vidéo l'ouvre en accroche et y répond à la fin.
  const qm = /\b(pourquoi|comment|qui|ou|quand|quel(?:le)?s?|qu'est-ce qui|qu'est-ce que|que)\b\s+([^?.!]{6,140})\?/i.exec(text)
    || /\b(?:explique|raconte|montre)\s+(pourquoi|comment)\s+([^?.!]{6,140})/i.exec(text);
  let question = null;
  if (qm) question = `${cap(qm[1].toLowerCase())} ${qm[2].trim().replace(/\s+/g, ' ')} ?`;
  // « Une vidéo qui montre que François d'Assise aimait les animaux » : l'idée à prouver devient la question d'ouverture.
  const claim = /\b(?:montre|montrer|prouve|prouver|explique|expliquer|raconte|raconter)\s+(?:bien\s+)?(?:que|qu')\s*([^.!?]{6,140})/i.exec(text);
  if (!question && claim) question = `Sais-tu pourquoi on dit qu${/^[aeiouyéèêh]/i.test(claim[1].trim()) ? "'" : 'e '}${claim[1].trim().replace(/\s+/g, ' ')} ?`;
  // Les mots qui portent l'idée : ils choisissent les phrases de la fiche qui y répondent.
  const topic = [...new Set(plain.split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)))];
  const tu = !/\b(vouvoi\w*|formel\w*|solennel\w*)\b/.test(t);
  return { angles, angle: angles[0] || null, audience, question, topic, tu };
}

/**
 * Le tutoiement (« Sais-tu… ? », « Et toi… ? ») : sur les réseaux, on parle à
 * une personne, pas à une foule. Les textes sont écrits au vouvoiement puis
 * convertis ; « Rendez-vous sur SanctiMaps » reste tel quel.
 */
const TU = [
  [/\bSavez-vous\b/g, 'Sais-tu'], [/\bsavez-vous\b/g, 'sais-tu'], [/\bSaviez-vous\b/g, 'Savais-tu'],
  [/\bConnaissez-vous\b/g, 'Connais-tu'], [/\bconnaissez-vous\b/g, 'connais-tu'], [/\bVoulez-vous\b/g, 'Veux-tu'],
  [/\bAvez-vous\b/g, 'As-tu'], [/\ballez-vous\b/g, 'vas-tu'], [/\bdécouvrirez-vous\b/g, 'découvriras-tu'],
  [/\bEt vous,/g, 'Et toi,'], [/\bchez vous\b/g, 'chez toi'], [/\bvous attendent\b/g, "t'attendent"], [/\bvous attend\b/g, "t'attend"],
  [/\bvous raconter\b/g, 'te raconter'], [/\bvous la raconter\b/g, 'te la raconter'], [/\bvous mener\b/g, 'te mener'],
  [/\bvous montrer\b/g, 'te montrer'], [/\bvous répond\b/g, 'te répond'], [/\bvous réponde\b/g, 'te réponde'],
  [/\bque vous ne l'imaginez\b/g, "que tu ne l'imagines"], [/\bSuivez\b/g, 'Suis'], [/\bExplorez\b/g, 'Explore'],
  [/\bRetrouvez-/g, 'Retrouve-'], [/\bRetrouvez\b/g, 'Retrouve'], [/\bRegardez\b/g, 'Regarde'], [/\bRestez\b/g, 'Reste'],
  [/\bvous montre\b/g, 'te montre'], [/\bque vous cherchez\b/g, 'que tu cherches'], [/\bVous pouvez\b/g, 'Tu peux'], [/\bVous y trouverez\b/g, 'Tu y trouveras'],
  [/\bvous reliez\b/g, 'tu relies'], [/\bposez vos questions\b/g, 'pose tes questions'], [/\bon vous répond\b/g, 'on te répond'],
  [/\bs'adapte à vous\b/g, "s'adapte à toi"], [/\bvous apporte\b/g, "t'apporte"], [/\brendez-vous dans\b/g, 'rends-toi dans'],
  [/\bEt si vous appreniez\b/g, 'Et si tu apprenais'], [/\bconnaissez-vous vraiment\b/g, 'connais-tu vraiment'], [/\bTestez-vous\b/g, 'Teste-toi'],
  [/\bPouvez-vous\b/g, 'Peux-tu'], [/\bSaurez-vous\b/g, 'Sauras-tu'], [/\bvous attendait\b/g, "t'attendait"],
  [/\bà votre heure\b/g, 'à ton heure'], [/\bdans votre\b/g, 'dans ta'],
  [/\bvotre\b/g, 'ta'], [/\bVous croyez\b/g, 'Tu crois'], [/\bpour vous\b/g, 'pour toi'], [/\bavec vous\b/g, 'avec toi'],
];
export function tutoie(text) {
  let out = String(text || '');
  for (const [re, by] of TU) out = out.replace(re, by);
  return out;
}

export class Narrateur {
  /**
   * ``seed`` : la graine du hasard (une par génération) ; ``avoid`` : les
   * accroches et fins des dernières vidéos, à ne pas reprendre ; ``total`` :
   * le nombre de saints du site (pour la fin).
   */
  constructor(data, { seed = Date.now(), avoid = [], saintsCount = 0 } = {}) {
    this.data = data; this.seed = seed >>> 0;
    // « plus de 4 500 saints » : le nombre du site, arrondi à la centaine inférieure.
    this.saintsCount = saintsCount >= 100 ? Math.floor(saintsCount / 100) * 100 : 0; this.rand = rng(this.seed); this.avoid = new Set(avoid); this.used = [];
  }
  pick(list) { return list[Math.floor(this.rand() * list.length)]; }
  /** Une option parmi celles qui conviennent, en évitant les dernières utilisées. */
  choose(options, prefer = null) {
    let pool = options.filter((o) => o && o.text);
    if (prefer) { const p = pool.filter((o) => o.tags?.includes(prefer)); if (p.length) pool = p; }
    const fresh = pool.filter((o) => !this.avoid.has(o.id));
    const o = this.pick(fresh.length ? fresh : pool);
    if (o) this.used.push(o.id);
    return o;
  }

  /**
   * Écrit la voix off du storyboard ``sc`` : ``shot.narration`` pour les scènes
   * qui parlent, vide pour celles que la voix précédente recouvre. ``ctx`` :
   * ``{ brief, saint, lieux }``.
   */
  async write(sc, { brief, saint = null, wishes = voiceWishes(brief?.request) } = {}) {
    const facts0 = saint ? await this.facts(saint) : null;
    const F_hasStory = (shot) => !!facts0?.anecdotes.some((a) => fold(a.nom) === fold(shot.beat?.nom || shot.params?.near || ''));
    sc.voice = { seed: this.seed, wishes };
    this.idea = wishes;
    // Les mots qui portent l'idée de la demande (et ceux de son angle) : ils choisissent les phrases.
    this.topicWords = [...(wishes.topic || []), ...(wishes.angles || []).flatMap((a) => ANGLES[a]?.words || [])].map((w) => fold(w));
    // Les phrases déjà prévues par le réalisateur (démonstration, message demandé) servent de base.
    this.base = new Map(sc.shots.map((s) => [s, s.baseNarration ?? s.narration ?? '']));
    for (const s of sc.shots) { s.baseNarration = this.base.get(s); s.narration = ''; }
    if (wishes.none) { sc.voice.off = true; return sc; }
    const beats = this.beatsOf(sc);
    if (!beats.length) return sc;
    // Le temps de parole de chaque scène qui parle : jusqu'à la suivante qui parle.
    const spans = beats.map((b, k) => {
      const end = k + 1 < beats.length ? beats[k + 1].index : sc.shots.length;
      return sc.shots.slice(b.index, end).reduce((a, s) => a + (s.duration || 0), 0);
    });
    if (wishes.verbatim) return this.verbatim(sc, beats, spans, wishes.verbatim);
    // Les mots disponibles pour toute la vidéo, partagés selon l'importance de
    // chaque moment : l'accroche et la vie du saint d'abord. Les scènes
    // s'ajusteront ensuite au texte (réalisateur), pas l'inverse.
    const totalWords = Math.max(14, Math.floor((sc.target || spans.reduce((a, b) => a + b, 0)) * WPS * 0.82));
    const last = beats.length - 1;
    const want = beats.map((b, k) => {
      const a = sc.shots[b.index].action;
      // Vidéo courte : accroche et fin plus brèves, pour laisser place à l'histoire.
      const tight = (sc.target || 45) <= 25;
      if (k === 0) return tight ? 17 : 24;
      if (k === last) return tight ? 11 : 18;
      if (['show_profile', 'open_saint', 'open_list_item', 'open_marker'].includes(a)) return (sc.target || 45) >= 45 ? 40 : 30;
      if (a === 'frame_view') return F_hasStory(sc.shots[b.index]) ? 32 : 16;
      if (['zoom_to_place', 'pan_to_place'].includes(a)) return 15;
      if (['open_country', 'fit_country', 'open_continent'].includes(a)) return 11;
      // Une partie de l'application : sa phrase entière (elle dit à quoi sert la partie).
      if (['show_section', 'calendar', 'search_list', 'open_tab', 'apparitions_on'].includes(a)) return 28;
      return 12;
    });
    const facts = facts0;
    // Les mots du nom du saint ne disent rien de l'idée (« François » ne doit pas choisir la basilique Saint-François).
    if (facts) { const nameWords = new Set(fold(facts.name).split(/[^a-z0-9]+/)); this.topicWords = this.topicWords.filter((w) => !nameWords.has(w)); }
    // Les saints présentés en chemin (« un visage du lieu ») : leurs faits aussi.
    this.others = new Map();
    for (const s of sc.shots) {
      const id = s.beat?.saintId;
      if (id && !this.others.has(id)) { const S2 = (await this.data.saints()).find((x) => x.id === id); if (S2) this.others.set(id, await this.facts(S2)); }
    }
    const tone = wishes.tone;
    // Pour l'accroche d'une vidéo sur un pays : le nombre de saints que la carte y compte.
    this.placeCount = brief?.focus === 'place' && brief.countries?.[0] ? (await this.data.saintsIn(brief.countries[0])).length : 0;
    const rank = (k) => {
      if (k === 0) return 0;
      if (k === last) return 1;
      const sh = sc.shots[beats[k].index];
      if (['show_profile', 'open_saint', 'open_list_item', 'open_marker'].includes(sh.action)) return 2;
      if (sh.action === 'frame_view' && F_hasStory(sh)) return 3;
      if (['show_section', 'calendar'].includes(sh.action)) return 2;
      if (sh.beat?.kind === 'birth' || sh.beat?.famous) return 4;
      if (sh.action === 'frame_view') return 5;
      if (['zoom_to_place', 'pan_to_place'].includes(sh.action)) return 6;
      if (['show_lieux', 'show_croises'].includes(sh.action)) return 7;
      return 8;
    };
    // Le parcours numéroté (« Première étape… dernière étape ») : quand le parcours
    // est le sujet, ou une fois sur trois s'il compte au moins trois lieux.
    const tour = beats.map((b) => sc.shots[b.index]).filter((x) => x.action === 'frame_view');
    this.numbered = tour.length >= 2 && (this.used.includes('nombre') || (wishes.angles || []).includes('voyage') || (tour.length >= 3 && this.rand() < 0.35));
    this.tourIndex = new Map(tour.map((x, i) => [x, { i, n: tour.length }]));
    // La réponse à la question de la demande est mise de côté dès le départ : elle
    // ne sera dite qu'à la fin (et pas avant, en passant).
    this.reserved = wishes.question && facts ? this.bestSentence(facts, '') : '';
    this.kindShots = new Map(); this.kindTally = {};
    // 1. Chaque moment écrit sa meilleure phrase, sans se soucier de la place.
    const texts = [];
    for (const [k, b] of beats.entries()) {
      const shot = sc.shots[b.index]; const max = want[k];
      const room = max + (k === 0 ? 4 : k === last ? 3 : 2);
      let text = '';
      if (k === 0) text = this.hook(sc, brief, facts, tone, wishes.hook, max);
      else if (k === last && wishes.cta) text = this.ending(sc, brief, facts, tone, max);
      else {
        // Une phrase trop longue : on en tire une autre, puis une plus courte.
        for (let t = 0; t < 4 && !fit(text, room); t++) text = this.middle(shot, sc, brief, facts, tone, max, k, t);
        if (!fit(text, room)) text = this.short(shot, facts);
      }
      texts[k] = fit(text, room);
      shot.narration = texts[k]; // visible des suivants : pas de redite
    }
    // 2. Par ordre d'importance, on garde ce qui tient dans la durée ; le reste
    //    se tait (ou se dit en plus court) et la voix d'avant le recouvre.
    let left = totalWords;
    const keep = beats.map(() => '');
    for (const k of beats.map((_, j) => j).sort((a, b) => rank(a) - rank(b) || a - b)) {
      this.saidText = keep.join(' ');
      // Trop long : d'abord la même phrase sans sa question de relance, puis une plus courte.
      const bare = k > 0 && k < last && texts[k] ? texts[k].replace(/^[^.!?]*\?\s+/, '') : '';
      const tries = [texts[k], bare !== texts[k] && words(bare) >= 6 ? bare : '', k > 0 && k < last ? this.short(sc.shots[beats[k].index], facts, left) : ''].filter(Boolean);
      const t = tries.find((x) => words(x) <= left || k === 0 || k === last);
      if (t) { keep[k] = t; left -= words(t); }
    }
    // Le parcours numéroté, sur les seuls lieux qui parlent vraiment (« Première étape… Et dernière étape… »).
    if (this.numbered) {
      const told = beats.map((b, j) => j).filter((j) => keep[j] && sc.shots[beats[j].index].action === 'frame_view' && !/^Nous (voici|revoilà|sommes)/.test(keep[j]));
      if (told.length >= 2) told.forEach((j, n) => { keep[j] = this.step(n, told.length, keep[j]); });
    }
    // L'auditeur est interpellé en cours de route aussi : sans question au
    // milieu, la fiche (ou le premier lieu) en reçoit une.
    if (facts && !wishes.question && !keep.slice(1, last).some((t) => t.includes('?'))) {
      const ok = (t, j) => t && j > 0 && j < last && words(t) >= 8 && !/^(Nous |Et c'est ici|Première|Deuxième|Troisième|Quatrième|Cinquième|Et dernière|Et voici la réponse)/.test(t);
      let k = keep.findIndex((t, j) => ok(t, j) && ['open_saint', 'show_profile'].includes(sc.shots[beats[j].index].action));
      if (k < 0) k = keep.findIndex((t, j) => ok(t, j) && sc.shots[beats[j].index].action === 'frame_view');
      if (k > 0) keep[k] = `${this.pick([`Mais qui était-${facts.il} vraiment ?`, `Que sait-on de sa vie ?`, `Pourquoi se souvient-on encore ${facts.f ? "d'elle" : 'de lui'} ?`])} ${keep[k]}`;
    }
    // La récompense, gardée pour la fin : la réponse à la question de la demande,
    // juste avant l'appel final (le guide : promesse forte, mais tenue).
    if (wishes.question && facts && last > 1) {
      const answer = this.reserved || this.bestSentence(facts, keep.join(' '));
      const k = keep.map((t, j) => j).filter((j) => j > 0 && j < last).pop();
      // La scène qui porte la réponse ne sera pas retirée pour tenir la durée.
      if (answer && k) { keep[k] = `Et voici la réponse. ${answer}`; sc.voice.answer = answer; sc.shots[beats[k].index].priority = 1; }
    }
    beats.forEach((b, k) => { sc.shots[b.index].narration = wishes.tu === false ? keep[k] : tutoie(keep[k]); });
    // Les sources des anecdotes dites : affichées sous le storyboard.
    const said = keep.join(' ');
    sc.voice.sources = facts ? facts.anecdotes.filter((a) => a.url && said.includes(fit(a.text, 40).slice(0, 40))).map((a) => ({ source: a.source, url: a.url, confirmed: a.confirmed })) : [];
    sc.voice.idea = { angle: wishes.angle, angles: wishes.angles, audience: wishes.audience, question: wishes.question, tu: wishes.tu !== false };
    sc.voice.hook = this.used[0] || null;
    // Le texte d'accroche à l'écran (3 à 8 mots) : il résume la promesse, sans répéter la voix.
    sc.voice.caption = this.hookCaption(facts, wishes);
    sc.voice.used = this.used;
    return sc;
  }

  /** Les scènes qui portent une phrase ; les mouvements courts sont couverts par la voix d'avant. */
  beatsOf(sc) {
    const out = [];
    sc.shots.forEach((s, i) => {
      const quiet = ['close_panel', 'apparitions_off', 'close_profile', 'hold'].includes(s.action) && !s.caption?.force;
      const tiny = (s.duration || 0) < 1.4 && i > 0 && i < sc.shots.length - 1;
      // Ouvrir la fiche et la lire : une seule phrase, plus longue.
      const joined = s.action === 'show_profile' && ['open_saint', 'open_list_item', 'open_marker', 'open_apparition'].includes(sc.shots[i - 1]?.action);
      if (i === 0 || i === sc.shots.length - 1 || (!quiet && !tiny && !joined)) out.push({ index: i });
    });
    return out;
  }

  /** Un texte imposé par la demande, réparti sur les scènes au fil des phrases. */
  verbatim(sc, beats, spans, text) {
    const sentences = text.split(/(?<=[.!?…])\s+/).filter(Boolean);
    const totalSpan = spans.reduce((a, b) => a + b, 0) || 1;
    let k = 0, acc = 0;
    const out = beats.map(() => []);
    sentences.forEach((s, i) => {
      // Chaque phrase va à la scène dont le temps correspond à sa place dans le texte.
      const at = (i / Math.max(1, sentences.length)) * totalSpan;
      while (k < beats.length - 1 && acc + spans[k] <= at) { acc += spans[k]; k++; }
      out[k].push(s);
    });
    beats.forEach((b, j) => { sc.shots[b.index].narration = out[j].join(' '); });
    sc.voice.verbatim = true;
    return sc;
  }

  // ------------------------------------------------------------ les faits

  async facts(S) {
    const texts = await this.data.texts();
    const T = texts[S.id] || {};
    const { lieux } = await this.data.lieux();
    const places = (lieux[S.id] || []);
    const f = S.sex === 'f';
    const now = new Date().getFullYear();
    const name = S.name?.fr || S.name || '';
    // Le rôle le plus parlant d'abord (roi, évêque, martyr…), les qualités ensuite.
    const ORDER = ['king', 'queen', 'pope', 'bishop', 'soldier', 'martyr', 'missionary', 'founder', 'abbot', 'abbess', 'monk', 'nun', 'priest', 'hermit', 'mystic', 'preacher', 'pilgrim', 'apostle', 'widow', 'virgin'];
    const role = ORDER.filter((t) => (S.titles || []).includes(t)).map((t) => ROLE[t]?.[f ? 1 : 0]).find(Boolean) || '';
    const feast = /^(\d\d)-(\d\d)$/.exec(S.feast || '');
    const death = places.find((l) => l.quoi === 'mort');
    const grave = places.find((l) => l.quoi === 'sepulture');
    return {
      S, name, f, il: f ? 'elle' : 'il', Il: f ? 'Elle' : 'Il', e: f ? 'e' : '', un: f ? 'une' : 'un', role,
      born: S.born, died: S.died, circa: !!S.circa,
      age: S.born != null && S.died != null && S.died > S.born ? S.died - S.born : null,
      ago: S.born != null ? now - S.born : null,
      city: S.city ? S.city.replace(/\s*\(.*\)$/, '') : '',
      country: S.country ? this.data.countryName(S.country) : '',
      desc: (T.desc?.fr || '').trim(), bio: storySentences(T.bio?.fr),
      patronage: S.patronage?.fr ? andList(low(S.patronage.fr)) : '',
      feast: feast ? `${+feast[2] === 1 ? '1er' : +feast[2]} ${MONTHS[+feast[1] - 1]}` : '',
      feastSoon: feast ? Math.abs(((new Date(now, +feast[1] - 1, +feast[2]) - new Date()) / 864e5)) < 10 : false,
      death, grave, anecdotes: [
        ...places.filter((l) => l.dit?.fr).map((l) => ({ nom: l.nom, quoi: l.quoi, text: asSentence(l.dit.fr), site: true })),
        // Les anecdotes sourcées (Wikipédia, Nominis) : sans lieu précis, mais avec leur source.
        ...(await sourcedAnecdotes(S.id)).map((a) => ({ nom: '', quoi: '', text: a.legend ? asLegend(a.text) : a.text, source: a.source, url: a.url, confirmed: a.confirmed || null, legend: !!a.legend })),
      ],
    };
  }

  // ------------------------------------------------------------ l'accroche
  //
  // Toujours de vraies phrases (un sujet, un verbe), et une question posée à
  // l'auditeur : c'est elle qui le retient dans les premières secondes.

  hook(sc, brief, F, tone, kind, max) {
    const idea = this.idea || {};
    // Une question posée dans la demande : c'est elle qui ouvre la vidéo, la réponse viendra à la fin.
    if (idea.question) {
      this.used.push('question-demande');
      return `${idea.question} Regardez bien, la réponse arrive.`;
    }
    if (F) {
      const { Il, il, e, un, name, age, ago, city, role, patronage, death, born, died, feast, anecdotes, circa } = F;
      const first = name.split(' ')[0];
      // L'anecdote qui sert le mieux l'idée de la demande (la charité → le manteau partagé).
      const tale = [...anecdotes].sort((x, y) => this.relevance(y.text) - this.relevance(x.text))[0];
      const story = tale && fit(tale.text, Math.max(10, max - 10));
      const lieux = sc.shots.filter((x) => x.action === 'frame_view').length;
      const NUM = ['', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six'];
      // Le premier patronage, pour viser l'auditeur (« Les soldats ont un saint protecteur »).
      const patron = patronage ? patronage.split(/,\s*| et /)[0].trim() : '';
      const opts = [
        age && age <= 40 && { id: 'age', tags: ['chiffre', 'emotion', 'question'], text: `${Il} n'avait que ${age} ans à sa mort. Et pourtant, son nom a traversé les siècles. Savez-vous pourquoi ?` },
        { id: 'contradiction', tags: ['question', 'mystere', 'ludique'], text: `Vous croyez connaître ${name} ? Regardez bien jusqu'à la fin.` },
        { id: 'curiosite', tags: ['mystere', 'question'], text: `Voici ce que peu de gens savent sur ${name}. Restez jusqu'au bout.` },
        ago && city && { id: 'il-y-a', tags: ['chiffre', 'epique', 'question'], text: `Il y a ${ago} ans naissait ${first}. Qui aurait pu deviner ${role && !/jeune|veuve/.test(role) ? `qu'${il} deviendrait ${role}, puis saint${e} ?` : 'son destin ?'}` },
        born != null && city && { id: 'date-lieu', tags: ['chiffre', 'mystere', 'epique', 'question'], text: `${circa ? 'Vers' : 'En'} ${year(born)}, ${un} enfant naît ${atPlace(city)}. Qui aurait pu deviner ce qu'${il} allait devenir ?` },
        death && died != null && { id: 'flashback', tags: ['flashback', 'mystere', 'epique'], text: `En ${year(died)}, tout s'arrête ${atPlace(death.nom)}. Mais pour comprendre, il faut remonter au tout début.` },
        patron && { id: 'identification', tags: ['question', 'ludique'], text: `${cap(patron)} ${/^les /i.test(patron) ? 'ont' : 'a'} ${F.f ? 'une sainte protectrice' : 'un saint protecteur'}. ${F.f ? 'La' : 'Le'} connaissez-vous ?` },
        F.feastSoon && feast && { id: 'fete', tags: ['question', 'emotion'], text: `Le ${feast}, l'Église fête ${name}. Mais connaissez-vous vraiment son histoire ?` },
        story && tale.nom && { id: 'anecdote', tags: ['mystere', 'emotion'], story: tale.nom, text: `Voici ce qui s'est passé ${atPlace(tale.nom)}. ${story} C'est l'histoire ${deName(name)}.` },
        story && !tale.nom && { id: 'anecdote', tags: ['mystere', 'emotion', 'question'], story: tale.text, text: `Connaissez-vous cette histoire ? ${story}` },
        role && { id: 'question-role', tags: ['question'], text: `Comment ${un} ${role} devient-${il} saint${e} ? Voici l'histoire ${deName(name)}.` },
        lieux >= 2 && lieux <= 6 && { id: 'nombre', tags: ['chiffre', 'question'], text: `${cap(NUM[lieux])} lieux racontent la vie de ${name}. Restez jusqu'au dernier.` },
      ].filter((x) => x && words(x.text) <= max + ((sc.target || 45) <= 25 ? 2 : 6));
      // L'idée générale choisit d'abord le type d'accroche (le guide : une seule idée, alignée du début à la fin).
      const PREF = { jeunesse: ['age', 'date-lieu', 'il-y-a'], courage: ['anecdote', 'flashback', 'contradiction'], mort: ['flashback', 'age', 'anecdote'],
        miracle: ['anecdote', 'curiosite'], voyage: ['nombre', 'date-lieu'], charite: ['anecdote', 'curiosite', 'contradiction'], protection: ['identification'],
        fondation: ['question-role', 'curiosite'], foi: ['question-role', 'curiosite'] };
      const wanted = [...(patronage && this.relevance(patronage) > 0 ? ['identification'] : []), ...(idea.angles || []).flatMap((a) => PREF[a] || [])];
      const aligned = opts.filter((x) => wanted.includes(x.id));
      const o = this.choose(aligned.length && !kind ? aligned : opts, kind || tone) || { text: `Connaissez-vous vraiment ${name} ? Voici son histoire.` };
      this.hookStory = o.story || null;
      return o.text;
    }
    const iso = brief?.countries?.[0];
    const country = iso && this.data.countryName(iso);
    const g = country ? countryGrammar(country) : null;
    const n = this.placeCount;
    const many = this.saintsCount ? `plus de ${this.saintsCount.toLocaleString('fr-FR')}` : 'des milliers de';
    const opts = {
      place: [
        n && g && { id: 'p-q', tags: ['question', 'chiffre'], text: `Savez-vous combien de saints la carte compte ${g.en} ? Il y en a ${n.toLocaleString('fr-FR')}, et chacun a son histoire.` },
        g && { id: 'p-ville', tags: ['mystere', 'question'], text: `Et si chaque ville ${g.de} cachait l'histoire d'un saint ? C'est exactement ce que montre cette carte.` },
        { id: 'p-epique', tags: ['epique', 'question'], text: `Des siècles de foi et des centaines de vies tiennent sur une seule carte. Voulez-vous les découvrir avec moi ?` },
      ].filter(Boolean),
      calendar: [
        { id: 'c-q', tags: ['question'], text: 'Savez-vous quel saint l\'Église fête aujourd\'hui ? La réponse se trouve sur la carte.' },
        { id: 'c-jour', tags: ['emotion', 'question'], text: 'Chaque jour de l\'année a son saint. Savez-vous qui l\'on fête aujourd\'hui ?' },
      ],
      century: [
        { id: 's-q', tags: ['question'], text: `Qui étaient les saints du ${brief?.century}e siècle ? La carte va nous le montrer.` },
        { id: 's-epique', tags: ['epique', 'question'], text: `Que reste-t-il des saints du ${brief?.century}e siècle ? Leurs noms, leurs villes, et une carte pour les retrouver.` },
      ],
      apparitions: [
        { id: 'a-q', tags: ['question', 'mystere'], text: 'Lourdes, Fátima, Guadalupe : savez-vous où le ciel s\'est montré aux hommes ?' },
        { id: 'a-carte', tags: ['epique', 'question'], text: 'Saviez-vous que des apparitions sont rapportées sur presque tous les continents ? Les voici réunies sur une seule carte.' },
      ],
      // Une partie de l'application : l'accroche part de ce qu'elle apporte.
      sections: (() => {
        const first = brief?.sections?.[0];
        const n = brief?.sections?.length || 0;
        const NUM = ['', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six'];
        const by = {
          jeux: { id: 's-jeux', tags: ['question', 'ludique'], text: 'Et si vous appreniez les saints en jouant ? Voici les jeux de SanctiMaps.' },
          'jeu-quiz': { id: 's-quiz', tags: ['question', 'ludique'], text: 'Combien de saints connaissez-vous vraiment ? Testez-vous avec le quiz.' },
          'jeu-chaine': { id: 's-chaine', tags: ['question', 'ludique'], text: 'Pouvez-vous relier deux saints que tout sépare ? Voici la chaîne de saints.' },
          'jeu-qui': { id: 's-qui', tags: ['question', 'ludique'], text: 'Un saint secret se cache. Saurez-vous le trouver ?' },
          daily: { id: 's-jour', tags: ['question'], text: 'Savez-vous quel saint l\'Église fête aujourd\'hui ? La réponse est sur la carte.' },
          bible: { id: 's-bible', tags: ['question'], text: 'Savez-vous quelles lectures l\'Église propose aujourd\'hui ? Elles sont dans SanctiMaps.' },
          lettre: { id: 's-lettre', tags: ['question'], text: 'Et si chaque matin, un saint vous attendait dans votre boîte mail ?' },
          search: { id: 's-recherche', tags: ['question'], text: 'Un saint en tête, mais pas son nom ? Voici comment le retrouver.' },
          add: { id: 's-ajout', tags: ['question'], text: 'Un saint manque à la carte ? Vous pouvez l\'y ajouter.' },
          settings: { id: 's-reglages', tags: ['question'], text: 'Le saint du jour, dans votre langue et à votre heure ? C\'est possible.' },
        };
        const list = [];
        // Plusieurs parties : l'accroche les annonce toutes, pas seulement la première.
        if (n > 1) list.push({ id: 's-plusieurs', tags: ['chiffre', 'question'], text: `Savez-vous tout ce que cache SanctiMaps ? En voici ${NUM[n] || n} parties.` });
        else if (by[first]) list.push(by[first]);
        return list;
      })(),
      commands: [
        { id: 'd-carte', tags: ['epique', 'question'], text: `Savez-vous combien de saints tiennent sur une seule carte ? Il y en a ${many}, et voici comment les découvrir.` },
        { id: 'd-q', tags: ['question'], text: 'Et si toute l\'histoire des saints tenait dans votre poche ? C\'est exactement ce que propose SanctiMaps.' },
      ],
    };
    const list = opts[brief?.focus] || opts.commands;
    return (this.choose(list, kind || tone) || list[0]).text;
  }

  // ------------------------------------------------------------ l'histoire

  hookCaption(F, wishes) {
    const id = this.used[0];
    if (!F) return '';
    const NUM = ['', 'Un', 'Deux', 'Trois', 'Quatre', 'Cinq', 'Six'];
    const patron = F.patronage ? F.patronage.split(/,\s*| et /)[0].trim() : '';
    const lieux = this.tourIndex?.size || 0;
    const line = {
      'question-demande': `${F.name} : la vraie réponse`,
      age: `${F.f ? 'Morte' : 'Mort'} à ${F.age} ans`,
      contradiction: `Tu crois ${F.f ? 'la' : 'le'} connaître ?`,
      curiosite: `Ce que peu de gens savent`,
      'il-y-a': `Il y a ${F.ago} ans…`,
      'date-lieu': `${F.city}, ${year(F.born)}`,
      flashback: F.death ? `${F.death.nom}, ${year(F.died)}` : '',
      identification: patron ? `${cap(F.f ? 'la sainte' : 'le saint')} ${/^les /i.test(patron) ? 'des ' + patron.slice(4) : /^la |^le /i.test(patron) ? 'de ' + patron : 'de ' + patron}` : '',
      fete: `Fêté${F.e} le ${F.feast}`,
      anecdote: this.hookStory ? `Ce qui s'est passé ${atPlace(this.hookStory)}` : '',
      'question-role': F.role ? `De ${F.role} à saint${F.e}` : '',
      nombre: lieux ? `${NUM[lieux] || lieux} lieux, une vie` : '',
    }[id] || '';
    return line && line.split(/\s+/).length <= 8 ? line : '';
  }

  /** Le poids d'une phrase pour l'idée de la demande : combien de ses mots elle reprend. */
  relevance(sentence) {
    const t = fold(sentence);
    return (this.topicWords || []).reduce((a, w) => a + (w.length > 3 && t.includes(w) ? 1 : 0), 0);
  }

  /** La phrase des données (fiche, anecdotes) qui répond le mieux à l'idée, pas encore dite. */
  bestSentence(F, said = '') {
    // Une anecdote dite loin de son lieu dit d'abord où l'on est (« il y partage… »).
    const story = (a) => placed(a.nom, fit(a.text, 34));
    const pool = [...F.anecdotes.map(story), ...F.bio, F.patronage ? `Aujourd'hui encore, ${F.il} veille sur ${F.patronage}.` : '', F.desc && !/^(«|Le |La |Les |L')/.test(F.desc) ? `${F.Il} est resté${F.e} dans l'histoire comme ${F.un} ${low(F.desc.replace(/\.$/, ''))}.` : '']
      .filter((x) => x && words(x) <= 40 && !said.includes(x.slice(-40)));
    // À égalité, une anecdote (une scène racontée) révèle mieux qu'une phrase de fiche.
    const stories = new Set(F.anecdotes.map(story));
    const ranked = pool.map((x) => ({ x, r: this.relevance(x), s: stories.has(x) ? 0.5 : 0 })).sort((a, b) => (b.r - a.r) || (b.s - a.s));
    // Rien ne répond vraiment : le portrait de la fiche plutôt qu'une phrase au hasard.
    if (!ranked[0]?.r && F.desc) return `${F.Il} est resté${F.e} dans l'histoire comme ${F.un} ${low(F.desc.replace(/\.$/, ''))}.`;
    return ranked[0]?.x || '';
  }

  /** Ce que raconte un lieu de sa vie : son anecdote si le site en a une, sinon ce qui s'y est passé. */
  lieuLine(shot, F, max) {
    const p = shot.params || {}, b = shot.beat || {};
    // L'anecdote déjà racontée en accroche ne revient pas.
    const story = F.anecdotes.find((a) => fold(a.nom) === fold(b.nom || p.near || '') && a.nom !== this.hookStory && !this.told?.has(a.nom));
    // L'accroche partait de la mort : revenir là, c'est boucler, sans redire la date.
    if (this.used[0] === 'flashback' && b.quoi === 'mort' && !story) return `Nous revoilà ${atPlace(b.nom)}, là où tout s'arrête.`;
    const told = story && fit(story.text, max + 2);
    // L'anecdote gardée pour la révélation de la fin n'est pas dite ici.
    const r = this.reserved || '';
    if (told && r && (r.includes(told.slice(0, 40)) || told.includes(r.slice(-40)))) return this.short(shot, F);
    if (told) {
      if (this.rand() < 0.5 && words(told) + 6 <= max + 2) return `Savez-vous ce qui s'est passé ${atPlace(b.nom)} ? ${told}`;
      // « Il y meurt… » : pour qui écoute sans regarder, on dit d'abord où l'on est.
      return placed(b.nom, told);
    }
    const a = atPlace(b.nom), Nom = cap(withArticle(b.nom));
    const died = F.died != null ? `, en ${year(F.died)}` : '';
    // Deux lieux de la même sorte (deux lieux de formation) : la seconde phrase n'est pas la même.
    if (!this.kindShots.has(shot)) this.kindShots.set(shot, (this.kindTally[b.quoi] = (this.kindTally[b.quoi] || 0) + 1));
    const again = this.kindShots.get(shot) > 1;
    if (again) {
      const more = { formation: `Puis ${F.il} poursuit sa formation ${a}.`, fondation: `Autre fondation : ${withArticle(b.nom)}.`, oeuvre: `Son œuvre le mène aussi ${a}.`,
        residence: `Puis ${F.il} s'installe ${a}.`, predilection: `${Nom} lui était cher aussi.`, enfance: `Une partie de son enfance se passe ${a}.` }[b.quoi];
      if (more) return more;
    }
    const lines = {
      naissance: [`Tout commence ici, ${a}.`],
      enfance: [`C'est ${a} qu'${F.il} passe son enfance.`],
      formation: [`C'est ${a} qu'${F.il} se forme.`],
      fondation: [`C'est ${a} qu'${F.il} laisse l'une de ses fondations.`, `Savez-vous ce qu'${F.il} a fondé ${a} ? ${Nom} porte encore sa marque.`],
      oeuvre: [`C'est ${a} qu'${F.il} accomplit son œuvre.`],
      residence: [`C'est ${a} qu'${F.il} a vécu.`],
      predilection: [`${Nom} était l'un de ses lieux préférés.`],
      miracle: [`C'est ${a} qu'on parle encore d'un miracle.`],
      mort: [`Et c'est ${a} que tout s'achève${died}.`, `Savez-vous où ${F.il} meurt ? C'est ${a}${died}.`],
      sepulture: [`Et savez-vous où ${F.il} repose aujourd'hui ? C'est ${a}.`, `Aujourd'hui, ${F.il} repose ${a}.`],
    };
    return this.pick(lines[b.quoi] || [`Nous voici maintenant ${a}.`]);
  }

  /** « Première étape : … », « Et dernière étape : … » quand le parcours est numéroté. */
  step(i, n, text) {
    if (!text) return text;
    const ORD = ['Première', 'Deuxième', 'Troisième', 'Quatrième', 'Cinquième', 'Sixième'];
    const head = i === n - 1 ? 'Et dernière étape' : `${ORD[i] || 'Puis'} étape`.replace('Puis étape', 'Étape suivante');
    const lowered = /^(C'est|Et|Aujourd'hui|Tout|Il|Elle|Nous|Mais|Savez-vous|Le|La|Les|Un|Une|Voici)\b/.test(text) ? low(text.replace(/^Et /, '')) : text;
    return `${head} : ${lowered}`;
  }

  /** Une phrase courte (mais une vraie phrase), quand rien de plus riche ne tient dans la scène. */
  short(shot, F, limit = 14) {
    const p = shot.params || {}, b = shot.beat || {};
    if (b.kind === 'birth') return ['date-lieu', 'il-y-a'].includes(this.used[0]) ? '' : 'C\'est ici que tout commence.';
    if (b.nom && F) {
      // Ce qui s'est passé là, en une phrase brève (jamais deux fois la même tournure de suite).
      const a = atPlace(b.nom), Nom = cap(withArticle(b.nom)), il = F.il;
      const line = {
        naissance: `Tout commence ${a}.`, enfance: `C'est ${a} qu'${il} grandit.`, formation: `C'est ${a} qu'${il} se forme.`,
        fondation: `C'est ${a} qu'${il} fonde l'une de ses œuvres.`, oeuvre: `C'est ${a} qu'${il} accomplit son œuvre.`,
        residence: `C'est ${a} qu'${il} a vécu.`, predilection: `${Nom} était l'un de ses lieux préférés.`,
        miracle: `C'est ${a} qu'on parle d'un miracle.`, mort: `Et c'est ${a} qu'${il} meurt.`, sepulture: `Aujourd'hui, ${il} repose ${a}.`,
      }[b.quoi];
      if (line) return line;
      return this.pick([`Puis vient ${withArticle(b.nom)}.`, `Nous voici maintenant ${a}.`, `Arrêtons-nous ${a}.`]);
    }
    if (b.nom) return `Nous voici maintenant ${atPlace(b.nom)}.`;
    if (['open_saint', 'show_profile'].includes(shot.action) && F) {
      // La plus courte phrase de la fiche qui n'a pas encore été dite.
      const said = this.saidText || '';
      // La phrase qui sert le mieux l'idée de la demande, puis la plus courte.
      const stories = F.anecdotes.filter((a) => a.nom !== this.hookStory && this.relevance(a.text) > 0).map((a) => fit(a.text, limit)).filter(Boolean);
      const bio = [...F.bio, ...stories].filter((x) => words(x) <= limit && !said.includes(x.slice(0, 30)))
        .sort((x, y) => this.relevance(y) - this.relevance(x) || words(x) - words(y))[0];
      if (bio) return bio;
      if (['enigme'].includes(this.used[0]) || !F.desc) return '';
      return `${F.Il} est resté${F.e} dans l'histoire comme ${F.un} ${low(F.desc.replace(/\.$/, '').split(/,\s+/)[0])}.`;
    }
    return p.place && !p.place.startsWith('@') ? `Nous voici maintenant à ${p.place}.` : '';
  }

  middle(shot, sc, brief, F, tone, max, k) {
    const p = shot.params || {};
    const b = shot.beat || {};
    const country = p.country ? this.data.countryName(p.country) : '';
    const when = F && F.born != null ? `${F.circa ? 'vers ' : 'en '}${year(F.born)}` : '';
    switch (shot.action) {
      case 'open_continent': return this.pick(['Prenons un peu de hauteur avant de descendre.', 'Le voyage commence au-dessus du continent.']);
      case 'open_country': case 'fit_country': {
        if (!country) return '';
        const g = countryGrammar(country);
        return this.pick([`Savez-vous où commence cette histoire ? Elle commence ${g.en}.`, `Notre histoire commence ${g.en}.`, `Partons ${g.en}, là où tout commence.`, `Direction ${g.le}, où tout a commencé.`]);
      }
      case 'zoom_to_place': case 'pan_to_place': {
        if (F && b.kind === 'birth') {
          // L'accroche a déjà dit la naissance : on se demande plutôt ce qu'il va devenir.
          if (['date-lieu', 'il-y-a'].includes(this.used[0])) return '';
          return this.pick([
            `Savez-vous où ${F.il} est né${F.e} ? C'est à ${b.place}${when ? ', ' + when : ''}.`,
            `C'est à ${b.place} qu'${F.il} voit le jour${when ? ', ' + when : ''}.`,
            `Tout commence à ${b.place}${when ? ', ' + when : ''}, le jour de sa naissance.`,
          ]);
        }
        if (b.famous) return this.pick([`Savez-vous quel saint est né à ${p.place} ? C'est ${b.famous}.`, `À ${p.place}, c'est ${b.famous} qui a vu le jour.`]);
        return p.place && !p.place.startsWith('@') ? this.pick([`Nous voici maintenant à ${p.place}.`, `Partons ensuite pour ${p.place}.`]) : '';
      }
      case 'frame_view': {
        if (!F) return p.near ? `Nous voici maintenant ${atPlace(p.near)}.` : '';
        return this.lieuLine(shot, F, max);
      }
      case 'show_lieux': return F ? this.pick([`Voulez-vous voir les lieux qui ont marqué sa vie ? Les voici.`, `Et si nous suivions ses pas, lieu après lieu ?`]) : '';
      case 'show_croises': return F ? this.pick([`Mais ${F.il} n'était pas seul${F.e} : savez-vous qui ${F.il} a pu croiser ?`, `Sur sa route, d'autres saints l'ont peut-être croisé${F.e}.`]) : '';
      case 'open_saint': case 'show_profile': case 'open_list_item': case 'open_marker': {
        const G = this.others.get(shot.beat?.saintId);
        if (!F && G) {
          const bit = G.desc.replace(/\.$/, '').split(/,\s+/)[0];
          return this.pick([`Avez-vous déjà entendu parler ${deName(G.name)} ?${bit ? ` C'était ${G.un} ${low(bit)}.` : ''}`, `Parmi eux, il y a ${G.name}${bit ? `, ${G.un} ${low(bit)}` : ''}.`]);
        }
        if (!F) return shot.caption?.title ? `Voici maintenant ${shot.caption.title}.` : '';
        // La vie, racontée : une ou deux phrases de la fiche, puis ce qu'il protège.
        const used = sc.shots.map((s) => s.narration || '').join(' ');
        // Les phrases qui racontent (il part, fonde, affirme, partage…) passent avant l'état civil.
        const ACT = /\b(affirme|fonde|fonda|part|partit|quitte|devient|devint|entre|entra|rencontre|partage|partagea|reçoit|re[çc]ut|délivre|délivra|convertit|prêche|soigne|meurt|mourut|construit|bâtit|écrit|écrivit|refuse|décide|consacre|régna|règne)\b/i;
        // Une anecdote qui sert l'idée de la demande (« sa jeunesse » → « entrée au carmel à quinze ans ») passe dans la fiche.
        const fitting = F.anecdotes.filter((a) => (this.relevance(a.text) > 0 || !a.site) && a.nom !== this.hookStory && a.text !== this.hookStory)
          .map((a) => placed(a.nom, fit(a.text, max))).filter(Boolean);
        const reserved = this.reserved || '';
        const pool = [...F.bio, ...fitting].filter((x) => !used.includes(x.slice(-40)) && words(x) <= max && !(reserved && reserved.includes(x.slice(-40))))
          .map((x, i) => ({ x, score: (ACT.test(x) ? 2 : 0) + (i > 0 ? 1 : 0) - (words(x) > 30 ? 1 : 0) + this.rand() * 1.5 + 3 * this.relevance(x) + (fitting.includes(x) ? (this.relevance(x) ? 2 : 1.5) : 0) }))
          .sort((a, b) => b.score - a.score);
        let text = pool[0]?.x || '';
        // Une anecdote racontée ici ne sera pas redite à son lieu.
        for (const a of F.anecdotes) if (text.includes(fit(a.text, max).slice(0, 40))) (this.told ||= new Set()).add(a.nom);
        if (pool[1] && words(text) + words(pool[1].x) <= max) text += ' ' + pool[1].x;
        // Une fois sur trois, ou faute de phrase qui tienne : son portrait, en une phrase.
        const portrait = F.desc && !/^(«|Le |La |Les |L')/.test(F.desc) ? `${F.Il} est resté${F.e} dans l'histoire comme ${F.un} ${low(F.desc.replace(/\.$/, ''))}.` : '';
        const descSaid = this.used[0] === 'enigme';
        // (une anecdote, elle, n'est jamais remplacée par le portrait : c'est elle qui retient l'auditeur).
        const isStory = fitting.some((f) => text.includes(f.slice(0, 40)));
        if ((!text || (!isStory && this.rand() < 0.35)) && !descSaid && portrait && portrait !== this.reserved && words(portrait) <= max + 2) text = portrait;
        // Une question pour relancer l'attention avant la fiche.
        const ask = this.pick([`Mais qui était-${F.il} vraiment ?`, `Que sait-on de sa vie ?`, `Pourquoi se souvient-on encore ${F.f ? "d'elle" : 'de lui'} ?`]);
        if (text && !this.idea?.question && words(ask) + words(text) <= max + 2 && this.rand() < 0.6) text = `${ask} ${text}`;
        const veille = `${text ? 'Et a' : 'A'}ujourd'hui encore, ${F.il} veille sur ${F.patronage}.`;
        // Ce qu'il protège répond à la demande (« il aimait les animaux ») : c'est dit en premier.
        if (F.patronage && this.relevance(F.patronage) > this.relevance(text) && !(this.reserved || '').includes(F.patronage)) text = fit(`Aujourd'hui encore, ${F.il} veille sur ${F.patronage}. ${text}`, max + 2);
        else if (F.patronage && !(this.reserved || '').includes(F.patronage) && words(text) + words(veille) <= max + 2 && this.rand() < 0.6) text = `${text} ${veille}`.trim();
        return text;
      }
      case 'century_filter': return `Voici les saints du ${p.century}e siècle, tous réunis sur la carte.`;
      case 'calendar': return this.base.get(shot) || 'Voici le calendrier des saints : chaque jour, l\'Église en fête un.';
      case 'apparitions_on': return this.base.get(shot) || 'Passons maintenant aux apparitions.';
      case 'search_list': return this.base.get(shot) || 'Il suffit de taper un nom pour que la carte vous réponde.';
      case 'open_tab': return this.base.get(shot) || 'Et pour aller plus loin, il y a même des jeux.';
      default: return this.base.get(shot) || (shot.caption?.title && shot.caption.force ? shot.caption.title : '');
    }
  }

  // ------------------------------------------------------------ la fin

  ending(sc, brief, F, tone, max) {
    const forced = sc.shots.at(-1)?.caption?.force ? sc.shots.at(-1).caption.title : '';
    if (forced) return forced;
    const many = this.saintsCount ? `plus de ${this.saintsCount.toLocaleString('fr-FR')}` : 'des milliers de';
    const who = F?.name;
    // La boucle : une accroche qui partait de la fin se referme sur le début.
    if (F && this.used[0] === 'flashback' && F.city) {
      this.used.push('f-boucle');
      return `Et dire que tout avait commencé à ${F.city}. Retrouvez toute son histoire sur SanctiMaps.`;
    }
    const opts = [
      who && { id: 'f-histoire', tags: ['emotion', 'mystere', 'question'], text: `Voulez-vous connaître toute l'histoire ${deName(who)} ? Elle vous attend sur SanctiMaps.` },
      { id: 'f-nombre', tags: ['epique', 'question'], text: `Et ce n'est qu'un début : ${many} saints vous attendent sur SanctiMaps. Lequel découvrirez-vous en premier ?` },
      { id: 'f-prochain', tags: ['question', 'ludique'], text: 'Et vous, quel saint allez-vous découvrir maintenant ? Rendez-vous sur SanctiMaps.' },
      who && { id: 'f-pas', tags: ['epique', 'emotion', 'question'], text: `Jusqu'où ses pas vont-ils vous mener ? Suivez ${who} sur SanctiMaps.` },
      { id: 'f-carte', tags: ['ludique', 'question'], text: 'Toute la carte des saints vous attend sur SanctiMaps point F R. Pourquoi ne pas commencer aujourd\'hui ?' },
      { id: 'f-vous', tags: ['question'], text: 'Et près de chez vous, savez-vous quel saint est né ? La réponse vous attend sur SanctiMaps.' },
    ];
    // Une présentation de l'application : une fin brève, pour laisser la voix aux parties.
    const roomEnd = brief?.focus === 'sections' ? 12 : max + ((sc.target || 45) <= 25 ? 3 : 6);
    return (this.choose(opts.filter((o) => o && words(o.text) <= roomEnd), tone) || { text: `Envie d'en savoir plus ? Retrouvez-${F?.f ? 'la' : 'le'} sur SanctiMaps.` }).text;
  }
}
