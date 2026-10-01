"""SANCTIMAPS_ADAPTER : ce que l'agent sait *de la structure* de SanctiMaps.

Ce fichier ne contient aucune donnée sur les saints : ni noms, ni lieux, ni
dates. Il décrit la forme du site — où sont la carte, la recherche, la fiche —
et comment le lire. Les contenus sont toujours lus sur le site lui-même, à
chaque session, car ils évoluent.

Les sélecteurs sont rangés par ordre de préférence ; s'ils cessent de
correspondre, l'agent le détecte (``SanctiMapsAdapter.check_profile``) et bascule
sur des repères plus génériques (rôles ARIA, textes visibles), puis sur la vision.
"""

from __future__ import annotations

SANCTIMAPS_ADAPTER = {
    "name": "SanctiMaps",
    "concepts": [
        "carte mondiale", "saints", "bienheureux", "vénérables", "pays", "villes et régions",
        "siècles", "dates de fête", "fiches individuelles", "biographies", "apparitions",
        "miracles eucharistiques", "calendrier (saint du jour)", "recherche",
        "navigation par pays", "navigation par lieu", "navigation par siècle",
    ],
    # Trois échelles de lecture : monde → continent → pays. Un clic sur un pays
    # depuis le monde ouvre son continent ; depuis le continent, le pays.
    "levels": ["world", "continent", "country"],
    "transition_ms": 720,  # durée de l'animation du site entre deux cadrages
    "wheel_zoom_coef": 0.0015,  # facteur = exp(-deltaY × coef), cf. map/view.js
    "drag_threshold_px": 4,  # en dessous, un glisser est lu comme un clic
    "data_base": "data/generated",
    "selectors": {
        "loader": ["#loader", "[role=dialog][aria-modal=true]"],
        "loader_ready": ["#loader.is-ready"],
        "loader_error": ["#loader.is-error"],
        "loader_close": ["#loader-go", "#loader-close", "button:has-text('Voir la carte')"],
        "map_host": ["#map-host", "main .map-host"],
        "map_svg": ["#map-host svg.map", "svg.map"],
        "scene": ["#map-host svg.map g.scene", "svg.map g.scene"],
        "country_path": "path.country[data-country=\"{iso}\"]",
        "cluster": ".overlay [data-cluster]",
        "marker_label": ".overlay .marker__label",
        "picker": ".picker.is-open",
        "picker_item": ".picker.is-open .picker__item",
        "trail": [".trail", "nav[aria-label*='Ariane']"],
        "crumb": ".trail .crumb",
        "hint": [".hint"],
        "corpus_button": ".corpus__btn",
        "zoom_fit": ".zoom__fit",
        "panel": ["#panel", "aside.panel"],
        "panel_toggle": [".panel-toggle"],
        "panel_close": [".panel__close"],
        "menu_item": ".menu__item[data-tab=\"{tab}\"]",
        "search_input": [".search__input", "input[type=search]"],
        "search_summary": ".search .results__summary",
        "search_result": ".search .results .result",
        "search_token": ".search .chip--token",
        "daily": ".daily",
        "daily_date": ".daily__date",
        "daily_nav": ".daily__nav button",
        "daily_result": ".daily .results .result",
        "fiche": ["#fiche", "section.fiche"],
        "fiche_name": [".fiche__name"],
        "fiche_close": [".fiche__close"],
        "fiche_body": [".fiche__body"],
        "detail_name": ".detail__name",
        "legend": ".legend",
    },
    "sidebar_tabs": {"daily": "Saint du jour", "search": "Rechercher", "add": "Ajouter",
                     "jeux": "Jeux", "settings": "Réglages"},
    "corpus": {"saints": "Saints", "apparitions": "Apparitions", "miracles": "Miracles"},
    "continents": {
        "europe": ["europe"],
        "africa": ["afrique", "africa"],
        "asia": ["asie", "asia", "moyen-orient", "proche-orient"],
        "north-america": ["amerique du nord", "amérique du nord", "north america", "amerique centrale"],
        "south-america": ["amerique du sud", "amérique du sud", "amerique latine", "south america"],
        "oceania": ["oceanie", "océanie", "oceania", "australie et pacifique"],
    },
    # Libellés des lignes de la fiche (français) → clé normalisée.
    "profile_rows": {
        "reconnaissance": "recognition",
        "approbation": "approval",
        "patronage": "patronage",
        "naissance": "born",
        "mort": "died",
        "annee": "year",
        "lieu de naissance": "birthplace",
        "lieu de mort": "deathplace",
        "lieu": "place",
        "fete": "feast",
        "qualites": "titles",
        "garde": "kept",
    },
}

