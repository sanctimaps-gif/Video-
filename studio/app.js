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
  background: $('#background'), bgResult: $('#bg-result'), addPause: $('#add-pause'), clear: $('#clear'),
};

const clock = new Clock();
const data = new SiteData(SRC);
let sm = null, director = null, scenario = null, busy = false, iframe = null;

function log(line) { ui.log.textContent += line + '\n'; ui.log.scrollTop = ui.log.scrollHeight; }
function overlay(html) { ui.overlay.innerHTML = html || ''; ui.overlay.classList.toggle('on', !!html); }
function setBusy(b) {
  busy = b;
  for (const el of [ui.plan, ui.shoot, ui.play, ui.cmdGo, ui.capture, ui.background]) el.disabled = b;
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
      duration: +(natural / (scenario.speed || 1) + (shot.action === 'show_profile' ? 2 : 1)).toFixed(1),
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
 */
async function command(text) {
  const t = fold(text.replace('’', "'"));
  const clean = text.trim().replace(/[.!?]$/, '');
  let m;
  const done = (report, shots = []) => ({ report, shots });
  if (/\b(vue (du )?monde|planisphere|reviens? au monde|^monde$)\b/.test(t)) return done(await sm.goWorld(), [{ action: 'back_to_world' }]);
  if (/\b(mode apparitions?|passe (en|aux) apparitions?|^apparitions?$)\b/.test(t)) return done(await sm.setCorpus('apparitions'), [{ action: 'apparitions_on' }]);
  if (/\b(mode saints|reviens? aux saints)\b/.test(t)) return done(await sm.setCorpus('saints'), [{ action: 'apparitions_off' }]);
  if (/\bsiecle\b/.test(t)) {
    const c = parseCentury(text);
    if (c) return done(await sm.century(c, sm.memory.country), [{ action: 'century_filter', params: { century: c, country: sm.memory.country } }]);
  }
  if (/\bcalendrier|saint du jour|fetes?\b/.test(t)) {
    m = /\b(\d{1,2}(?:er)?\s+\w+)/.exec(t);
    const day = /demain/.test(t) ? 'demain' : m ? m[1] : "aujourd'hui";
    return done(await sm.feastDay(day), [{ action: 'calendar', params: { day } }]);
  }
  if ((m = /(?:cherche|trouve|recherche)\s+(.+)$/i.exec(clean))) {
    const r = await sm.searchSaint(m[1]);
    return done(r, [{ action: 'open_saint', params: { query: sm.memory.saint || m[1] } }]);
  }
  if (/\b(ferme|referme)\b.*\bfiche\b/.test(t)) return done(await sm.closeProfile(), [{ action: 'close_profile' }]);
  if (/\b(sa|la|cette) fiche\b|lis la fiche/.test(t)) {
    const shots = [];
    if (!sm.snapshot().ficheOpen) {
      const r = sm.memory.saint ? await sm.openSaint(sm.memory.saint) : await sm.openNearestMarker();
      if (!r.ok) return done(r);
      shots.push({ action: 'open_saint', params: { query: sm.memory.saint } });
    }
    shots.push({ action: 'show_profile' });
    return done(await sm.showProfile(), shots);
  }
  if (/\bzoom(e|er)? arriere|dezoom|recule\b/.test(t)) return done(await director.run({ action: 'zoom_out', params: { factor: 2 } }), [{ action: 'zoom_out', params: { factor: 2 } }]);
  if ((m = /(?:zoome?r?\s+(?:sur|vers))\s+(?:la |le |les |l')?(.+)$/i.exec(clean))) {
    const r = await sm.goPlace(m[1]);
    return done(r, [{ action: 'zoom_to_place', params: { place: r.data?.name || m[1], country: r.data?.iso } }]);
  }
  if (/\bzoom(e|er)?\b|rapproche/.test(t)) return done(await director.run({ action: 'zoom_in', params: { factor: 2 } }), [{ action: 'zoom_in', params: { factor: 2 } }]);
  if ((m = /\b(nord|sud|est|ouest)\b$/.exec(t))) {
    const direction = { nord: 'north', sud: 'south', est: 'east', ouest: 'west' }[m[1]];
    return done(await director.run({ action: 'pan', params: { direction } }), [{ action: 'pan', params: { direction } }]);
  }
  if ((m = /(?:va|aller|allons|direction|montre(?:-moi)? les saints)\s+(?:en|au|aux|a|à|dans|vers|de|du|d'|des)?\s*(?:la |le |les |l')?(.+)$/i.exec(clean))) {
    const target = m[1];
    const cid = data.continentId(target);
    if (cid) return done(await sm.goContinent(cid), [{ action: 'open_continent', params: { continent: cid } }]);
    const iso = data.findCountry(target);
    if (iso) return done(await sm.goCountry(iso), [{ action: 'open_country', params: { country: iso } }]);
    const r = await sm.goPlace(target);
    return done(r, [{ action: 'zoom_to_place', params: { place: r.data?.name || target, country: r.data?.iso } }]);
  }
  return done({ ok: false, toString: () => `✗ commande non comprise : « ${text} »` });
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
      add.addEventListener('click', () => { addShots(shots.map((s) => ({ ...s, params: { ...(s.params || {}) } }))); add.disabled = true; add.textContent = '✓ Ajouté au scénario'; });
      ui.cmdResult.append(add);
    }
  } catch (e) { log(`> ${text}\n✗ ${e.message}`); ui.cmdResult.textContent = `✗ ${e.message}`; }
  finally { setBusy(false); }
}

// ------------------------------------------------- rendu en arrière-plan

const REPO = (() => {
  const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : 'sanctimaps-gif';
  const repo = location.hostname.endsWith('.github.io') ? (location.pathname.split('/')[1] || 'Video-') : 'Video-';
  return `${owner}/${repo}`;
})();

/**
 * Le rendu tourne sur GitHub (Actions), pas sur le téléphone : on peut fermer
 * la page. Le studio prépare une demande (issue) ; GitHub répond dans cette
 * demande avec le lien de la vidéo, et envoie une notification.
 */
async function renderInBackground() {
  if (busy) return;
  setBusy(true);
  try {
    if (!scenario?.shots?.length) await plan();
    if (!scenario?.shots?.length) return;
    // Les choix laissés ouverts (« une fiche intéressante », « plusieurs zones »)
    // sont fixés ici, pour que le serveur tourne exactement ce qui a été préparé.
    for (const shot of scenario.shots) await director.resolve(shot);
    renderTimeline();
    const payload = { request: scenario.request, title: scenario.title || 'SanctiMaps', style: scenario.style,
      speed: scenario.speed || 1, aspect: scenario.aspect,
      shots: scenario.shots.map(({ id, action, params, duration, label }) => ({ id, action, params, duration, label })) };
    const title = `[vidéo] ${payload.title}`.slice(0, 120);
    const body = `Demande de rendu envoyée par le studio. Touchez « Submit new issue » (ou « Créer ») : la vidéo sera tournée sur GitHub, et le lien arrivera ici en commentaire.\n\n` +
      `Durée : ${total(scenario).toFixed(0)} s · format ${scenario.aspect} · ${scenario.shots.length} plans\n\n` +
      scenario.shots.map((s, i) => `${i + 1}. ${s.label} (${s.duration} s)`).join('\n') +
      `\n\n\`\`\`json\n${JSON.stringify(payload)}\n\`\`\`\n`;
    const url = `https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    ui.bgResult.innerHTML = `<p>1. Ouvrez la demande ci-dessous et validez-la sur GitHub.<br>2. Vous pouvez ensuite fermer cette page : la vidéo est tournée sur GitHub (5 à 15 min) et le lien arrive en notification.</p>
      <div class="actions"><a class="go" target="_blank" rel="noopener"><button class="primary">Ouvrir la demande sur GitHub</button></a>
      <a href="https://github.com/${REPO}/releases" target="_blank" rel="noopener"><button>Mes vidéos</button></a></div>`;
    ui.bgResult.querySelector('a.go').href = url;
    ui.bgResult.hidden = false;
    const w = window.open(url, '_blank', 'noopener');
    if (!w) log('Touchez « Ouvrir la demande sur GitHub » pour continuer.');
  } catch (e) { log(`Échec : ${e.message}`); }
  finally { setBusy(false); }
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
ui.background.addEventListener('click', renderInBackground);
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
