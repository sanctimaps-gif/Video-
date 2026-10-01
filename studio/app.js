import { Clock, SanctiMaps, SiteData, fold } from './sanctimaps.js';
import { Planner, STYLES, parseCentury, total } from './planner.js';
import { Director } from './director.js';
import { StageRecorder, canRecord } from './recorder.js';
import { FrameRenderer, canRender } from './render.js';

const params = new URLSearchParams(location.search);
const SRC = params.get('src') || 'https://sanctimaps.fr/';
const LOGICAL = { '16:9': [1600, 900], '9:16': [900, 1600], '1:1': [1000, 1000] };
const OUTPUT = { '16:9': [1920, 1080], '9:16': [1080, 1920], '1:1': [1080, 1080] };
const $ = (s) => document.querySelector(s);

const ui = {
  request: $('#request'), aspect: $('#aspect'), style: $('#style'), plan: $('#plan'), shoot: $('#shoot'), play: $('#play'),
  stop: $('#stop'), timeline: $('#timeline'), notes: $('#notes'), log: $('#log'), wrap: $('#stage-wrap'), stage: $('#stage'),
  overlay: $('#overlay'), state: $('#state'), memory: $('#memory'), result: $('#result'), cmd: $('#cmd'), cmdGo: $('#cmd-go'),
  recHint: $('#rec-hint'), total: $('#total'), capture: $('#capture'), progress: $('#progress'),
  progressFill: $('#progress-fill'), progressText: $('#progress-text'), cmdResult: $('#cmd-result'),
  addPause: $('#add-pause'), clear: $('#clear'),
  demo: $('#demo'), demoList: $('#demo-list'), demoAll: $('#demo-all'), demoEmpty: $('#demo-empty'),
};

const clock = new Clock();
const data = new SiteData(SRC);
let sm = null, director = null, scenario = null, busy = false, iframe = null;

function log(line) { ui.log.textContent += line + '\n'; ui.log.scrollTop = ui.log.scrollHeight; }
function overlay(html) { ui.overlay.innerHTML = html || ''; ui.overlay.classList.toggle('on', !!html); }
function setBusy(b) {
  busy = b;
  for (const el of [ui.plan, ui.shoot, ui.play, ui.cmdGo, ui.capture]) el.disabled = b;
  ui.stop.disabled = !b;
}

// ---------------------------------------------------------------- scène

function layout() {
  const [lw, lh] = LOGICAL[ui.aspect.value];
  const shooting = document.body.classList.contains('shooting');
  const availW = shooting ? innerWidth : ui.wrap.parentElement.clientWidth;
  const availH = shooting ? innerHeight : Math.max(260, Math.min(innerHeight * 0.72, availW * lh / lw));
  const scale = Math.min(availW / lw, availH / lh);
  ui.stage.style.width = `${lw}px`; ui.stage.style.height = `${lh}px`;
  ui.stage.style.transform = `translate(${(availW - lw * scale) / 2}px, ${shooting ? (availH - lh * scale) / 2 : 0}px) scale(${scale})`;
  ui.wrap.style.height = `${shooting ? availH : lh * scale}px`;
}
addEventListener('resize', layout);

async function loadStage() {
  if (demo.on) toggleDemo(false);
  overlay('Chargement de SanctiMaps…');
  ui.stage.replaceChildren();
  iframe = document.createElement('iframe');
  iframe.title = 'SanctiMaps';
  iframe.src = `studio/frame.html?src=${encodeURIComponent(SRC)}`;
  ui.stage.append(iframe);
  layout();
  await new Promise((r) => iframe.addEventListener('load', r, { once: true }));
  sm = new SanctiMaps(iframe, clock, STYLES[ui.style.value], log);
  // La page du cadre est remplacée par celle du site : on attend qu'elle soit là.
  await sm.waitFor('page SanctiMaps', () => iframe.contentDocument?.querySelector('#map-host'), 60000);
  await sm.open(data);
  director = new Director(sm, data, {
    onShot: (shot, rehearsal) => markShot(shot.id, rehearsal ? 'répétition' : 'en cours'),
    onReport: (shot, rep, rehearsal) => { markShot(shot.id, null, rep); log(`${rehearsal ? '[répétition] ' : ''}${shot.id} ${rep}`); },
  });
  overlay('');
}

window.addEventListener('message', (e) => {
  if (e.data?.type === 'sm-frame-error') overlay(`Impossible de charger SanctiMaps (${e.data.message}).<br>Vérifiez la connexion puis rechargez la page.`);
});

// ------------------------------------------------------------- scénario