# ----------------------------------------------------------------- lecture DOM

SNAPSHOT_JS = r"""
() => {
  const q = (s) => document.querySelector(s);
  const host = q('#map-host');
  const scene = q('#map-host svg.map g.scene') || q('svg.map g.scene');
  let transform = null;
  if (scene) {
    const m = /translate\(([-\d.e]+)[ ,]+([-\d.e]+)\)\s*scale\(([-\d.e]+)\)/.exec(scene.getAttribute('transform') || '');
    if (m) transform = [parseFloat(m[3]), parseFloat(m[1]), parseFloat(m[2])];
  }
  const loader = q('#loader');
  const fiche = q('#fiche');
  const panel = q('#panel');
  const body = panel && panel.querySelector('.panel__body');
  let section = null;
  if (panel && panel.classList.contains('is-open')) {
    if (body && body.querySelector('.search')) section = 'search';
    else if (body && body.querySelector('.daily')) section = 'daily';
    else if (panel.classList.contains('is-menu')) section = 'menu';
    else section = 'other';
  }
  const corpusBtn = [...document.querySelectorAll('.corpus__btn')].find((b) => b.getAttribute('aria-pressed') === 'true');
  const trail = [...document.querySelectorAll('.trail .crumb')].map((c) => c.textContent.trim());
  const rect = host ? host.getBoundingClientRect() : null;
  return {
    loader: loader ? (loader.classList.contains('is-error') ? 'error' : loader.classList.contains('is-ready') ? 'ready' : 'loading') : null,
    loaderText: loader ? (q('#loader-text') || {}).textContent : null,
    mode: host ? host.dataset.mode || null : null,
    hasSvg: !!q('svg.map'),
    transform,
    rafPending: window.__sm ? window.__sm.pending() : 0,
    trail,
    hint: (q('.hint') && !q('.hint').hidden) ? q('.hint').textContent : null,
    corpus: corpusBtn ? corpusBtn.textContent.trim() : null,
    corpusIndex: corpusBtn ? [...document.querySelectorAll('.corpus__btn')].indexOf(corpusBtn) : -1,
    ficheOpen: !!(fiche && !fiche.hidden),
    ficheName: fiche && !fiche.hidden ? ((q('.fiche__name') || {}).textContent || '').trim() : null,
    detailName: fiche && !fiche.hidden ? ((fiche.querySelector('.detail__name') || {}).textContent || '').trim() : null,
    detailRows: fiche && !fiche.hidden ? fiche.querySelectorAll('.sheet__row').length : 0,
    picker: !!q('.picker.is-open'),
    activeMarker: !!q('.overlay .marker.is-active'),
    section,
    centuryToken: !!(body && body.querySelector('.chip--century')),
    tilesLoading: document.querySelectorAll('.tiles image.tile:not(.is-loaded):not(.is-stale)').length,
    mapRect: rect ? [rect.left, rect.top, rect.width, rect.height] : null,
    clusters: document.querySelectorAll('.overlay [data-cluster]').length,
  };
}
"""

