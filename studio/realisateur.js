// Réalisateur : une demande en français → un storyboard pensé, minuté, vérifié.
//
// Le planificateur (planner.js) traduit des phrases en plans, dans l'ordre.
// Le réalisateur, lui, comprend d'abord la demande (sujet, saint, lieux,
// durée, ton), raisonne sur la meilleure façon de la montrer avec ce que
// SanctiMaps sait faire, construit un storyboard (introduction, approche,
// présentation, développement, conclusion), règle le rythme, vérifie tout,
// puis corrige ce qui ne va pas. Il ne s'appuie que sur les données du site
// (saints, lieux de leur vie, dates, fêtes) et sur les actions existantes du
// metteur en scène (director.js) : rien n'est inventé.
//
// Il tourne entièrement dans le navigateur, sans serveur ni service extérieur :
// c'est un moteur de règles de réalisation, pas un modèle de langage.
import { CONTINENT_LABEL, fold } from './sanctimaps.js';
import { ACTIONS, Planner, STYLES, parseAspect, parseCentury, parseDuration, parseStyle, splitClauses, total } from './planner.js';

export const DEFAULT_DURATION = 45;

/** Les trois versions qu'on peut proposer pour une même demande. */
export const VARIANTS = {
  informative: { label: 'Informative', style: 'educational', lieuxMax: 3, continent: true, reading: 1.25, intro: 1,
    desc: 'Rythme clair, mouvements modérés, priorité aux informations.' },
  dynamic: { label: 'Dynamique', style: 'fast', lieuxMax: 5, continent: false, reading: 0.75, intro: 0.6,
    desc: 'Introduction forte, scènes courtes, caméra plus mobile.' },
  documentary: { label: 'Documentaire', style: 'documentary', lieuxMax: 4, continent: true, reading: 1, intro: 1.2,
    desc: 'Rythme posé, mouvements fluides, contexte historique.' },
};

const QUOI = {
  naissance: 'Lieu de naissance', enfance: 'Enfance', formation: 'Formation', residence: 'Résidence', oeuvre: 'Œuvre',
  fondation: 'Fondation', predilection: 'Lieu de prédilection', apparition: 'Apparition', miracle: 'Miracle',
  mort: 'Lieu de mort', sepulture: 'Sépulture',
};
// L'ordre d'une vie : un parcours chronologique raconte mieux qu'une liste.
const LIFE = ['naissance', 'enfance', 'formation', 'residence', 'oeuvre', 'fondation', 'predilection', 'miracle', 'mort', 'sepulture'];
const TITLES = {
  priest: ['prêtre'], bishop: ['évêque'], monk: ['moine'], nun: ['religieuse'], religious: ['religieux', 'religieuse'],
  abbot: ['abbé'], missionary: ['missionnaire'], founder: ['fondateur', 'fondatrice'], hermit: ['ermite'], pope: ['pape'],
  abbess: ['abbesse'], martyr: ['martyr', 'martyre'], deacon: ['diacre'], mystic: ['mystique'], cardinal: ['cardinal'],
  apostle: ['apôtre'], virgin: ['vierge'], preacher: ['prédicateur', 'prédicatrice'], layperson: ['laïc', 'laïque'],
  king: ['roi'], queen: ['reine'], soldier: ['soldat'], prince: ['prince', 'princesse'], prophet: ['prophète'],
  pilgrim: ['pèlerin', 'pèlerine'], evangelist: ['évangéliste'], widow: ['veuve'], disciple: ['disciple'],
};
const STATUT = { saint: ['Saint', 'Sainte'], bienheureux: ['Bienheureux', 'Bienheureuse'], venerable: ['Vénérable', 'Vénérable'],
  serviteur: ['Serviteur de Dieu', 'Servante de Dieu'] };
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const CONT_WORDS = { europe: 'europe', afrique: 'africa', asie: 'asia', oceanie: 'oceania',
  'amerique du nord': 'north-america', 'amerique du sud': 'south-america', 'amerique latine': 'south-america' };

/** Ce qui ferme une fiche ouverte sur la carte. */
const CLOSES_FICHE = new Set(['establish_world', 'back_to_world', 'open_continent', 'open_country', 'zoom_to_place', 'pan_to_place',
  'fit_country', 'close_profile', 'frame_view', 'level_up', 'century_filter', 'calendar', 'open_tab', 'search_list']);
const OPENS_FICHE = new Set(['open_saint', 'open_list_item', 'open_marker', 'open_apparition']);
const MOTION = new Set(['establish_world', 'back_to_world', 'open_continent', 'open_country', 'zoom_to_place', 'pan_to_place',
  'fit_country', 'frame_view', 'zoom_in', 'zoom_out', 'pan', 'level_up']);

export const EMOJI = {
  establish_world: '🌍', back_to_world: '🌍', open_continent: '🗺️', open_country: '🧭', fit_country: '🧭', zoom_to_place: '📍',
  pan_to_place: '📍', frame_view: '📍', zoom_in: '🔍', zoom_out: '🔍', pan: '↔️', level_up: '⤴️', open_saint: '✝️',
  open_list_item: '✝️', open_marker: '✝️', show_profile: '📖', close_profile: '📕', show_lieux: '🗺️', show_croises: '🤝',
  century_filter: '🕰️', calendar: '📅', apparitions_on: '✨', apparitions_off: '✝️', open_apparition: '✨', miracles_on: '✨',
  search_list: '🔎', close_panel: '✖️', open_tab: '📂', press: '👆', select_option: '⚙️', type_field: '⌨️', scroll_panel: '📜',
  toggle: '📂', quiz_correct: '🎲', hold: '⏸️',
};

const plural = (n, one, many) => `${n} ${n > 1 ? many : one}`;
const year = (y) => (y < 0 ? `${-y} av. J.-C.` : String(y));
const nameOf = (s) => s?.name?.fr || s?.name || '';

/** Les dates d'un saint, telles que les donne le site (« vers » quand elles sont approximatives). */
export function lifespan(s) {
  if (s.born == null && s.died == null) return '';
  const v = s.circa ? 'vers ' : '';
  if (s.born != null && s.died != null) return `${v}${year(s.born)} – ${year(s.died)}`;
  return s.died != null ? `mort ${v ? 'vers ' : 'en '}${year(s.died)}` : `né${s.sex === 'f' ? 'e' : ''} ${v ? 'vers ' : 'en '}${year(s.born)}`;
}
function feastLabel(s) {
  const m = /^(\d\d)-(\d\d)$/.exec(s.feast || '');
  return m ? `fêté${s.sex === 'f' ? 'e' : ''} le ${+m[2] === 1 ? '1er' : +m[2]} ${MONTHS[+m[1] - 1]}` : '';
}
function titlesOf(s) {
  const f = s.sex === 'f' ? 1 : 0;
  return (s.titles || []).map((t) => TITLES[t]).filter(Boolean).map((w) => w[f] || w[0]).slice(0, 2);
}
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

export class Realisateur {
  /**
   * ``dryCommand(text)`` traduit une commande du pilotage en plans, sans rien
   * exécuter (le même analyseur que « Piloter la carte ») : c'est ainsi que le
   * réalisateur n'utilise que des commandes qui existent vraiment.
   */
  constructor(data, { dryCommand = null, memory = null } = {}) {
    this.data = data; this.dryCommand = dryCommand; this.memory = memory;
    this.planner = new Planner(data, memory);
  }

  // ===================================================== 1. comprendre