const STORE = 'sanctimaps-studio.v1';
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ scenario, request: ui.request.value, aspect: ui.aspect.value, style: ui.style.value })); } catch { /* stockage indisponible */ }
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!saved) return;
    if (saved.request && !params.get('demande')) ui.request.value = saved.request;
    if (saved.aspect && LOGICAL[saved.aspect] && !params.get('format')) ui.aspect.value = saved.aspect;
    if (saved.style && STYLES[saved.style]) ui.style.value = saved.style;
    if (saved.scenario?.shots?.length) scenario = saved.scenario;
  } catch { /* données illisibles : on repart de zéro */ }
}

/** Le scénario, modifiable : durée, ordre, suppression de chaque plan. */
function renderTimeline() {
  ui.timeline.replaceChildren();
  if (!scenario) { ui.total.textContent = ''; ui.notes.textContent = ''; save(); return; }
  let t = 0;
  scenario.shots.forEach((s, i) => {
    const li = document.createElement('li'); li.dataset.id = s.id;
    li.innerHTML = `<span class="t">${t.toFixed(1)} s</span>
      <span class="lbl"></span>
      <span class="st"></span>
      <span class="edit">
        <label class="dur"><input type="number" min="0.5" max="60" step="0.5" inputmode="decimal" aria-label="Durée en secondes"> s</label>
        <button class="mini" data-do="up" aria-label="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="mini" data-do="down" aria-label="Descendre" ${i === scenario.shots.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="mini del" data-do="del" aria-label="Supprimer">✕</button>
      </span>`;
    li.querySelector('.lbl').textContent = s.label;
    const input = li.querySelector('input'); input.value = s.duration;
    input.addEventListener('change', () => {
      const v = parseFloat(String(input.value).replace(',', '.'));
      if (Number.isFinite(v) && v >= 0.5 && v <= 60) s.duration = +v.toFixed(2);
      // Redessiner après la fin de l'événement : le champ est encore en cours d'édition.
      setTimeout(renderTimeline);
    });
    li.querySelector('.edit').addEventListener('click', (e) => {
      const what = e.target.closest('button')?.dataset.do; if (!what || busy) return;
      const list = scenario.shots;
      if (what === 'del') list.splice(i, 1);
      if (what === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      if (what === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      renumber(); renderTimeline();
    });
    ui.timeline.append(li); t += s.duration;
  });
  ui.total.textContent = `${total(scenario).toFixed(0)} s · ${scenario.aspect} · ${STYLES[scenario.style]?.label || scenario.style}`;
  ui.notes.textContent = (scenario.notes || []).join(' ');
  save();
}
function renumber() { scenario.shots.forEach((s, i) => { s.id = `s${String(i + 1).padStart(2, '0')}`; }); }

/** Ajoute des plans testés dans le pilotage à la fin du scénario. */
function addShots(shots) {
  if (!scenario) scenario = { request: ui.request.value.trim(), shots: [], style: ui.style.value, speed: 1, aspect: ui.aspect.value, target: null, notes: [] };
  const style = STYLES[scenario.style] || STYLES.documentary;
  for (const shot of shots) {
    if (!scenario.shots.length && shot.action === 'back_to_world') shot.action = 'establish_world';
    const natural = Planner.natural(shot.action, style, false) ?? 2;
    scenario.shots.push({ id: '', action: shot.action, params: shot.params || {},
      duration: shot.duration || +(natural / (scenario.speed || 1) + (shot.action === 'show_profile' ? 2 : 1)).toFixed(1),
      label: new Planner(data, sm?.memory).describe({ action: shot.action, params: shot.params || {} }) });
  }
  renumber(); renderTimeline();
  log(`Ajouté au scénario : ${shots.map((s) => new Planner(data).describe({ ...s, params: s.params || {} })).join(', ')}`);
}

function markShot(id, now, rep) {
  for (const li of ui.timeline.children) {
    if (now !== null) li.classList.toggle('is-now', li.dataset.id === id);
    if (li.dataset.id === id) {
      const st = li.querySelector('.st');
      if (rep) { st.textContent = rep.ok ? '✓' : '✗'; st.className = `st ${rep.ok ? 'ok' : 'bad'}`; st.title = rep.detail || ''; }
      else if (now) st.textContent = '…';
    }
  }
}

async function plan() {
  const text = ui.request.value.trim();
  if (!text) return null;
  const planner = new Planner(data, sm?.memory);
  scenario = await planner.plan(text, { aspect: ui.aspect.value, style: ui.style.value });
  scenario.title = text.split(/[.:]/)[0].slice(0, 80);
  if (scenario.aspect !== ui.aspect.value) { ui.aspect.value = scenario.aspect; await loadStage(); }
  ui.style.value = scenario.style;
  renderTimeline();
  return scenario;
}

async function rehearse() {
  overlay('<div>Répétition : l\'agent vérifie chaque plan avant de filmer…</div>');
  ui.overlay.style.background = 'rgba(20,14,8,.25)';
  const reports = await director.play(scenario, { rehearsal: true });
  ui.overlay.style.background = '';
  const failed = scenario.shots.filter((s) => !reports[s.id]?.ok);
  if (failed.length) {
    const removed = failed.reduce((a, s) => a + s.duration, 0);
    scenario.shots = scenario.shots.filter((s) => reports[s.id]?.ok);
    if (scenario.shots.length) scenario.shots.at(-1).duration += removed;
    scenario.notes.push(`Plans impossibles retirés : ${failed.map((s) => s.label).join(', ')}.`);
    renderTimeline();
  }
  overlay('');
  return scenario.shots.length > 0;
}

async function countdown(n, text) {
  for (let i = n; i > 0; i--) { overlay(`<div><div class="big">${i}</div><p>${text}</p></div>`); await new Promise((r) => setTimeout(r, 1000)); }
  overlay('');
}

async function captureTab() {
  if (busy) return;
  setBusy(true);
  let recorder = null;
  try {
    if (!scenario?.shots?.length) await plan();
    if (!scenario) return;
    // La permission de capture doit suivre le clic : on la demande d'abord.
    if (canRecord()) {
      recorder = new StageRecorder(ui.stage);
      try {
        const cropped = await recorder.prepare();
        if (!cropped) log('Capture sans rognage : choisissez cet onglet ; la vidéo contiendra toute la page.');
      } catch (e) { recorder = null; log(`Capture refusée (${e.message}) : passage en mode plein écran.`); }
    }
    if (!(await rehearse())) { log('Aucun plan réalisable.'); return; }
    await loadStage();
    for (const s of scenario.shots) markShot(s.id, null, null);
    if (recorder) {
      // La scène occupe toute la fenêtre pendant le tournage : la capture a la
      // définition de l'écran, pas celle de la vignette.
      document.body.classList.add('shooting'); layout();
      await Promise.all([countdown(3, 'Tournage'), recorder.probe()]);
      if (!recorder.mime) throw new Error("ce navigateur ne sait pas enregistrer la vidéo de l'onglet");
      recorder.start();
      await clock.wait(400);
      await director.play(scenario);
      await clock.wait(300);
      const out = await recorder.stop();
      document.body.classList.remove('shooting'); layout();
      if (!out || out.blob.size < 20000) throw new Error(`enregistrement vide (${recorder.mime || 'format inconnu'}) : essayez Chrome ou Edge à jour`);
      showResult(out);
    } else {
      document.body.classList.add('shooting'); layout();
      await countdown(5, "Lancez maintenant l'enregistrement de l'écran (Centre de contrôle).");
      await director.play(scenario);
      overlay('<div>Fin. Arrêtez l\'enregistrement de l\'écran.<br><br><button id="leave">Revenir au studio</button></div>');
      await new Promise((r) => $('#leave').addEventListener('click', r, { once: true }));
      overlay(''); document.body.classList.remove('shooting'); layout();
    }
  } catch (e) {
    log(`Échec : ${e.message}`); overlay('');
    document.body.classList.remove('shooting'); layout();
  } finally {
    if (recorder?.rec?.state === 'recording') await recorder.stop();
    setBusy(false);
  }
}

async function renderVideo() {
  if (busy) return;
  if (!canRender()) {
    log("Ce navigateur ne sait pas fabriquer la vidéo (WebCodecs absent : iOS 16.4 ou plus récent requis). Passage en mode plein écran.");
    return captureTab();
  }
  setBusy(true);
  let renderer = null, wakeLock = null;
  try {
    // Un rendu dure quelques minutes : l'écran ne doit pas se mettre en veille.
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* pas de verrou : tant pis */ }
    if (!scenario?.shots?.length) await plan();
    if (!scenario) return;
    if (!(await rehearse())) { log('Aucun plan réalisable.'); return; }
    await loadStage();
    for (const s of scenario.shots) markShot(s.id, null, null);
    const [w, h] = OUTPUT[ui.aspect.value];
    renderer = new FrameRenderer(iframe, { width: w, height: h, fps: 30 });
    await renderer.start();
    const expected = total(scenario);
    ui.progress.hidden = false;
    const onFrame = () => {
      const t = renderer.frames / 30;
      ui.progressFill.style.width = `${Math.min(100, (t / expected) * 100)}%`;
      ui.progressText.textContent = `Rendu ${t.toFixed(1)} / ${expected.toFixed(0)} s`;
    };
    clock.listeners.add(onFrame);
    clock.beginRender(renderer, 30);
    const started = performance.now();
    try {
      await clock.wait(300);
      await director.play(scenario);
      await clock.wait(300);
    } finally {
      clock.endRender(); clock.listeners.delete(onFrame);
    }
    ui.progressText.textContent = 'Finalisation du MP4…';
    const out = await renderer.finish();
    log(`Vidéo rendue : ${out.seconds.toFixed(1)} s, ${w}×${h}, ${out.codec === 'avc' ? 'H.264' : 'VP9'}, en ${((performance.now() - started) / 1000).toFixed(0)} s de calcul (carte ${out.stats.mapMs.toFixed(0)} ms/image, interface ${out.stats.overlayRenders}× ${out.stats.overlayMs.toFixed(0)} ms).`);
    showResult(out);
  } catch (e) {
    renderer?.abort(); clock.endRender();
    log(`Échec : ${e.message}`); overlay('');
  } finally {
    wakeLock?.release().catch(() => {});
    ui.progress.hidden = true;
    setBusy(false);
  }
}

function showResult({ blob, ext }) {
  const url = URL.createObjectURL(blob);
  const name = `sanctimaps-${ui.aspect.value.replace(':', 'x')}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;
  const file = new File([blob], name, { type: blob.type });
  const shareable = !!navigator.canShare?.({ files: [file] });
  ui.result.innerHTML = `<h2>Vidéo</h2><video controls playsinline></video>
    <div class="actions">
      ${shareable ? '<button class="primary share">Enregistrer / partager</button>' : ''}
      <a class="dl" download="${name}"><button class="${shareable ? '' : 'primary'}">Télécharger (${ext.toUpperCase()}, ${(blob.size / 1e6).toFixed(1)} Mo)</button></a>
    </div>
    <p class="hint">${shareable ? 'Sur iPhone : « Enregistrer / partager » puis « Enregistrer la vidéo » pour la mettre dans Photos.' : ''}</p>`;
  ui.result.querySelector('video').src = url;
  ui.result.querySelector('a.dl').href = url;
  ui.result.querySelector('.share')?.addEventListener('click', () => navigator.share({ files: [file], title: 'SanctiMaps' }).catch(() => {}));
  ui.result.hidden = false;
  ui.result.scrollIntoView({ behavior: 'smooth' });
}

async function playOnly() {
  if (busy) return;
  setBusy(true);
  try {
    if (!scenario?.shots?.length) await plan();
    if (scenario) await director.play(scenario);
  } catch (e) { log(`Échec : ${e.message}`); } finally { setBusy(false); }
}

// --------------------------------------------------------------- commandes

/**
 * Une commande de pilotage : exécutée sur la carte, elle rend aussi les plans
 * équivalents, qu'on peut ajouter au scénario une fois l'essai réussi.
 * Les motifs vont du plus précis au plus général.
 */
async function command(text) {
  const t = fold(text.replace('’', "'"));
  const clean = text.trim().replace(/[.!?]$/, '');
  let m;
  const done = (report, shots = []) => ({ report, shots });
  const run = async (shot) => done(await director.run({ params: {}, ...shot }), [shot]);

  // Pauses et niveaux
  if ((m = /\bpause(?: de)?\s*(\d+(?:[.,]\d+)?)?/.exec(t))) {
    const seconds = m[1] ? parseFloat(m[1].replace(',', '.')) : null;
    await clock.wait((seconds || 2) * 1000);
    return done({ ok: true, toString: () => `✓ pause${seconds ? ` de ${seconds} s` : ''}` }, [{ action: 'hold', params: seconds ? { seconds } : {}, duration: seconds }]);
  }
  if (/\b(remonte|niveau (au )?dessus|recule d un niveau|un niveau plus haut|retour arriere|reviens en arriere)\b/.test(t)) return run({ action: 'level_up' });
  if (/\b(vue (du )?monde|planisphere|reviens? au monde|monde entier|^monde$)\b/.test(t)) return done(await sm.goWorld(), [{ action: 'back_to_world' }]);
  if (/\b(vue d ?ensemble|recadre|tout le pays|vue (du|de la|de l) pays|cadrage d origine)\b/.test(t)) return run({ action: 'fit_country', params: { country: sm.memory.country } });

  // Corpus
  if (/\bmiracles?\b/.test(t)) return run({ action: 'miracles_on' });
  if ((m = /\bapparitions? (?:en|au|aux|de|du|d) (.+)$/.exec(fold(clean))) && data.findCountry(m[1])) {
    const iso = data.findCountry(m[1]);
    const r1 = await sm.setCorpus('apparitions'); if (!r1.ok) return done(r1);
    return done(await sm.goCountry(iso), [{ action: 'apparitions_on' }, { action: 'open_country', params: { country: iso } }]);
  }
  if (/\b(mode apparitions?|passe (en|aux) apparitions?|^apparitions?$|montre les apparitions)\b/.test(t)) return run({ action: 'apparitions_on' });
  if (/\b(mode saints|reviens? aux saints|^saints$)\b/.test(t)) return run({ action: 'apparitions_off' });

  // Ce que montre la fiche
  if (/\blieux\b/.test(t) && !/\bsaints? nes?\b/.test(t)) return run({ action: 'show_lieux' });
  if (/\b(crois(e|es|er|ee|ees)?|voisins|contemporains|rencontr\w*)\b/.test(t)) return run({ action: 'show_croises' });
  if (/\b(ferme|referme)\b.*\bfiche\b/.test(t)) return done(await sm.closeProfile(), [{ action: 'close_profile' }]);
  if (/\b(ferme|referme)\b.*\bpanneau\b/.test(t)) return run({ action: 'close_panel' });
  if (/\b(croix|saint|repere) (la plus proche|le plus proche|au hasard|ici|du centre)\b|\bouvre une croix\b/.test(t)) {
    const r = await sm.openNearestMarker();
    return done(r, [{ action: 'open_saint', params: { query: sm.memory.saint } }]);
  }
  if (/\b(sa|la|cette) fiche\b|\blis la fiche\b|\bfais defiler\b/.test(t)) {
    const shots = [];
    if (!sm.snapshot().ficheOpen) {
      const r = sm.memory.saint ? await sm.openSaint(sm.memory.saint) : await sm.openNearestMarker();
      if (!r.ok) return done(r);
      shots.push({ action: 'open_saint', params: { query: sm.memory.saint } });
    }
    shots.push({ action: 'show_profile' });
    return done(await sm.showProfile(), shots);
  }

  // Une fiche de la liste affichée (saint du jour, recherche, « N saints ici »)
  const ORD = { premier: 0, premiere: 0, '1er': 0, '1re': 0, deuxieme: 1, second: 1, seconde: 1, troisieme: 2, quatrieme: 3,
    cinquieme: 4, sixieme: 5, septieme: 6, huitieme: 7, neuvieme: 8, dixieme: 9, dernier: -1, derniere: -1 };
  if ((m = /\bouvre (?:le |la )?(premier|premiere|1er|1re|deuxieme|second|seconde|troisieme|quatrieme|cinquieme|sixieme|septieme|huitieme|neuvieme|dixieme|dernier|derniere|\d+)(?:e|eme)?\b/.exec(t))
      && sm.visibleList().length) {
    const index = m[1] in ORD ? ORD[m[1]] : parseInt(m[1], 10) - 1;
    const r = await sm.openFromList({ index });
    return done(r, [{ action: 'open_list_item', params: { name: sm.memory.saint, index } }]);
  }
  if ((m = /^(?:ouvre|touche|choisis|clique sur)\s+(.+)$/i.exec(clean)) && sm.visibleList().some((row) => fold(row.name).includes(fold(m[1].replace(/^(saint|sainte)\s+/i, ''))))) {
    const r = await sm.openFromList({ name: m[1].replace(/^(saint|sainte)\s+/i, '') });
    return done(r, [{ action: 'open_list_item', params: { name: sm.memory.saint } }]);
  }

  // Siècles, dates, recherche
  if (/\bsiecle\b/.test(t)) {
    const c = parseCentury(text);
    const iso = data.countriesIn(text)[0] || sm.memory.country;
    if (c) return done(await sm.century(c, iso), [{ action: 'century_filter', params: { century: c, country: iso } }]);
  }
  if (/\bcalendrier|saint du jour|fetes?\b/.test(t)) {
    m = /\b(\d{1,2}(?:er)?\s+\w+)/.exec(t);
    const day = /demain/.test(t) ? 'demain' : /hier/.test(t) ? 'hier' : m ? m[1] : "aujourd'hui";
    return done(await sm.feastDay(day), [{ action: 'calendar', params: { day } }]);
  }
  if ((m = /\bsaints? nes? (?:a|en|au|aux|dans) (?:la |le |les |l )?(.+)$/i.exec(fold(clean)))) {
    const q = clean.slice(clean.length - m[1].length);
    return run({ action: 'search_list', params: { query: q } });
  }
  if ((m = /(?:cherche|trouve|recherche)\s+(.+)$/i.exec(clean))) {
    const r = await sm.searchSaint(m[1]);
    return done(r, [{ action: 'open_saint', params: { query: sm.memory.saint || m[1] } }]);
  }

  // Caméra
  const strong = /\b(beaucoup|fort|bien plus|encore plus)\b/.test(t) ? 3 : 2;
  if (/\bzoom(e|er)? arriere|dezoom|recule\b|plus loin/.test(t)) return run({ action: 'zoom_out', params: { factor: strong } });
  if ((m = /(?:zoome?r?\s+(?:sur|vers))\s+(?:la |le |les |l')?(.+)$/i.exec(clean))) {
    const target = m[1]; const cid = data.continentId(target); const iso = data.findCountry(target);
    if (cid) return done(await sm.goContinent(cid), [{ action: 'open_continent', params: { continent: cid } }]);
    if (iso && !(await sm.locatePlace(target))?.kind?.startsWith('ville')) return done(await sm.goCountry(iso), [{ action: 'open_country', params: { country: iso } }]);
    const r = await sm.goPlace(target);
    return done(r, [{ action: 'zoom_to_place', params: { place: r.data?.name || target, country: r.data?.iso } }]);
  }
  if (/\bzoom(e|er)?\b|rapproche|plus pres/.test(t)) return run({ action: 'zoom_in', params: { factor: strong } });
  if ((m = /\b(nord|sud|est|ouest)\b/.exec(t)) && /\b(va|vers|deplace|glisse|regarde|au|a l')\b/.test(t)) {
    const direction = { nord: 'north', sud: 'south', est: 'east', ouest: 'west' }[m[1]];
    return run({ action: 'pan', params: { direction, fraction: strong === 3 ? 0.5 : 0.3 } });
  }
  if ((m = /(?:va|aller|allons|direction|montre(?:-moi)? les saints|emmene[- ]moi|passe)\s+(?:en|au|aux|a|à|dans|vers|de|du|d'|des|par)?\s*(?:la |le |les |l')?(.+)$/i.exec(clean))) {
    const target = m[1];
    const cid = data.continentId(target);
    if (cid) return done(await sm.goContinent(cid), [{ action: 'open_continent', params: { continent: cid } }]);
    const iso = data.findCountry(target);
    if (iso) return done(await sm.goCountry(iso), [{ action: 'open_country', params: { country: iso } }]);
    const r = await sm.goPlace(target);
    return done(r, [{ action: 'zoom_to_place', params: { place: r.data?.name || target, country: r.data?.iso } }]);
  }
  // Un nom seul : continent, pays ou lieu.
  if (data.continentId(clean)) return done(await sm.goContinent(data.continentId(clean)), [{ action: 'open_continent', params: { continent: data.continentId(clean) } }]);
  if (data.findCountry(clean)) { const iso = data.findCountry(clean); return done(await sm.goCountry(iso), [{ action: 'open_country', params: { country: iso } }]); }
  return done({ ok: false, toString: () => `✗ commande non comprise : « ${text} ». Voir « Toutes les commandes ».` });
}

async function runCommand(text) {
  if (busy || !text.trim()) return;
  setBusy(true);
  ui.cmdResult.replaceChildren();
  try {
    const { report, shots } = await command(text);
    log(`> ${text}\n${report}`);
    const line = document.createElement('p'); line.className = `res ${report.ok ? 'ok' : 'bad'}`;
    line.textContent = String(report);
    ui.cmdResult.append(line);
    if (report.ok && shots.length) {
      const add = document.createElement('button'); add.className = 'primary';
      add.textContent = `＋ Ajouter au scénario${shots.length > 1 ? ` (${shots.length} plans)` : ''}`;
      add.addEventListener('click', () => { addShots(shots.map((sh) => ({ ...sh, params: { ...(sh.params || {}) } }))); add.disabled = true; add.textContent = '✓ Ajouté au scénario'; });
      ui.cmdResult.append(add);
    }
  } catch (e) { log(`> ${text}\n✗ ${e.message}`); ui.cmdResult.textContent = `✗ ${e.message}`; }
  finally { setBusy(false); if (demo.on) { demo.committed = demoState(); demo.last = demo.committed; } }
}

// ------------------------------------------------ démonstration à la main

/**
 * « Montrer à la main » : on agit soi-même sur la carte (toucher un pays,
 * zoomer, ouvrir une croix, basculer en apparitions…). Le studio observe la page,
 * attend que la carte se pose après chaque geste, et traduit ce qui a changé en
 * commandes — qu'on ajoute au scénario d'un toucher.
 */
const demo = { on: false, committed: null, pending: [], last: null, stable: 0, pointer: false, timer: null };

function demoState() {
  const s = sm.snapshot();
  const q = (sel) => sm.q(sel);
  const daily = q('#panel.is-open .daily') ? (q('.daily__date')?.textContent || '').trim() : null;
  const century = q('#panel.is-open .search .chip--century')?.textContent.replace('×', '').trim() || null;
  return {
    mode: s.mode, trail: s.trail.join('›'), continent: s.trail[1] || null, country: s.trail[2] || null,
    corpus: s.corpus, fiche: s.ficheOpen ? s.ficheName : null, transform: s.transform,
    lieux: !!q('.detail__lieux-btn.is-on'), croises: !!q('.detail__croises-btn.is-on'), daily, century,
    pending: s.pending,
  };
}

async function demoDiff(a, b) {
  const shots = [];
  if (a.corpus !== b.corpus) shots.push({ action: b.corpus === 'apparitions' ? 'apparitions_on' : b.corpus === 'miracles' ? 'miracles_on' : 'apparitions_off' });
  if (a.trail !== b.trail) {
    if (b.mode === 'world') shots.push({ action: 'back_to_world' });
    else if (b.mode === 'continent') shots.push({ action: a.mode === 'country' ? 'level_up' : 'open_continent', params: { continent: data.continentId(b.continent) } });
    else if (b.mode === 'country') shots.push({ action: 'open_country', params: { country: data.findCountry(b.country) } });
    sm.baseK = b.transform?.[0] || sm.baseK;
  }
  if (a.fiche !== b.fiche) {
    if (b.fiche) shots.push({ action: 'open_saint', params: { query: b.fiche } }, { action: 'show_profile' });
    else if (a.fiche) shots.push({ action: 'close_profile' });
  }
  if (b.lieux && !a.lieux) shots.push({ action: 'show_lieux' });
  if (b.croises && !a.croises) shots.push({ action: 'show_croises' });
  if (b.century && b.century !== a.century) {
    const n = parseInt(b.century, 10);
    if (n) shots.push({ action: 'century_filter', params: { century: n, country: data.findCountry(b.country || '') || null } });
  }
  if (b.daily && b.daily !== a.daily) {
    const m = /(\d{1,2})(?:er)?\s+(\p{L}+)/u.exec(b.daily);
    if (m) shots.push({ action: 'calendar', params: { day: `${m[1]} ${m[2]}` } });
  }
  // Un zoom ou un déplacement à la main, au même niveau et sans autre changement.
  if (!shots.length && a.mode === b.mode && b.mode !== 'world' && a.transform && b.transform) {
    const zoom = Math.abs(Math.log(b.transform[0] / a.transform[0]));
    const g = sm.geometry();
    const moved = Math.hypot(b.transform[1] - a.transform[1], b.transform[2] - a.transform[2]) / Math.max(g.width, g.height);
    if (zoom > 0.15 || moved > 0.08) {
      const v = sm.view(); const iso = data.findCountry(b.country || '') || null;
      const near = await sm.nearestPlace(v.x, v.y, iso);
      shots.push({ action: 'frame_view', params: { x: Math.round(v.x), y: Math.round(v.y), ratio: +v.ratio.toFixed(2), country: iso, near } });
    }
  }
  return shots;
}

async function demoTick() {
  if (!demo.on || busy || !sm) return;
  const now = demoState();
  const same = demo.last && JSON.stringify(now.transform) === JSON.stringify(demo.last.transform) && now.trail === demo.last.trail && now.fiche === demo.last.fiche;
  demo.stable = same && !now.pending && !demo.pointer ? demo.stable + 1 : 0;
  demo.last = now;
  if (demo.stable < 3) return;          // ≈ 0,75 s d'immobilité
  const shots = await demoDiff(demo.committed, now);
  demo.committed = now;
  if (!shots.length) return;
  for (const shot of shots) { shot.params ||= {}; demo.pending.push(shot); }
  renderDemo();
}

function renderDemo() {
  ui.demoList.replaceChildren();
  const planner = new Planner(data, sm?.memory);
  demo.pending.forEach((shot, i) => {
    const li = document.createElement('li');
    li.innerHTML = '<span></span><button class="mini">＋ Ajouter</button><button class="mini del" aria-label="Ignorer">✕</button>';
    li.querySelector('span').textContent = planner.describe(shot);
    const [add, drop] = li.querySelectorAll('button');
    add.addEventListener('click', () => { addShots([shot]); demo.pending.splice(i, 1); renderDemo(); });
    drop.addEventListener('click', () => { demo.pending.splice(i, 1); renderDemo(); });
    ui.demoList.append(li);
  });
  ui.demoAll.hidden = demo.pending.length < 2;
  ui.demoEmpty.hidden = demo.pending.length > 0 || !demo.on;
}

function toggleDemo(on = !demo.on) {
  demo.on = on;
  ui.demo.textContent = on ? '■ Arrêter la démonstration' : '✋ Montrer à la main';
  ui.demo.classList.toggle('primary', on);
  ui.wrap.classList.toggle('is-demo', on);
  if (on) {
    demo.committed = demoState(); demo.last = demo.committed; demo.stable = 0;
    const D = iframe.contentDocument;
    if (!D.__smDemo) {
      D.__smDemo = true;
      D.addEventListener('pointerdown', (e) => { if (e.isTrusted) demo.pointer = true; }, true);
      for (const type of ['pointerup', 'pointercancel']) D.addEventListener(type, (e) => { if (e.isTrusted) demo.pointer = false; }, true);
    }
    demo.timer = setInterval(() => demoTick().catch((e) => log(`Démonstration : ${e.message}`)), 250);
    // Sur un téléphone, la carte est au-dessus des commandes : on la ramène sous le doigt.
    ui.wrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    log('Démonstration : agissez sur la carte, chaque action reconnue apparaît dans la liste.');
  } else {
    clearInterval(demo.timer);
  }
  renderDemo();
}

// ----------------------------------------------------------------- état

clock.listeners.add(() => {
  if (!sm || !iframe?.contentDocument?.querySelector('#map-host')) return;
  if (performance.now() - (ui.state._t || 0) < 300) return;
  ui.state._t = performance.now();
  try {
    const s = sm.state();
    ui.state.textContent = `État : ${s.label}${s.trail.length ? ' · ' + s.trail.join(' › ') : ''}`;
    const mem = sm.memory;
    ui.memory.textContent = [mem.country && data.countryName(mem.country), mem.place, mem.saint, mem.mode !== 'saints' && mem.mode]
      .filter(Boolean).join(' · ');
  } catch { /* page en transition */ }
});

// --------------------------------------------------------------- départ

ui.plan.addEventListener('click', async () => { if (busy) return; setBusy(true); try { await plan(); } finally { setBusy(false); } });
ui.shoot.addEventListener('click', renderVideo);
ui.capture.addEventListener('click', captureTab);
ui.capture.hidden = !canRecord();
ui.play.addEventListener('click', playOnly);
ui.stop.addEventListener('click', () => director?.stop());
ui.aspect.addEventListener('change', async () => { if (!busy) { setBusy(true); try { await loadStage(); if (scenario) scenario.aspect = ui.aspect.value; renderTimeline(); } finally { setBusy(false); } } });
ui.style.addEventListener('change', () => { if (scenario) { scenario.style = ui.style.value; renderTimeline(); } else save(); });
ui.demo.addEventListener('click', () => { if (sm) toggleDemo(); });
ui.demoAll.addEventListener('click', () => { addShots(demo.pending.splice(0)); renderDemo(); });
ui.addPause.addEventListener('click', () => addShots([{ action: 'hold' }]));
ui.clear.addEventListener('click', () => { if (!busy && confirm('Vider le scénario ?')) { scenario = null; renderTimeline(); } });
ui.request.addEventListener('input', save);
ui.cmdGo.addEventListener('click', () => runCommand(ui.cmd.value));
ui.cmd.addEventListener('keydown', (e) => { if (e.key === 'Enter') runCommand(ui.cmd.value); });
for (const b of document.querySelectorAll('[data-example]')) b.addEventListener('click', () => { ui.request.value = b.dataset.example; save(); });
for (const b of document.querySelectorAll('[data-cmd]')) b.addEventListener('click', () => { ui.cmd.value = b.dataset.cmd; runCommand(b.dataset.cmd); });
if (params.get('demande')) ui.request.value = params.get('demande');
// Sur un téléphone tenu droit, l'enregistrement d'écran d'iOS filme en portrait :
// le format vertical remplit l'écran.
if (params.get('format') && LOGICAL[params.get('format')]) ui.aspect.value = params.get('format');
else if (!canRecord() && innerHeight > innerWidth) ui.aspect.value = '9:16';

ui.recHint.textContent = canRender()
  ? 'La vidéo est fabriquée image par image sur cet appareil (30 images/s, MP4), puis proposée à l\'enregistrement. Comptez quelques minutes ; gardez la page ouverte pendant le rendu.'
  : 'Ce navigateur ne sait pas fabriquer de vidéo (iOS 16.4 ou plus récent requis) : le bouton passe en plein écran pour l\'enregistrement de l\'écran.';

restore();
(async () => {
  setBusy(true);
  try {
    await data.load();
    renderTimeline();
    await loadStage();
    log('SanctiMaps est prêt.');
  } catch (e) {
    overlay(`Impossible de charger SanctiMaps : ${e.message}`);
    log(`Échec du chargement : ${e.message}`);
  } finally { setBusy(false); }
})();

window.__studio = { get sm() { return sm; }, get director() { return director; }, get scenario() { return scenario; }, plan, data, command };
