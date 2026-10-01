// Planificateur : une demande en français → un scénario minuté.
// Port du planificateur à règles de sanctimaps_agent/planner.py.
import { CONTINENT_LABEL, fold } from './sanctimaps.js';

export const STYLES = {
  cinematic: { name: 'cinematic', label: 'Cinématique', transition: 3.2, zoom: 1.6, pan: 260, hold: 1.8, reading: 2.0, typing: 7, settle: 0.5 },
  documentary: { name: 'documentary', label: 'Documentaire', transition: 2.2, zoom: 1.1, pan: 380, hold: 2.2, reading: 3.0, typing: 9, settle: 0.4 },
  fast: { name: 'fast', label: 'Rapide', transition: 1.0, zoom: 0.55, pan: 800, hold: 0.8, reading: 1.2, typing: 18, settle: 0.2 },
  slow: { name: 'slow', label: 'Lent', transition: 4.5, zoom: 2.4, pan: 170, hold: 2.6, reading: 3.0, typing: 5, settle: 0.6 },
  educational: { name: 'educational', label: 'Pédagogique', transition: 2.0, zoom: 1.2, pan: 340, hold: 2.8, reading: 4.5, typing: 8, settle: 0.5 },
};
export function scaled(style, speed) {
  if (speed === 1) return style;
  return { ...style, transition: style.transition / speed, zoom: style.zoom / speed, pan: style.pan * speed,
    hold: style.hold / speed, typing: style.typing * speed, speed };
}

export const ACTIONS = {
  establish_world: 'Vue mondiale stable', open_continent: 'Descente vers un continent', open_country: 'Descente vers un pays',
  zoom_to_place: 'Zoom vers un lieu', pan_to_place: 'Déplacement vers un lieu', zoom_in: 'Zoom avant', zoom_out: 'Zoom arrière',
  fit_country: 'Retour à la vue du pays', back_to_world: 'Retour à la vue mondiale', open_saint: "Fiche d'un saint",
  show_profile: 'Lecture de la fiche', close_profile: 'Fermeture de la fiche', century_filter: 'Filtre par siècle',
  calendar: 'Calendrier des fêtes', apparitions_on: 'Mode apparitions', apparitions_off: 'Retour aux saints',
  open_apparition: "Fiche d'une apparition", hold: 'Pause', pan: 'Déplacement',
  level_up: 'Remonter d\'un niveau', miracles_on: 'Mode miracles', show_lieux: 'Lieux marqués par le saint',
  show_croises: 'Saints qu\'il a pu croiser', open_marker: 'Ouverture d\'une croix de la carte', search_list: 'Recherche',
  close_panel: 'Fermeture du panneau', frame_view: 'Cadrage montré à la main', open_list_item: 'Fiche choisie dans la liste',
  open_tab: 'Ouverture d\'un onglet', press: 'Appui sur un bouton', select_option: 'Réglage', type_field: 'Saisie',
  scroll_panel: 'Défilement', toggle: 'Dépliage', quiz_correct: 'Bonne réponse au quiz',
};

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12, xiii: 13, xiv: 14,
  xv: 15, xvi: 16, xvii: 17, xviii: 18, xix: 19, xx: 20, xxi: 21 };
const CONT_WORDS = { europe: 'europe', afrique: 'africa', asie: 'asia', oceanie: 'oceania',
  'amerique du nord': 'north-america', 'amerique du sud': 'south-america', 'amerique latine': 'south-america' };

export function parseDuration(text) {
  const t = fold(text);
  let m = /(\d+(?:[.,]\d+)?)\s*(?:min|minutes?)\b(?:\s*(\d+))?/.exec(t);
  if (m) return parseFloat(m[1].replace(',', '.')) * 60 + (m[2] ? +m[2] : 0);
  m = /(\d+)\s*(?:s|sec|secs|secondes?)\b/.exec(t);
  if (m) return +m[1];
  if (/\bune minute\b/.test(t)) return 60;
  return null;
}
export function parseAspect(text) {
  const t = fold(text);
  if (/\b(verticale?|portrait|tiktok|reels?|shorts?|story|stories)\b/.test(t) || text.includes('9:16')) return '9:16';
  if (/\b(carree?|instagram)\b/.test(t) || text.includes('1:1')) return '1:1';
  if (/\b(horizontale?|paysage|youtube)\b/.test(t) || text.includes('16:9')) return '16:9';
  return null;
}
export function parseStyle(text) {
  const t = fold(text);
  for (const [re, s] of [[/cinemat|cinema|epique/, 'cinematic'], [/documentaire/, 'documentary'],
    [/pedagog|educati|didacti/, 'educational'], [/\brapide|dynamique/, 'fast'], [/\blente?\b|lentement|posee?/, 'slow']]) if (re.test(t)) return s;
  return null;
}
export function parseCentury(text) {
  const t = fold(text);
  let m = /\b([ivx]+)(?:e|eme|er)?\s+siecles?\b/.exec(t);
  if (m && ROMAN[m[1]]) return ROMAN[m[1]];
  m = /\b(\d{1,2})\s*(?:e|eme|er)?\s+siecles?\b/.exec(t);
  if (m && +m[1] >= 1 && +m[1] <= 21) return +m[1];
  return null;
}
export function splitClauses(text) {
  return text.split(/[.;,]|\bpuis\b|\bensuite\b|\bet enfin\b|\benfin\b|\bet (?=(?:revien|retour|termin|fini|montre|affich|ouvr|zoom|descend|rapproche|passe))/i)
    .map((s) => s.trim()).filter(Boolean);
}