# Points cliquables d'un pays : on sonde une grille sur sa boîte et l'on garde
# les points où le pays est réellement l'élément touché (ni une étiquette, ni un
# territoire d'outre-mer lointain). Le point retenu est le plus central de la
# plus grande « masse » de points.
COUNTRY_POINT_JS = r"""
(iso) => {
  const path = document.querySelector(`path.country[data-country="${iso}"]`);
  if (!path) return null;
  const host = document.querySelector('#map-host').getBoundingClientRect();
  const blockers = [...document.querySelectorAll('.trail, .corpus, .hint, .legend, .zoom, .scale, .attribution, .panel-toggle, .topbar, #panel.is-open, #fiche:not([hidden])')]
    .filter((e) => e.offsetParent || e.getClientRects().length).map((e) => e.getBoundingClientRect());
  const r = path.getBoundingClientRect();
  const x0 = Math.max(r.left, host.left + 8), x1 = Math.min(r.right, host.right - 8);
  const y0 = Math.max(r.top, host.top + 8), y1 = Math.min(r.bottom, host.bottom - 8);
  if (x1 <= x0 || y1 <= y0) return null;
  const pts = [];
  const N = 36;
  for (let i = 0; i <= N; i++) for (let j = 0; j <= N; j++) {
    const x = x0 + (x1 - x0) * i / N, y = y0 + (y1 - y0) * j / N;
    if (blockers.some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom)) continue;
    const e = document.elementFromPoint(x, y);
    const c = e && e.closest && e.closest('[data-country]');
    if (c && c.dataset.country === iso && !e.closest('.marker, .label, .overlay')) pts.push([x, y]);
  }
  if (!pts.length) return null;
  // densité : chaque point compte ses voisins, on garde la zone la plus pleine
  const step = Math.max((x1 - x0) / N, (y1 - y0) / N) * 1.6;
  let best = null, bestScore = -1;
  for (const p of pts) {
    const score = pts.filter((o) => Math.abs(o[0] - p[0]) <= step * 2 && Math.abs(o[1] - p[1]) <= step * 2).length;
    if (score > bestScore) { bestScore = score; best = p; }
  }
  return { x: best[0], y: best[1], samples: pts.length };
}
"""

# Un point de la carte sûr pour poser la souris (glisser, molette) : dans la
# zone de carte, hors des commandes et des repères.
SAFE_POINT_JS = r"""
([px, py]) => {
  const host = document.querySelector('#map-host').getBoundingClientRect();
  const ok = (x, y) => {
    const e = document.elementFromPoint(x, y);
    return e && e.closest && e.closest('svg.map') && !e.closest('.marker, .label, [data-cluster], [data-saint], [data-lieu]');
  };
  const cx = px ?? host.left + host.width / 2, cy = py ?? host.top + host.height / 2;
  if (ok(cx, cy)) return [cx, cy];
  for (let r = 10; r < Math.max(host.width, host.height) / 2; r += 10) {
    for (let a = 0; a < 16; a++) {
      const x = cx + r * Math.cos(a * Math.PI / 8), y = cy + r * Math.sin(a * Math.PI / 8);
      if (x > host.left + 4 && x < host.right - 4 && y > host.top + 4 && y < host.bottom - 4 && ok(x, y)) return [x, y];
    }
  }
  return [cx, cy];
}
"""

PROFILE_JS = r"""
() => {
  const fiche = document.querySelector('#fiche');
  if (!fiche || fiche.hidden) return null;
  const txt = (s) => { const e = fiche.querySelector(s); return e ? e.textContent.trim() : null; };
  return {
    title: (document.querySelector('.fiche__name') || {}).textContent?.trim() || null,
    name: txt('.detail__name'),
    aka: txt('.detail__aka'),
    notice: txt('.notice'),
    rows: [...fiche.querySelectorAll('.sheet__row')].map((r) => [
      (r.querySelector('dt') || {}).textContent?.trim() || '', (r.querySelector('dd') || {}).textContent?.trim() || '']),
    description: txt('.detail__desc'),
    biography: txt('.detail__bio'),
    translated: txt('.detail__traduit'),
    sources: [...fiche.querySelectorAll('.detail__sources a')].map((a) => ({ label: a.textContent.trim(), url: a.href })),
    lieux: [...fiche.querySelectorAll('.detail__lieu')].map((l) => l.textContent.trim().replace(/\s+/g, ' ')),
    hasPortrait: !!fiche.querySelector('.detail__portrait:not([hidden]) img, .fiche__photo'),
    scrollHeight: (fiche.querySelector('.fiche__body') || fiche).scrollHeight,
    clientHeight: (fiche.querySelector('.fiche__body') || fiche).clientHeight,
  };
}
"""