  /** Ce que demande l'utilisateur : sujet, lieux, durée, format, ton, souhaits. */
  async analyse(request, defaults = {}) {
    const text = request.replace(/[’`]/g, "'");
    const t = fold(text);
    const brief = {
      request, target: parseDuration(text), aspect: parseAspect(text) || defaults.aspect || '16:9',
      styleAsked: parseStyle(text) || (defaults.style && defaults.style !== 'auto' ? defaults.style : null),
      saints: [], countries: [], continents: [], places: [], century: parseCentury(text), calendar: null, apparitions: false,
      wants: {}, start: null, end: null, explicit: [], unsupported: [], notes: [], captions: true,
    };
    brief.targetGiven = !!brief.target;
    if (!brief.target) brief.target = DEFAULT_DURATION;

    // Les saints nommés : « saint Louis », « sur Jeanne d'Arc », « la fiche de Thérèse ».
    const names = new Set(Planner.saintNames(text));
    const NAME = "([A-ZÉÈÂÎ][\\wàâçéèêëîïôûùüÿœ'-]+(?:\\s+(?:de|d'|du|la|le|des)?\\s*[A-ZÉÈÂÎ][\\wàâçéèêëîïôûùüÿœ'-]+)*)";
    for (const m of text.matchAll(new RegExp(`\\b(?:sur|de|à propos de|consacrée? à|présente[rz]?|raconte[rz]? (?:l'histoire|la vie) de|histoire de|vie de)\\s+(?:saint|sainte|la bienheureuse|le bienheureux)?\\s*${NAME}`, 'g'))) names.add(m[1]);
    const taken = [];
    for (const raw of names) {
      const name = raw.replace(/\s+(?:puis|et|en|à|dans)$/i, '').trim();
      if (this.data.findCountry(name) || this.data.continentId(name)) continue;
      const prefixed = new RegExp(`\\b(saint|sainte|bienheureux|bienheureuse|fiche (de|du|d'))\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text);
      const found = await this.data.findSaint(name);
      if (!found || (found.score < 55 && !(prefixed && found.score >= 30))) continue;
      if (brief.saints.some((s) => s.id === found.saint.id)) continue;
      brief.saints.push(found.saint); taken.push(name);
      const homonyms = (await this.data.saints()).filter((s) => fold(nameOf(s)).split(' ')[0] === fold(name).split(' ')[0]).length;
      if (homonyms > 1 && found.score < 100) brief.notes.push(`« ${name} » : ${homonyms} saints portent ce nom dans SanctiMaps ; le plus documenté est retenu : ${nameOf(found.saint)}.`);
    }
    // Les mots d'un nom de saint ne sont pas des lieux (« Élisabeth de Hongrie », « Saint-Louis »).
    let rest = text;
    for (const n of taken) rest = rest.split(n).join(' ');
    brief.countries = this.data.countriesIn(rest);
    const rt = fold(rest);
    for (const [w, cid] of Object.entries(CONT_WORDS)) if (new RegExp(`\\b${w}\\b`).test(rt) && !brief.continents.includes(cid)) brief.continents.push(cid);
    for (const clause of splitClauses(rest)) {
      for (const p of await this.planner.findPlaces(clause, brief.countries[0] || null)) {
        if (brief.places.some((q) => fold(q.name) === fold(p))) continue;
        const iso = (brief.countries[0] && await this.data.findPlace(p, brief.countries[0])) ? brief.countries[0] : (await this.data.cityCountry(p))?.iso;
        brief.places.push({ name: p, iso: iso || brief.countries[0] || null });
      }
    }
    if (/\bcalendrier|saint du jour|fete(s|e|es)? (aujourd|demain|le |ce )|fetes? aujourd/.test(t)) {
      const m = /\b(\d{1,2}(?:er)?\s+(?:janv|fevr|mars|avri|mai|juin|juil|aout|sept|octo|nove|dece)\w*)/.exec(t);
      brief.calendar = { day: /demain/.test(t) ? 'demain' : m ? m[1] : "aujourd'hui" };
    }
    // « apparition progressive » est une transition, pas le corpus des apparitions.
    brief.apparitions = /\bapparitions?\b/.test(t.replace(/apparitions? progressives?|en fondu/g, ''));
    const w = brief.wants;
    w.lieux = /\b(lieux|endroits|deplacements?|voyages?|parcours|itineraire|vecu|sa vie|vie de|histoire|ou il|ou elle)\b/.test(t);
    w.profile = /\b(fiche|presente|presenter|presentation|biographie|qui (etait|est)|raconte|histoire|vie)\b/.test(t) || brief.saints.length > 0;
    w.croises = /\b(croise|croises|croisees|contemporains|rencontr\w*|entourage|liens?)\b/.test(t);
    w.tour = /\b(plusieurs (zones|villes|regions|lieux|endroits)|differentes (zones|regions|villes)|parcour\w*|survol\w*|tour de|villes)\b/.test(t);
    w.kinds = [['fondation', /\bfondations?|fonde\w*\b/], ['mort', /\b(mort|deces|meurt|martyre)\b/], ['sepulture', /\b(tombeau|sepulture|enterre\w*|reliques)\b/],
      ['naissance', /\b(naissance|ne a|nee a|natale?)\b/], ['formation', /\b(etudes|formation)\b/]].filter(([, re]) => re.test(t)).map(([k]) => k);
    w.dynamicIntro = /\b(introduction|intro) (dynamique|forte|percutante|rapide)\b/.test(t);
    // Début et fin voulus.
    const startClause = splitClauses(text).find((c) => /\b(commence|debute|ouvre sur|demarre)\w*/.test(fold(c)));
    if (startClause) {
      const c = fold(startClause); const iso = this.data.countriesIn(startClause)[0];
      brief.start = /\b(monde|planisphere|globe|terre)\b/.test(c) ? { kind: 'world' } : iso ? { kind: 'country', iso } : null;
    }
    const endClause = splitClauses(text).find((c) => /\b(termine|finis|finir|fin |conclu|acheve)\w*/.test(fold(c)));
    if (endClause) {
      const c = fold(endClause); const iso = this.data.countriesIn(endClause)[0];
      brief.end = /\b(monde|planisphere|globe|vue generale du monde)\b/.test(c) ? { kind: 'world' }
        : iso ? { kind: 'country', iso } : /\b(pays|vue generale|vue d ensemble)\b/.test(c) ? { kind: 'country' }
          : /\bfiche\b/.test(c) ? { kind: 'profile' } : null;
    }
    // Ce que le moteur vidéo ne sait pas faire : on le dit au lieu de faire semblant.
    if (/\b(musique|bande son|chanson|sonore)\b/.test(t)) brief.unsupported.push('La musique : le moteur produit une vidéo muette (ajoutez la musique au montage, dans Photos ou CapCut).');
    if (/\b(voix off|voix|narrat\w* audio|commentaire audio|doublage|lu a voix haute)\b/.test(t)) brief.unsupported.push('La voix off : le studio ne parle pas. Le texte de narration de chaque scène est fourni pour l\'enregistrer vous-même.');
    if (/\b(fondu|fondus|enchaine|transitions?)\b/.test(t) || /apparitions? progressives?/.test(t)) brief.notes.push('Transitions : la vidéo est un seul plan continu ; les transitions sont des mouvements de caméra fluides (pas de fondus).');
    if (/\b(drone|3d|relief|satellite)\b/.test(t)) brief.unsupported.push('Les vues 3D ou satellite : SanctiMaps est une carte à plat.');

    // Le reste de la demande : des commandes du pilotage (jeux, paramètres,
    // panneaux…), traduites par l'analyseur existant, sans rien inventer.
    for (const clause of splitClauses(text)) {
      if (this.isMeta(clause) || this.isUnderstood(clause, brief, taken)) continue;
      const shots = await this.translate(clause);
      if (shots?.length) { brief.explicit.push({ clause, shots, opening: /\bcommence|d abord|pour commencer\b/.test(fold(clause)) }); continue; }
      const fallback = this.pressFallback(clause);
      if (fallback) {
        brief.explicit.push({ clause, shots: [fallback], fallback: true });
        brief.notes.push(`« ${clause} » : pas de commande directe ; essai du bouton « ${fallback.params.label} » de l'écran (vérifié pendant la répétition).`);
      } else if (/\b(montre|affiche|ouvre|fais|ajoute|mets|lance|zoome|va|passe)\b/.test(fold(clause))) {
        brief.unsupported.push(`« ${clause} » : cette partie de la demande ne peut pas être réalisée avec les fonctionnalités actuelles.`);
      }
    }
    return brief;
  }

  /** Une proposition de la demande qui ne décrit que la vidéo (durée, format, ton). */
  isMeta(clause) {
    const c = fold(clause);
    return !c || /^(fais|fait|cree|realise|prepare|genere)?\s*(moi )?(une |un )?(video|film|clip|montage|reel|short)\b[^]*$/.test(c) && !/\b(montre|ouvre|affiche|cherche|va |zoome|lance|passe|termine|commence)\b/.test(c)
      || /^(de |d )?\d+\s*(s|sec|secondes?|min|minutes?)$/.test(c) || /^(en )?(format )?(vertical|verticale|horizontal|horizontale|carre|carree)$/.test(c);
  }

  /** Une proposition déjà prise en charge par le storyboard (géographie, saint, fiche, lieux…). */
  isUnderstood(clause, brief, taken) {
    const c = fold(clause);
    if (taken.some((n) => c.includes(fold(n)))) return true;
    if (this.data.countriesIn(clause).length || brief.places.some((p) => c.includes(fold(p.name)))) return true;
    if (Object.keys(CONT_WORDS).some((w) => new RegExp(`\\b${w}\\b`).test(c))) return true;
    return /\b(monde|planisphere|fiche|lieux|endroits|villes?|zones?|regions?|survol\w*|fondations?|tombeau|sepulture|deplacements?|parcours|vie|histoire|croises?|contemporains|siecles?|calendrier|fetes?|fete|aujourd hui|demain|saint du jour|apparitions?|termine|conclu\w*|commence\w*|introduction|intro|pays|ville|region|carte|rapproche|approche|progressivement|zoome sur|descend\w*|sur (le |la )?saint|saints? de|saints? en)\b/.test(c);
  }

  async translate(clause) {
    if (!this.dryCommand) return null;
    try {
      const { report, shots } = await this.dryCommand(clause);
      return report?.ok && shots?.length ? shots.map((s) => ({ ...s, params: { ...(s.params || {}) } })) : null;
    } catch { return null; }
  }

  /** « Ouvre le panneau des saints » → « Appuie sur Saints », si rien de plus direct n'existe. */
  pressFallback(clause) {
    const m = /\b(?:ouvre|appuie sur|clique sur|touche|active|selectionne)\s+(?:moi\s+)?(?:le |la |les |l'|un |une )?(?:bouton |onglet |panneau |menu |rubrique |section )?(?:des |du |de la |de l'|de )?(.{2,40})$/i.exec(clause.trim().replace(/[.!?]$/, ''));
    if (!m) return null;
    const label = m[1].replace(/^[«"]\s*|\s*[»"]$/g, '').trim();
    if (!label || /\b(video|carte|fiche)\b/i.test(fold(label))) return null;
    return { action: 'press', params: { label: cap(label) } };
  }

  // ===================================================== 2. raisonner

  /** La réflexion du réalisateur, question par question, avec ses réponses. */
  async think(brief) {
    const R = []; const ask = (q, a) => R.push({ q, a });
    const S = brief.saints[0];
    const lieux = S ? await this.lifePlaces(S) : [];
    const focus = S ? 'saint' : brief.apparitions ? 'apparitions' : brief.calendar ? 'calendar' : brief.century ? 'century'
      : (brief.places.length || brief.countries.length || brief.continents.length) ? 'place' : brief.explicit.length ? 'commands' : 'default';
    brief.focus = focus;
    const subject = S ? `${nameOf(S)} (${lifespan(S)})${titlesOf(S).length ? ', ' + titlesOf(S).join(', ') : ''}`
      : focus === 'place' ? (brief.places[0]?.name || (brief.countries[0] && this.data.countryName(brief.countries[0])) || CONTINENT_LABEL[brief.continents[0]])
        : focus === 'calendar' ? `les saints fêtés ${brief.calendar.day === "aujourd'hui" ? "aujourd'hui" : brief.calendar.day === 'demain' ? 'demain' : 'le ' + brief.calendar.day}`
          : focus === 'century' ? `les saints du ${brief.century}e siècle${brief.countries[0] ? ' en ' + this.data.countryName(brief.countries[0]) : ''}`
            : focus === 'apparitions' ? 'les apparitions' : focus === 'commands' ? 'une démonstration de l\'application' : 'les saints de France (demande trop vague : découverte par défaut)';
    ask('Quel est le sujet ?', cap(subject) + '.');
    if (S) {
      const texts = await this.data.texts();
      ask('Quel saint est concerné ?', `${nameOf(S)} — ${texts[S.id]?.desc?.fr || 'fiche SanctiMaps'}`);
    }
    const home = S?.country || brief.countries[0] || brief.places[0]?.iso || null;
    const homeCont = home && CONTINENT_LABEL[this.data.countryById.get(home)?.continent];
    const start = brief.start?.kind === 'country' ? `directement au-dessus du pays (${this.data.countryName(brief.start.iso)})`
      : home ? `vue du monde → ${homeCont ? cap(homeCont.replace(/^l'/, '')) + ' → ' : ''}${this.data.countryName(home)}` : 'vue du monde';
    ask('Où commencer ?', cap(start) + ' : le spectateur sait tout de suite où il est.');
    if (S) {
      const birth = await this.birthPlace(S);
      const list = [...(birth ? [`${birth.name} (naissance)`] : []), ...lieux.map((l) => `${l.nom} (${QUOI[l.quoi]?.toLowerCase() || l.quoi})`)];
      ask('Quels lieux sont importants ?', list.length ? list.join(', ') + ' — d\'après les données de SanctiMaps.' : 'SanctiMaps n\'indique pas d\'autre lieu pour ce saint que son lieu principal.');
      const abroad = lieux.filter((l) => l.iso && l.iso !== S.country).map((l) => this.data.countryName(l.iso));
      ask('Quelle progression géographique ?', lieux.length
        ? `Chronologique, comme une vie : ${[...new Set(lieux.map((l) => QUOI[l.quoi]?.toLowerCase()))].join(' → ')}.${abroad.length ? ` Le parcours sort de ${this.data.countryName(S.country)} (${[...new Set(abroad)].join(', ')}).` : ''}`
        : `Du monde vers ${this.data.countryName(S.country)}, puis ${birth ? birth.name : 'son lieu'}.`);
      const info = [lifespan(S), feastLabel(S), S.patronage?.fr ? `patron de : ${S.patronage.fr}` : '', ...titlesOf(S)].filter(Boolean);
      ask('Quelles informations montrer ?', `La fiche du site (biographie), et en titres : ${info.join(' · ')}.`);
    } else if (focus === 'place') {
      const iso = brief.countries[0] || brief.places[0]?.iso;
      const tour = iso ? await this.data.tour(iso) : [];
      ask('Quels lieux montrer ?', [...brief.places.map((p) => p.name), ...(brief.wants.tour || !brief.places.length ? tour : [])].filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'le pays entier');
      const pick = iso ? await this.data.interesting(iso, brief.places[0]?.name) : null;
      if (pick) ask('Quelle fiche pour donner un visage au lieu ?', `${pick} — le saint le plus documenté ${brief.places[0] ? 'de ' + brief.places[0].name : 'du pays'}.`);
    }
    const end = brief.end?.kind === 'world' ? 'retour à la vue du monde' : brief.end?.kind === 'profile' ? 'sur la fiche' : home ? `retour à la vue du pays (${this.data.countryName(brief.end?.iso || home)})` : 'retour à une vue d\'ensemble';
    ask('Quelle conclusion ?', `${cap(end)} : la vidéo se referme sur une vue large, le titre reste à l'écran.`);
    if (brief.explicit.length) ask('Quelles autres actions demandées ?', brief.explicit.map((e) => `« ${e.clause} »${e.fallback ? ' (bouton de l\'écran)' : ''}`).join(', '));
    if (brief.unsupported.length) ask('Qu\'est-ce qui n\'est pas faisable ?', brief.unsupported.join(' '));
    return R;
  }

  async lifePlaces(S) {
    const { lieux } = await this.data.lieux();
    const list = (lieux[S.id] || []).filter((l) => l.quoi !== 'apparition' && Number.isFinite(l.x));
    list.sort((a, b) => LIFE.indexOf(a.quoi) - LIFE.indexOf(b.quoi));
    // Deux lieux presque confondus (même ville) : un seul arrêt.
    const kept = [];
    for (const l of list) if (kept.every((k) => Math.hypot(k.x - l.x, k.y - l.y) > 60)) kept.push({ ...l, iso: this.data.countryAt(l.x, l.y) });
    return kept;
  }

  async birthPlace(S) {
    if (!S.city) return null;
    const city = await this.data.findPlace(S.city.replace(/\s*\(.*\)$/, ''), S.country) || await this.data.findPlace(S.city, S.country);
    return city ? { name: city.n, iso: S.country, x: city.x, y: city.y } : { name: S.city, iso: S.country, x: S.x, y: S.y, approximate: true };
  }

  // ===================================================== 3. storyboard

  scene(action, params, o = {}) {
    return { action, params: params || {}, purpose: o.purpose || '', priority: o.priority ?? 2, weight: o.weight ?? 1,
      transition: o.transition || (MOTION.has(action) ? 'mouvement fluide' : 'continu'), caption: o.caption || null,
      narration: o.narration || '', minimum: o.minimum || 0 };
  }

  /** Le storyboard d'une version : une suite de scènes, chacune avec sa fonction. */
  async storyboard(brief, variantName = 'documentary') {
    const V = VARIANTS[variantName];
    const styleName = brief.styleAsked && variantName === recommended(brief) ? brief.styleAsked : V.style;
    const S = brief.saints[0];
    const texts = await this.data.texts();
    const scenes = []; this.notes = [];
    const add = (...a) => { const s = this.scene(...a); scenes.push(s); return s; };
    const title = S ? `${STATUT[S.statut]?.[S.sex === 'f' ? 1 : 0] || ''} ${nameOf(S)}`.trim() : this.titleFor(brief);
    const home = brief.start?.iso || S?.country || brief.countries[0] || brief.places[0]?.iso || null;
    const cont = home ? this.data.countryById.get(home)?.continent : brief.continents[0] || null;

    // Introduction : le sujet dès la première seconde.
    const intro = add('establish_world', {}, { purpose: 'Introduction', priority: 1, weight: 0.5 * V.intro,
      caption: { title, sub: S ? [lifespan(S), titlesOf(S).join(', ')].filter(Boolean).join(' · ') : 'SanctiMaps — la carte des saints' },
      narration: S ? `${title}${texts[S.id]?.desc?.fr ? ' : ' + texts[S.id].desc.fr.replace(/\.$/, '') : ''}.` : `${title}.` });
    if (brief.start?.kind === 'country') intro.weight = 0.3;
    // Les commandes demandées « pour commencer » viennent juste après.
    for (const e of brief.explicit.filter((x) => x.opening)) for (const sh of e.shots) add(sh.action, sh.params, { purpose: 'Demande : ' + e.clause, priority: 1 });

    if (brief.focus === 'saint') await this.saintStory(brief, S, V, add, texts, { home, cont, title });
    else if (brief.focus === 'place') await this.placeStory(brief, V, add, texts, { home, cont });
    else if (brief.focus === 'century') {
      if (home) this.approach(add, V, cont, home);
      add('century_filter', { century: brief.century, country: home }, { purpose: 'Le siècle demandé', priority: 1, weight: 1.2,
        caption: { title: `${brief.century}e siècle`, sub: home ? `Les saints de ${this.data.countryName(home)}` : 'Les saints de ce siècle' } });
      add('open_list_item', { index: 0 }, { purpose: 'Un saint de ce siècle', priority: 1, weight: 0.8 });
      add('show_profile', {}, { purpose: 'Lecture de la fiche', priority: 1, weight: 2.5, minimum: 5 * V.reading });
    } else if (brief.focus === 'calendar') {
      add('calendar', { day: brief.calendar.day }, { purpose: 'Les saints du jour', priority: 1, weight: 1.2,
        caption: { title: brief.calendar.day === "aujourd'hui" ? "Fêtés aujourd'hui" : brief.calendar.day === 'demain' ? 'Fêtés demain' : `Fêtés le ${brief.calendar.day}`, sub: 'Calendrier des saints' } });
      add('open_list_item', { index: 0 }, { purpose: 'Le premier saint de la liste', priority: 1, weight: 0.8 });
      add('show_profile', {}, { purpose: 'Lecture de la fiche', priority: 1, weight: 2.5, minimum: 5 * V.reading });
      add('close_panel', {}, { purpose: 'Retour à la carte', priority: 2, weight: 0.3 });
    } else if (brief.focus === 'apparitions') {
      add('apparitions_on', {}, { purpose: 'Le corpus des apparitions', priority: 1, weight: 0.8, caption: { title: 'Les apparitions', sub: 'SanctiMaps' } });
      if (home) this.approach(add, V, cont, home, false);
      const name = brief.places[0]?.name;
      if (name) {
        add('open_apparition', { name }, { purpose: `L'apparition de ${name}`, priority: 1, weight: 1 });
        add('show_profile', {}, { purpose: 'Lecture de la fiche', priority: 1, weight: 2.5, minimum: 5 * V.reading });
      }
    } else if (brief.focus === 'default') {
      this.notes.push('Demande trop vague pour un sujet précis : découverte des saints de France.');
      this.approach(add, V, 'europe', 'FRA');
      const pick = await this.data.interesting('FRA');
      if (pick) {
        add('open_saint', { query: pick }, { purpose: 'Un saint emblématique', priority: 1, weight: 0.8 });
        add('show_profile', {}, { purpose: 'Lecture de la fiche', priority: 1, weight: 2.5, minimum: 5 * V.reading });
      }
    }

    // Les autres actions demandées (jeux, paramètres, panneaux…), avant la conclusion.
    for (const e of brief.explicit.filter((x) => !x.opening)) for (const sh of e.shots) add(sh.action, sh.params, { purpose: 'Demande : ' + e.clause, priority: 1 });

    // Conclusion : jamais une fin brutale.
    this.conclude(brief, scenes, add, { home: brief.end?.iso || home, title, S });
    return this.finalize(brief, scenes, variantName, styleName);
  }

  approach(add, V, cont, iso, withContinent = V.continent) {
    if (withContinent && cont) add('open_continent', { continent: cont }, { purpose: 'Approche', priority: 3, weight: 0.5,
      caption: { title: cap(CONTINENT_LABEL[cont]?.replace(/^l'/, '') || cont), sub: '' } });
    add('open_country', { country: iso }, { purpose: 'Localisation', priority: 1, weight: 0.8,
      caption: { title: this.data.countryName(iso), sub: CONTINENT_LABEL[cont] ? cap(CONTINENT_LABEL[cont].replace(/^l'/, '')) : '' } });
  }

  async saintStory(brief, S, V, add, texts, { home, cont, title }) {
    const T = texts[S.id] || {};
    const birth = await this.birthPlace(S);
    if (brief.start?.kind !== 'country' || brief.start.iso !== S.country) this.approach(add, V, cont, S.country);
    else add('open_country', { country: S.country }, { purpose: 'Localisation', priority: 1, weight: 0.8, caption: { title: this.data.countryName(S.country), sub: '' } });
    // La ville demandée (« présente Paris »), sinon la ville natale.
    const asked = brief.places.find((p) => !p.iso || p.iso === S.country);
    const lieux = await this.lifePlaces(S);
    if (asked) {
      const here = await this.data.findPlace(asked.name, S.country);
      const near = here ? lieux.filter((l) => Math.hypot(l.x - here.x, l.y - here.y) < 120) : [];
      add('zoom_to_place', { place: asked.name, country: S.country }, { purpose: `Présenter ${asked.name}`, priority: 1, weight: 1,
        caption: { title: asked.name, sub: near.length ? `${near.map((l) => `${l.nom} (${QUOI[l.quoi]?.toLowerCase()})`).join(' · ')}` : '' } });
    } else if (birth && !birth.approximate) {
      add('zoom_to_place', { place: birth.name, country: S.country }, { purpose: 'Le lieu de naissance', priority: 2, weight: 1,
        caption: { title: birth.name, sub: `${S.sex === 'f' ? 'Née' : 'Né'} ici${S.born != null ? (S.circa ? ' vers ' : ' en ') + year(S.born) : ''}` },
        narration: `${nameOf(S)} ${S.sex === 'f' ? 'est née' : 'est né'} à ${birth.name}${S.born != null ? (S.circa ? ' vers ' : ' en ') + year(S.born) : ''}.` });
    }
    // Présentation : la fiche du site, lisible assez longtemps.
    const desc = T.desc?.fr || ''; const bio = T.bio?.fr || '';
    add('open_saint', { query: nameOf(S) }, { purpose: 'Présenter le saint', priority: 1, weight: 0.8,
      caption: { title, sub: [lifespan(S), feastLabel(S)].filter(Boolean).join(' · ') } });
    const reading = Math.min(10, Math.max(5, (desc.length + Math.min(bio.length, 300)) / 50)) * V.reading;
    add('show_profile', {}, { purpose: 'Sa fiche', priority: 1, weight: 3, minimum: reading,
      caption: desc ? { title: nameOf(S), sub: desc } : (S.patronage?.fr ? { title: nameOf(S), sub: `Patron de : ${S.patronage.fr}` } : null),
      narration: bio.split(/(?<=\.)\s/).slice(0, 2).join(' ') || desc });
    if (brief.wants.croises) add('show_croises', {}, { purpose: 'Les saints qu\'il a pu croiser', priority: 2, weight: 1.2,
      caption: { title: 'Ses contemporains', sub: 'Saints qu\'il a pu croiser — SanctiMaps' } });
    // Ses lieux : d'abord tous ensemble sur la carte, puis le parcours de sa vie.
    const showLieux = lieux.length && (brief.wants.lieux || brief.focus === 'saint');
    if (showLieux) {
      const kinds = [...new Set(lieux.map((l) => QUOI[l.quoi]?.toLowerCase()))];
      add('show_lieux', {}, { purpose: 'Les lieux de sa vie', priority: 2, weight: 1.3,
        caption: { title: 'Les lieux de sa vie', sub: `${plural(lieux.length, 'lieu', 'lieux')} : ${kinds.join(', ')}` } });
      // Un lieu de chaque sorte d'abord (naissance, fondation, mort, sépulture…),
      // en commençant par celles que la demande nomme ; puis dans l'ordre de la vie.
      const kindsOrder = [...brief.wants.kinds, ...LIFE.filter((k) => !brief.wants.kinds.includes(k))];
      const pool = kindsOrder.map((k) => lieux.filter((l) => l.quoi === k)).filter((g) => g.length);
      const chosen = [];
      for (let round = 0; chosen.length < Math.min(V.lieuxMax, lieux.length); round++) for (const g of pool) if (g[round] && chosen.length < V.lieuxMax) chosen.push(g[round]);
      chosen.sort((a, b) => LIFE.indexOf(a.quoi) - LIFE.indexOf(b.quoi) || lieux.indexOf(a) - lieux.indexOf(b));
      const seen = {};
      chosen.forEach((l) => {
        // Le premier lieu de chaque sorte compte (deux pour celle que la demande nomme) ; les suivants sont facultatifs.
        seen[l.quoi] = (seen[l.quoi] || 0) + 1;
        const key = seen[l.quoi] <= (brief.wants.kinds.includes(l.quoi) ? 2 : 1);
        add('frame_view', { x: l.x, y: l.y, ratio: l.iso === S.country ? 5 : 3.5, country: l.iso || S.country, near: l.nom },
          { purpose: `${QUOI[l.quoi] || 'Lieu'} : ${l.nom}`, priority: key ? 2 : 3, weight: 1.1,
            caption: { title: l.nom, sub: [QUOI[l.quoi], l.desc?.fr].filter(Boolean).join(' — ') },
            narration: `${QUOI[l.quoi] || 'Lieu'} : ${l.nom}${l.desc?.fr ? ', ' + l.desc.fr : ''}.` });
      });
      if (lieux.length > chosen.length) this.notes.push(`${plural(lieux.length - chosen.length, 'autre lieu', 'autres lieux')} dans SanctiMaps, laissé${lieux.length - chosen.length > 1 ? 's' : ''} de côté pour tenir la durée.`);
    } else if (brief.wants.lieux) this.notes.push(`SanctiMaps n'indique pas de lieux marqués pour ${nameOf(S)} : la vidéo montre son lieu principal.`);
  }

  async placeStory(brief, V, add, texts, { home, cont }) {
    if (!home && brief.continents[0]) {
      add('open_continent', { continent: brief.continents[0] }, { purpose: 'Le continent', priority: 1, weight: 1,
        caption: { title: cap(CONTINENT_LABEL[brief.continents[0]].replace(/^l'/, '')), sub: 'Les saints de ce continent' } });
      return;
    }
    if (brief.start?.kind !== 'country') this.approach(add, V, cont, home);
    else add('open_country', { country: home }, { purpose: 'Localisation', priority: 1, weight: 0.8, caption: { title: this.data.countryName(home), sub: '' } });
    const names = brief.places.filter((p) => !p.iso || p.iso === home).map((p) => p.name);
    if (brief.wants.tour || !names.length) for (const n of await this.data.tour(home)) if (!names.includes(n)) names.push(n);
    const saints = await this.data.saintsIn(home);
    for (const [i, name] of names.slice(0, Math.max(brief.places.length, V.lieuxMax - 1)).entries()) {
      const born = saints.filter((s) => fold(s.city) === fold(name));
      const famous = born.length ? await this.data.interesting(home, name) : null;
      add(i ? 'pan_to_place' : 'zoom_to_place', { place: name, country: home }, { purpose: `Présenter ${name}`, priority: i < brief.places.length ? 1 : 3, weight: 1,
        caption: { title: name, sub: famous ? `Ville natale de ${famous}` : '' } });
    }
    const pick = await this.data.interesting(home, brief.places[0]?.name);
    if (pick) {
      add('open_saint', { query: pick }, { purpose: 'Un visage du lieu', priority: 1, weight: 0.8 });
      const s = (await this.data.findSaint(pick))?.saint;
      add('show_profile', {}, { purpose: 'Sa fiche', priority: 1, weight: 2.5, minimum: 6 * V.reading,
        caption: s ? { title: nameOf(s), sub: [lifespan(s), texts[s.id]?.desc?.fr].filter(Boolean).join(' · ') } : null });
    }
    if (brief.century) add('century_filter', { century: brief.century, country: home }, { purpose: 'Le siècle demandé', priority: 1, weight: 1.2,
      caption: { title: `${brief.century}e siècle`, sub: `Les saints de ${this.data.countryName(home)}` } });
  }

  conclude(brief, scenes, add, { home, title, S }) {
    const last = scenes.at(-1)?.action;
    if (brief.end?.kind === 'profile' && ['show_profile', 'show_lieux', 'show_croises'].includes(last)) { scenes.at(-1).purpose += ' — conclusion'; return; }
    const caption = { title, sub: 'SanctiMaps — la carte des saints' };
    if (brief.end?.kind === 'world' || !home) add('back_to_world', {}, { purpose: 'Conclusion : vue générale', priority: 1, weight: 0.8, caption });
    else add('fit_country', { country: home }, { purpose: `Conclusion : vue du pays (${this.data.countryName(home)})`, priority: 1, weight: 0.8, caption,
      narration: S ? `${nameOf(S)}, sur la carte des saints.` : '' });
  }

  titleFor(brief) {
    if (brief.focus === 'place') return brief.places[0]?.name ? `Les saints de ${brief.places[0].name}` : brief.countries[0] ? `Les saints de ${this.data.countryName(brief.countries[0])}` : `Les saints ${CONTINENT_LABEL[brief.continents[0]] ? 'de ' + CONTINENT_LABEL[brief.continents[0]] : ''}`.trim();
    if (brief.focus === 'calendar') return 'Le calendrier des saints';
    if (brief.focus === 'century') return `Les saints du ${brief.century}e siècle`;
    if (brief.focus === 'apparitions') return 'Les apparitions';
    if (brief.focus === 'commands') return 'SanctiMaps en action';
    return 'Les saints de France';
  }

  /** Scènes → plans du metteur en scène (le format de scénario existant), minutés. */
  finalize(brief, scenes, variantName, styleName) {
    const describer = this.planner;
    const shots = scenes.map((s) => ({ id: '', action: s.action, params: s.params, duration: 0, label: describer.describe(s),
      purpose: s.purpose, priority: s.priority, weight: s.weight, transition: s.transition, caption: s.caption, narration: s.narration, minimum: s.minimum }));
    const sc = { request: brief.request, title: shots[0]?.caption?.title || this.titleFor(brief), shots, style: styleName, speed: 1, aspect: brief.aspect,
      target: brief.target, notes: [...brief.notes, ...this.notes], variant: variantName, captions: brief.captions, version: 2 };
    renumber(sc);
    sc.notes.push(...this.optimize(sc), ...this.fitTiming(sc));
    return sc;
  }

  // ===================================================== 4. rythme

  /** La durée naturelle d'un plan (mouvement, lecture), au style choisi. */
  natural(shot, style, fromWorld) {
    const base = Planner.natural(shot.action, style, fromWorld) ?? 2;
    return Math.max(base, shot.minimum || 0, shot.caption ? 2.5 : 0);
  }

  /**
   * Ajuste les durées pour tomber exactement sur la durée voulue : d'abord le
   * temps nécessaire à chaque scène (mouvement, lecture), puis le reste réparti
   * selon l'importance. Trop long : on retire les scènes facultatives, puis on
   * accélère les mouvements (jamais la lecture des fiches).
   */
  fitTiming(sc, target = sc.target || null) {
    const style = STYLES[sc.style] || STYLES.documentary; const notes = [];
    // Changer de pays en cours de route (Paris → Tunis) passe par le continent : deux transitions de plus.
    const naturals = () => { let inWorld = true, here = null; return sc.shots.map((s) => {
      let n = this.natural(s, style, inWorld);
      const iso = s.params?.country;
      if (['frame_view', 'zoom_to_place', 'pan_to_place', 'fit_country'].includes(s.action) && iso && here && iso !== here) {
        const far = this.data.countryById.get(iso)?.continent !== this.data.countryById.get(here)?.continent;
        n += (far ? 3 : 2) * style.transition + style.settle;
      }
      if (iso && !['century_filter'].includes(s.action)) here = iso;
      if (['open_continent', 'open_country', 'zoom_to_place', 'frame_view'].includes(s.action)) inWorld = false;
      if (['establish_world', 'back_to_world'].includes(s.action)) { inWorld = true; here = null; }
      return n;
    }); };
    if (!target) target = Math.max(10, Math.round(total(sc) || naturals().reduce((a, b) => a + b, 0) * 1.25));
    let nat = naturals();
    const sumOf = (arr) => arr.reduce((a, b) => a + b, 0);
    // Accélérer les mouvements seulement (jusqu'à ``limit``) : une fiche doit rester lisible.
    const speedFor = (limit) => {
      const sum = sumOf(nat); if (sum <= target * 0.92) return 1;
      const motion = sc.shots.reduce((a, s, i) => a + (MOTION.has(s.action) ? nat[i] : 0), 0);
      return Math.min(limit, Math.max(1, motion / Math.max(1, target * 0.9 - (sum - motion))));
    };
    // Trop de choses pour le temps donné : d'abord les scènes facultatives
    // (en partant de la fin), puis une caméra un peu plus vive, et seulement
    // ensuite les scènes importantes.
    const drop = (prio, limit) => {
      for (;;) {
        const sp = speedFor(limit);
        if (sumOf(nat.map((n, i) => (MOTION.has(sc.shots[i].action) ? n / sp : n))) <= target * 0.92) return;
        const i = sc.shots.map((s, k) => [s, k]).reverse().find(([s]) => (s.priority ?? 2) === prio && !(s.action === 'show_lieux' && sc.shots.some((o) => o.action === 'frame_view')))?.[1];
        if (i == null) return;
        notes.push(`« ${sc.shots[i].label} » retiré pour tenir ${target} s.`);
        sc.shots.splice(i, 1); nat = naturals();
      }
    };
    drop(3, 1); drop(2, 1.6);
    let speed = speedFor(2.5);
    if (speed > 1.01) { nat = nat.map((n, i) => (MOTION.has(sc.shots[i].action) ? n / speed : n)); notes.push(`Mouvements accélérés ×${speed.toFixed(2)} pour tenir ${target} s.`); } else speed = 1;
    sc.speed = +speed.toFixed(3);
    const free = Math.max(0, target - nat.reduce((a, b) => a + b, 0));
    const weights = sc.shots.reduce((a, s) => a + (s.weight ?? 1), 0) || 1;
    sc.shots.forEach((s, i) => { s.duration = Math.max(0.5, +(nat[i] + free * (s.weight ?? 1) / weights).toFixed(1)); });
    // Le compte exact : l'écart d'arrondi va à la scène la plus longue.
    const diff = +(target - total(sc)).toFixed(1);
    if (Math.abs(diff) >= 0.1 && sc.shots.length) { const big = sc.shots.reduce((a, s) => (s.duration > a.duration ? s : a)); big.duration = +(big.duration + diff).toFixed(1); }
    sc.target = target;
    renumber(sc);
    return notes;
  }

  // ===================================================== 5. optimiser

  /** Règles de réalisation : chaque scène a une fonction, pas de va-et-vient ni de temps mort. */
  optimize(sc) {
    const changes = []; const S = sc.shots;
    const same = (a, b) => a && b && a.action === b.action && JSON.stringify(a.params) === JSON.stringify(b.params);
    for (let i = S.length - 1; i > 0; i--) {
      if (same(S[i], S[i - 1]) && S[i].action !== 'press') { changes.push(`Doublon retiré : ${S[i].label}.`); S[i - 1].duration += S[i].duration; S.splice(i, 1); continue; }
      const pair = [S[i - 1].action, S[i].action].join('>');
      if (pair === 'zoom_in>zoom_out' || pair === 'zoom_out>zoom_in') { changes.push('Zoom avant puis arrière inutile retiré.'); S.splice(i - 1, 2); i--; continue; }
      if (S[i].action === 'hold' && S[i - 1].action === 'hold') { S[i - 1].duration += S[i].duration; S.splice(i, 1); changes.push('Deux pauses fusionnées.'); continue; }
      // Monde → monde, pays → même pays : mouvement sans effet.
      if (S[i].action === 'establish_world' && ['establish_world', 'back_to_world'].includes(S[i - 1].action)) { S.splice(i, 1); changes.push('Retour au monde superflu retiré.'); continue; }
      if (S[i].action === 'fit_country' && S[i - 1].action === 'open_country' && S[i].params.country === S[i - 1].params.country) { S.splice(i, 1); changes.push('Recadrage sur le pays déjà cadré retiré.'); }
    }
    // Pas de longue pause au milieu de la vidéo.
    S.forEach((s, i) => { if (s.action === 'hold' && i < S.length - 1 && s.duration > 3) { changes.push(`Pause raccourcie (${s.duration.toFixed(1)} → 2 s).`); s.duration = 2; } });
    // Une fiche ouverte doit être lue ; une fiche lue doit d'abord être ouverte.
    for (let i = 0; i < S.length; i++) {
      if (OPENS_FICHE.has(S[i].action) && S[i + 1]?.action !== 'show_profile' && !['show_lieux', 'show_croises'].includes(S[i + 1]?.action)) {
        S.splice(i + 1, 0, { id: '', action: 'show_profile', params: {}, duration: 6, label: ACTIONS.show_profile, purpose: 'Lecture de la fiche', priority: 1, weight: 2.5, minimum: 5 });
        changes.push('Lecture de la fiche ajoutée après son ouverture.');
      }
      if (['show_profile', 'show_lieux', 'show_croises'].includes(S[i].action)) {
        let open = false;
        for (let k = i - 1; k >= 0; k--) { if (OPENS_FICHE.has(S[k].action)) { open = true; break; } if (CLOSES_FICHE.has(S[k].action)) break; }
        if (!open) { changes.push(`« ${S[i].label} » sans fiche ouverte : retiré.`); S.splice(i, 1); i--; }
      }
    }
    renumber(sc);
    return changes;
  }

  // ===================================================== 6. vérifier

  /**
   * Contrôle de cohérence avant tournage. Chaque point est soit validé, soit
   * corrigé automatiquement (``fixed``), soit signalé (``ok: false``).
   */
  async validate(sc, brief = null) {
    const checks = []; const check = (ok, text, fixed = false) => checks.push({ ok, text, fixed });
    // Commandes existantes.
    const unknown = sc.shots.filter((s) => !(s.action in ACTIONS));
    if (unknown.length) { sc.shots = sc.shots.filter((s) => s.action in ACTIONS); check(true, `Actions inconnues retirées : ${unknown.map((s) => s.action).join(', ')}.`, true); }
    else check(true, 'Toutes les scènes utilisent des commandes existantes.');
    // Paramètres réalisables avec les données du site.
    const bad = [];
    for (const s of [...sc.shots]) {
      const p = s.params;
      if (['open_country', 'fit_country'].includes(s.action) && p.country && !this.data.countryById.has(p.country)) bad.push(s);
      if (['zoom_to_place', 'pan_to_place'].includes(s.action) && p.place && !p.place.startsWith('@')
        && !(p.country && await this.data.findPlace(p.place, p.country)) && !(await this.data.cityCountry(p.place))) {
        // Alternative : le saint né là, ou rien.
        const born = (await this.data.saints()).find((x) => fold(x.city) === fold(p.place));
        if (born) { Object.assign(s, { action: 'frame_view', params: { x: born.x, y: born.y, ratio: 4, country: born.country, near: p.place } }); check(true, `« ${p.place} » : cadrage sur sa position dans SanctiMaps (alternative la plus proche).`, true); }
        else bad.push(s);
      }
      if (s.action === 'open_saint' && p.query && !p.query.startsWith('@') && !(await this.data.findSaint(p.query))) bad.push(s);
    }
    if (bad.length) { sc.shots = sc.shots.filter((s) => !bad.includes(s)); check(true, `Introuvable dans SanctiMaps, retiré : ${bad.map((s) => s.label).join(', ')}.`, true); }
    else check(true, 'Lieux, pays et saints trouvés dans les données de SanctiMaps.');
    // Ordre et rythme.
    const changes = this.optimize(sc);
    check(true, changes.length ? `Ordre et rythme corrigés : ${changes.join(' ')}` : 'Ordre logique, sans doublon ni va-et-vient.', changes.length > 0);
    if (!['establish_world', 'open_continent'].includes(sc.shots[0]?.action)) {
      sc.shots.unshift({ id: '', action: 'establish_world', params: {}, duration: 3, label: ACTIONS.establish_world, purpose: 'Introduction', priority: 1, weight: 0.5,
        caption: sc.title ? { title: sc.title, sub: 'SanctiMaps — la carte des saints' } : null });
      check(true, 'Introduction ajoutée (vue du monde).', true);
    } else check(true, 'Introduction : le sujet est posé dès la première scène.');
    const lastA = sc.shots.at(-1)?.action;
    const endsOnProfile = ['show_profile', 'show_lieux', 'show_croises'].includes(lastA) && /conclusion/i.test(sc.shots.at(-1)?.purpose || '');
    if (!['fit_country', 'back_to_world', 'hold'].includes(lastA) && !endsOnProfile) {
      // Le pays principal de la vidéo (le premier où l'on descend), pas forcément le dernier visité.
      const iso = sc.shots.find((s) => s.action === 'open_country')?.params.country || [...sc.shots].reverse().find((s) => s.params?.country)?.params.country;
      const caption = sc.title ? { title: sc.title, sub: 'SanctiMaps — la carte des saints' } : null;
      sc.shots.push(iso ? { id: '', action: 'fit_country', params: { country: iso }, duration: 4, label: `Retour à la vue de ${this.data.countryName(iso)}`, purpose: `Conclusion : vue du pays (${this.data.countryName(iso)})`, priority: 1, weight: 0.8, caption }
        : { id: '', action: 'back_to_world', params: {}, duration: 4, label: ACTIONS.back_to_world, purpose: 'Conclusion : vue générale', priority: 1, weight: 0.8, caption });
      check(true, 'Conclusion ajoutée : la vidéo ne se termine plus brutalement.', true);
    } else check(true, 'Conclusion : la vidéo se termine sur une vue posée.');
    // Durées.
    const style = STYLES[sc.style] || STYLES.documentary;
    const short = sc.shots.filter((s) => s.duration < Math.min(this.natural(s, style, false) / (sc.speed || 1), s.minimum || 99) * 0.9 || (s.action === 'show_profile' && s.duration < (s.minimum || 4.5)));
    const target = sc.target || null;
    const off = target && Math.abs(total(sc) - target) > 0.25;
    if (short.length || off || sc.shots.some((s) => !s.duration)) {
      this.fitTiming(sc, target);
      check(true, `Durées rééquilibrées${off ? ` (total ramené à ${target} s)` : ''}${short.length ? ` ; scènes trop courtes allongées : ${short.map((s) => s.label).join(', ')}` : ''}.`, true);
    } else check(true, `Durée totale : ${total(sc).toFixed(0)} s${target ? ` (demandé : ${target} s)` : ''}.`);
    const deadTime = sc.shots.filter((s, i) => s.action === 'hold' && i < sc.shots.length - 1 && s.duration > 3);
    check(!deadTime.length, deadTime.length ? 'Pauses longues au milieu de la vidéo.' : 'Pas de temps mort.');
    // Les éléments demandés sont présents.
    if (brief) {
      const has = (a) => sc.shots.some((s) => s.action === a);
      const missing = [];
      if (brief.saints.length && !has('open_saint')) missing.push(`la fiche de ${nameOf(brief.saints[0])}`);
      if (brief.wants.lieux && brief.saints.length && !has('show_lieux') && !has('frame_view')) missing.push('les lieux du saint');
      for (const p of brief.places) if (!sc.shots.some((s) => fold(s.params?.place || s.params?.near || '') === fold(p.name))) missing.push(p.name);
      check(!missing.length, missing.length ? `Non réalisable avec les données actuelles : ${missing.join(', ')}.` : 'Tous les éléments demandés sont dans le storyboard.');
      for (const u of brief.unsupported) check(false, u);
    }
    check(true, 'Transitions : mouvements de caméra continus et adoucis, sans coupe.');
    renumber(sc);
    return checks;
  }

  /**
   * Après la répétition : chaque action a été jouée pour de vrai (en temps
   * virtuel), on connaît sa durée réelle. Une scène trop courte pour son
   * mouvement est allongée, et le temps est repris sur les scènes qui en ont
   * de trop (lecture, pauses) : la vidéo garde la durée demandée.
   */
  retime(sc, actual) {
    const target = sc.target || total(sc);
    const floor = (s) => {
      const real = actual[s.id];
      if (['show_profile', 'hold'].includes(s.action) || real == null) return s.action === 'show_profile' ? Math.min(s.duration, Math.max(4, (s.minimum || 5) * 0.8)) : Math.min(s.duration, 1.5);
      return real + 0.25;
    };
    const mins = sc.shots.map(floor);
    sc.shots.forEach((s, i) => { if (s.duration < mins[i]) s.duration = +mins[i].toFixed(1); });
    let excess = total(sc) - target;
    const longer = sc.shots.filter((s, i) => s.duration > mins[i] + 0.05);
    if (excess > 0.05) {
      const slack = sc.shots.map((s, i) => Math.max(0, s.duration - mins[i]));
      const room = slack.reduce((a, b) => a + b, 0);
      const k = Math.min(1, excess / (room || 1));
      sc.shots.forEach((s, i) => { s.duration = +(s.duration - slack[i] * k).toFixed(1); });
      excess = total(sc) - target;
    }
    if (Math.abs(excess) >= 0.1 && longer.length) { const big = sc.shots.reduce((a, s, i) => (s.duration - mins[i] > a.d ? { s, d: s.duration - mins[i] } : a), { s: null, d: -1 }).s; if (big) big.duration = +(big.duration - excess).toFixed(1); }
    return +total(sc).toFixed(1);
  }

  // ===================================================== 7. améliorer

  /**
   * « Améliorer la vidéo » : le même sujet, mieux raconté. Ajoute une
   * introduction et une conclusion si besoin, enlève le superflu, rend les
   * fiches lisibles, ajoute les titres à l'écran manquants, rééquilibre.
   */
  async improve(sc) {
    const before = JSON.stringify(sc.shots.map((s) => [s.action, s.params, s.duration]));
    const changes = [];
    // Titres manquants, tirés des données.
    for (const s of sc.shots) {
      if (s.caption) continue;
      const c = await this.captionFor(s, sc);
      if (c) { s.caption = c; changes.push(`Titre ajouté : « ${c.title} ».`); }
    }
    // Un pays visité en dernier sert de conclusion naturelle.
    const checks = await this.validate(sc);
    for (const c of checks) if (c.fixed) changes.push(c.text);
    // Une introduction trop longue fait attendre : 4 s au plus.
    const first = sc.shots[0];
    if (first?.action === 'establish_world' && first.duration > 4.5 && sc.shots.length > 2) {
      const extra = first.duration - 3.5; first.duration = 3.5;
      const main = sc.shots.filter((s) => s.action === 'show_profile')[0] || sc.shots[1];
      main.duration = +(main.duration + extra).toFixed(1);
      changes.push(`Introduction raccourcie à 3,5 s : le sujet arrive plus vite (+${extra.toFixed(1)} s pour « ${main.label} »).`);
    }
    // Une fiche affichée moins de 5 s n'est pas lisible.
    const target = sc.target || Math.round(total(sc));
    for (const s of sc.shots.filter((x) => x.action === 'show_profile' && x.duration < 5)) {
      const need = 5 - s.duration; s.duration = 5;
      const donor = [...sc.shots].filter((x) => x !== s && x.action !== 'show_profile' && x.duration > 3).sort((a, b) => b.duration - a.duration)[0];
      if (donor) donor.duration = +(donor.duration - need).toFixed(1);
      changes.push('Fiche allongée à 5 s pour être lisible.');
    }
    this.fitTiming(sc, target);
    if (JSON.stringify(sc.shots.map((s) => [s.action, s.params, s.duration])) === before && !changes.length) changes.push('Le scénario est déjà équilibré : rien à changer.');
    return changes;
  }

  /** Un titre à l'écran pour une scène, à partir des seules données du site. */
  async captionFor(s, sc) {
    const p = s.params || {};
    switch (s.action) {
      case 'establish_world': case 'back_to_world': return sc.title ? { title: sc.title, sub: 'SanctiMaps — la carte des saints' } : null;
      case 'open_country': return p.country ? { title: this.data.countryName(p.country), sub: '' } : null;
      case 'open_continent': return CONTINENT_LABEL[p.continent] ? { title: cap(CONTINENT_LABEL[p.continent].replace(/^l'/, '')), sub: '' } : null;
      case 'zoom_to_place': case 'pan_to_place': return p.place && !p.place.startsWith('@') ? { title: p.resolvedPlace || p.place, sub: '' } : null;
      case 'frame_view': return p.near ? { title: p.near, sub: '' } : null;
      case 'open_saint': {
        const f = p.query && !p.query.startsWith('@') ? await this.data.findSaint(p.query) : null;
        return f ? { title: nameOf(f.saint), sub: [lifespan(f.saint), feastLabel(f.saint)].filter(Boolean).join(' · ') } : null;
      }
      case 'century_filter': return { title: `${p.century}e siècle`, sub: '' };
      default: return null;
    }
  }

  // ===================================================== tout ensemble

  /**
   * La chaîne complète : comprendre → raisonner → storyboards (3 versions) →
   * optimiser → vérifier. ``onStep(étape, détail)`` suit l'avancement.
   */
  async direct(request, defaults = {}, onStep = () => {}) {
    await onStep('analyse', '🧠 Analyse de la demande…');
    const brief = await this.analyse(request, defaults);
    const reasoning = await this.think(brief);
    await onStep('analyse-ok', `✅ Sujet identifié : ${reasoning[0].a}`);
    await onStep('route', '🗺️ Préparation des déplacements…');
    const S = brief.saints[0];
    const stops = S ? (await this.lifePlaces(S)).length : brief.places.length;
    await onStep('route-ok', `✅ Itinéraire créé${stops ? ` (${plural(stops, 'lieu', 'lieux')})` : ''}`);
    await onStep('board', '🎬 Création du storyboard…');
    const variants = {};
    for (const v of Object.keys(VARIANTS)) variants[v] = await this.storyboard(brief, v);
    const best = recommended(brief);
    await onStep('board-ok', `✅ ${plural(variants[best].shots.length, 'scène', 'scènes')} · 3 versions`);
    await onStep('timing', '⏱️ Optimisation du timing…');
    await onStep('timing-ok', `✅ ${brief.target} secondes${brief.targetGiven ? '' : ' (durée par défaut)'}`);
    await onStep('check', '🔍 Vérification…');
    const checks = {};
    for (const v of Object.keys(variants)) checks[v] = await this.validate(variants[v], brief);
    const problems = checks[best].filter((c) => !c.ok).length;
    await onStep('check-ok', problems ? `⚠️ Scénario valide, ${plural(problems, 'réserve', 'réserves')}` : '✅ Scénario valide');
    for (const v of Object.keys(variants)) variants[v].reasoning = reasoning;
    return { brief, reasoning, variants, checks, recommended: best };
  }
}

/** La version que le réalisateur recommande pour cette demande. */
export function recommended(brief) {
  const s = brief.styleAsked;
  if (s === 'fast') return 'dynamic';
  if (s === 'educational') return 'informative';
  if (s) return 'documentary';
  if (brief.wants.dynamicIntro || brief.target <= 30 || brief.aspect === '9:16') return 'dynamic';
  if (/\b(explique|apprendre|decouvrir|pedagog|eleves|enfants|cours)\b/.test(fold(brief.request))) return 'informative';
  return 'documentary';
}

export function renumber(sc) { sc.shots.forEach((s, i) => { s.id = `s${String(i + 1).padStart(2, '0')}`; }); }