export class Planner {
  constructor(data, memory) { this.data = data; this.memory = memory; }

  async findPlaces(clause, iso) {
    const found = [];
    const skip = new Set(['fais', 'fait', 'cree', 'commence', 'montre', 'va', 'zoome', 'cherche', 'ouvre', 'termine', 'passe',
      'reviens', 'sanctimaps', 'saint', 'sainte', 'puis', 'la', 'le', 'les', 'une', 'un']);
    const cands = clause.match(/\b[A-ZÉÈÂÎ][\wàâçéèêëîïôûùüÿœ'’-]+(?:[ -](?:de|du|la|le|sur|en)?[ -]?[A-ZÉÈ][\wàâçéèêëîïôûùüÿœ'’-]+)*/g) || [];
    for (const c of cands) {
      const f = fold(c);
      if (skip.has(f) || this.data.findCountry(c) || CONT_WORDS[f]) continue;
      if ((iso && await this.data.findPlace(c, iso)) || await this.data.cityCountry(c)) found.push(c);
    }
    return found;
  }
  static saintNames(clause) {
    const names = [...clause.matchAll(/\b(?:saint|sainte|bienheureux|bienheureuse)\s+([A-ZÉÈ][\wàâçéèêëîïôûùüÿœ'’-]+(?:\s+(?:de|d’|d'|du|la|le)?\s*[A-ZÉÈ][\wàâçéèêëîïôûùüÿœ'’-]+)*)/g)].map((m) => m[1]);
    names.push(...[...clause.matchAll(/\bfiche (?:de|du|d’|d')\s*([A-ZÉÈ][\wàâçéèêëîïôûùüÿœ'’-]+(?:\s+[A-ZÉÈ][\wàâçéèêëîïôûùüÿœ'’-]+)*)/g)].map((m) => m[1]));
    return names;
  }

  async intents(text) {
    let intents = []; let iso = this.memory?.country || null; let lastPlace = null; let sawSaint = false; let appar = false;
    const clauses = splitClauses(text); let headerEnd = null;
    for (let n = 0; n < clauses.length; n++) {
      const clause = clauses[n]; const c = fold(clause);
      if (n === 1 && /\b(video|film|clip)\b/.test(fold(clauses[0]))) headerEnd = intents.length;
      const I = (action, params = {}, weight = 1) => intents.push({ action, params, weight });
      const returning = /\b(revien|retour|remonte|recule|termine (sur|par|avec) une vue|finit sur une vue)/.test(c);
      if (/\b(vue (du|de la|mondiale)|du monde|planisphere|monde entier|le monde)\b/.test(c) && !returning) I('establish_world', {}, 0.8);
      const countries = this.data.countriesIn(clause);
      for (const [w, cid] of Object.entries(CONT_WORDS)) if (new RegExp(`\\b${w}\\b`).test(c) && !countries.length) I('open_continent', { continent: cid }, 0.6);
      for (const k of countries) {
        if (returning) { I('close_profile', {}, 0.1); I(iso === k || !iso ? 'fit_country' : 'open_country', { country: k }, 1); }
        else I('open_country', { country: k }, 1.2);
        iso = k;
      }
      if (returning && !countries.length && /\bmonde\b/.test(c)) I('back_to_world', {}, 0.8);
      const century = parseCentury(clause);
      if (century) I('century_filter', { century, country: iso }, 1.2);
      if (/\bcalendrier|fete(s)? (aujourd|le|du|ce)|saint du jour|fetes? aujourd/.test(c)) {
        const m = /\b(\d{1,2}(?:er)?\s+(?:janv|fevr|mars|avri|mai|juin|juil|aout|sept|octo|nove|dece)\w*)/.exec(c);
        I('calendar', { day: m ? m[1] : "aujourd'hui" }, 1.5);
      }
      if (/\bapparitions?\b/.test(c) || (appar && !returning)) {
        const names = await this.findPlaces(clause, null);
        if (!appar) { I('apparitions_on', {}, 0.5); appar = true; }
        if (names.length) { I('open_apparition', { name: names[0] }, 0.6); I('show_profile', {}, 2); sawSaint = true; }
      } else if (!returning) {
        for (const p of await this.findPlaces(clause, iso)) { I('zoom_to_place', { place: p, country: iso }, 1.2); lastPlace = p; }
      }
      if (/\bplusieurs (zones|villes|regions|lieux|endroits)|differentes (zones|regions|villes)|parcour|survol/.test(c)) {
        I('zoom_to_place', { place: '@tour:0', country: iso }, 1); I('pan_to_place', { place: '@tour:1', country: iso }, 1);
        I('pan_to_place', { place: '@tour:2', country: iso }, 1);
      }
      const names = Planner.saintNames(clause);
      for (const name of names) { I('open_saint', { query: name }, 0.8); I('show_profile', {}, 2); sawSaint = true; }
      if (/\bfiche\b/.test(c) && !names.length && !sawSaint) {
        const sel = this.memory?.saint;
        if (/selectionne|choisi|actuel|ce saint|sa fiche/.test(c) && sel) I('open_saint', { query: sel }, 0.8);
        else I('open_saint', { query: '@interesting', country: iso, place: lastPlace }, 0.8);
        I('show_profile', {}, 2); sawSaint = true;
      }
      if (/\bzoom(e)? arriere|dezoom/.test(c) && !returning) I('zoom_out', { factor: 2 }, 0.8);
      else if (/\bzoom(e)? (avant|davantage|plus)|rapproche[- ]toi\b/.test(c) && !countries.length) I('zoom_in', { factor: 2 }, 0.8);
    }
    if (headerEnd) {
      const head = intents.slice(0, headerEnd), rest = intents.slice(headerEnd);
      const same = (a, b) => a.action === b.action && JSON.stringify(a.params) === JSON.stringify(b.params);
      if (head.every((h) => rest.some((r) => same(r, h)))) intents = rest;
    }
    intents = intents.filter((it, i) => !(i && intents[i - 1].action === it.action && JSON.stringify(intents[i - 1].params) === JSON.stringify(it.params)));
    const out = [];
    for (const it of intents) {
      if (it.action === 'open_country' && (!out.length || out.at(-1).action === 'establish_world')) {
        const cont = this.data.countryById.get(it.params.country)?.continent;
        if (cont) out.push({ action: 'open_continent', params: { continent: cont }, weight: 0.6 });
      }
      out.push(it);
    }
    intents = out;
    if (intents.length && intents.at(-1).action === 'open_country' && intents.every((i) => ['establish_world', 'open_continent', 'open_country'].includes(i.action))) {
      const k = intents.at(-1).params.country;
      intents.push({ action: 'zoom_to_place', params: { place: '@tour:0', country: k }, weight: 1 },
        { action: 'fit_country', params: { country: k }, weight: 0.8 });
    }
    return intents;
  }

  static natural(action, s, fromWorld) {
    const t = s.transition;
    return { establish_world: s.hold, open_continent: t + s.settle, open_country: (fromWorld ? 2 * t : t) + s.settle,
      zoom_to_place: 1.6 + 2.6 * s.zoom + s.settle, pan_to_place: 2 + s.settle, zoom_in: s.zoom + s.settle, zoom_out: s.zoom + s.settle,
      fit_country: t + s.settle, back_to_world: t + s.settle, open_saint: 10 / s.typing + t + 1, show_profile: s.hold * 1.5,
      close_profile: 0.6, century_filter: 14 / s.typing + 1.5, calendar: 1.5, apparitions_on: 1, apparitions_off: 1,
      open_apparition: 8 / s.typing + t + 1, hold: s.hold, pan: 1.5 + s.settle,
      level_up: t + s.settle, miracles_on: 1, show_lieux: t + s.settle + 1, show_croises: t + s.settle + 1, open_marker: 2.5,
      search_list: 12 / s.typing + 1.5, close_panel: 0.6, frame_view: 1.6 + 2.6 * s.zoom + s.settle, open_list_item: t + 1,
      open_tab: 1.4, press: 1.4, select_option: 2, type_field: 1.5, scroll_panel: 2, toggle: 1.2, quiz_correct: 3 }[action];
  }

  describe(it) {
    const p = it.params; const place = String(p.place || '').replace('@tour:', 'la zone ');
    switch (it.action) {
      case 'open_continent': return `Zoom progressif vers ${CONTINENT_LABEL[p.continent] || p.continent}`;
      case 'open_country': return `Descente vers ${this.data.countryName(p.country)}`;
      case 'zoom_to_place': return `Zoom vers ${p.resolvedPlace || place}`;
      case 'pan_to_place': return `Déplacement vers ${p.resolvedPlace || place}`;
      case 'fit_country': return `Retour à la vue de ${p.country ? this.data.countryName(p.country) : 'ce pays'}`;
      case 'open_saint': { const q = p.resolved || p.query; return !q || String(q).startsWith('@') ? "Fiche d'un saint" : `Fiche : ${q}`; }
      case 'century_filter': return `Saints du ${p.century}e siècle`;
      case 'calendar': return `Calendrier : ${p.day}`;
      case 'open_apparition': return `Apparition : ${p.name}`;
      case 'pan': return `Déplacement vers le ${{ north: 'nord', south: 'sud', east: 'est', west: 'ouest' }[p.direction] || p.direction}`;
      case 'zoom_in': return p.factor && p.factor !== 2 ? `Zoom avant ×${p.factor}` : 'Zoom avant';
      case 'search_list': return `Recherche : ${p.query}`;
      case 'open_tab': return `Onglet : ${{ menu: 'menu', daily: 'Saint du jour', search: 'Rechercher', add: 'Ajouter', jeux: 'Jeux', settings: 'Paramètres' }[p.tab] || p.tab}`;
      case 'press': return `Appuie sur ${p.label ? `« ${p.label} »` : `${p.what || 'l\'élément'} n° ${(p.index ?? 0) + 1}`}`;
      case 'select_option': return `${{ language: 'Langue', theme: 'Thème', basemap: 'Fond de carte' }[p.field] || p.field} : ${p.label || p.value}`;
      case 'type_field': return `Écrit « ${p.text} »`;
      case 'scroll_panel': return p.text || p.section ? `Défile jusqu'à « ${p.text || p.section} »` : `Défilement ${{ down: 'vers le bas', up: 'vers le haut', top: 'en haut', bottom: 'en bas' }[p.to] || ''}`;
      case 'toggle': return `${p.open === false ? 'Replie' : 'Déplie'} ${{ intro: 'le bandeau', legend: 'la légende', paliers: 'les paliers', idees: 'les idées d\'indices', bio: 'la biographie' }[p.what] || p.what}`;
      case 'open_list_item': return `Fiche dans la liste : ${p.name || `n° ${(p.index ?? 0) + 1}`}`;
      case 'frame_view': return `Cadrage${p.near ? ' sur ' + p.near : ''} (×${(p.ratio || 1).toFixed(1)})`;
      case 'hold': return p.seconds ? `Pause de ${p.seconds} s` : 'Pause';
      case 'zoom_out': return 'Zoom arrière';
      default: return ACTIONS[it.action];
    }
  }

  async plan(request, defaults = {}) {
    const target = parseDuration(request) || defaults.target || null;
    const aspect = parseAspect(request) || defaults.aspect || '16:9';
    const styleName = parseStyle(request) || defaults.style || 'documentary';
    let intents = await this.intents(request);
    const notes = [];
    if (!intents.length) {
      notes.push('Demande non reconnue : scénario de découverte par défaut.');
      intents = [{ action: 'open_continent', params: { continent: 'europe' }, weight: 0.6 },
        { action: 'open_country', params: { country: 'FRA' }, weight: 1.2 },
        { action: 'open_saint', params: { query: '@interesting', country: 'FRA' }, weight: 0.8 },
        { action: 'show_profile', params: {}, weight: 2 }];
    }
    if (intents[0].action !== 'establish_world') intents.unshift({ action: 'establish_world', params: {}, weight: 0.4 });
    if (!['hold', 'show_profile'].includes(intents.at(-1).action)) intents.push({ action: 'hold', params: {}, weight: 0.5 });
    let style = STYLES[styleName]; let speed = 1;
    let inWorld = true;
    let naturals = intents.map((it) => {
      const n = Planner.natural(it.action, style, inWorld);
      if (['open_continent', 'open_country', 'zoom_to_place'].includes(it.action)) inWorld = false;
      if (['establish_world', 'back_to_world'].includes(it.action)) inWorld = true;
      return n;
    });
    const nat = naturals.reduce((a, b) => a + b, 0);
    if (target && nat > target * 0.92) {
      speed = nat / (target * 0.85); naturals = naturals.map((n) => n / speed);
      notes.push(`Mouvements accélérés ×${speed.toFixed(2)} pour tenir ${target} s.`);
    }
    const free = Math.max(0, (target || nat * 1.3) - naturals.reduce((a, b) => a + b, 0));
    const weights = intents.reduce((a, it) => a + it.weight, 0) || 1;
    const shots = intents.map((it, i) => ({ id: `s${String(i + 1).padStart(2, '0')}`, action: it.action, params: it.params,
      duration: +(naturals[i] + free * it.weight / weights).toFixed(2), label: this.describe(it) }));
    return { request, shots, style: styleName, speed, aspect, target, notes };
  }
}

export function total(sc) { return sc.shots.reduce((a, s) => a + s.duration, 0); }
