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
  progressFill: $('#progress-fill'), progressText: $('#progress-text'),
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

function renderTimeline() {
  ui.timeline.replaceChildren();
  if (!scenario) return;
  let t = 0;
  for (const s of scenario.shots) {
    const li = document.createElement('li'); li.dataset.id = s.id;
    li.innerHTML = `<span class="t">${t.toFixed(1)}–${(t + s.duration).toFixed(1)} s</span><span></span><span class="st"></span>`;
    li.children[1].textContent = s.label;
    ui.timeline.append(li); t += s.duration;
  }
  ui.total.textContent = `${total(scenario).toFixed(0)} s · ${scenario.aspect} · ${STYLES[scenario.style].label}`;
  ui.notes.textContent = scenario.notes.join(' ');
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
    if (!scenario || scenario.request !== ui.request.value.trim()) await plan();
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
    if (!scenario || scenario.request !== ui.request.value.trim()) await plan();
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
    if (!scenario || scenario.request !== ui.request.value.trim()) await plan();
    if (scenario) await director.play(scenario);
  } catch (e) { log(`Échec : ${e.message}`); } finally { setBusy(false); }
}

// --------------------------------------------------------------- commandes

async function command(text) {
  const t = fold(text.replace('’', "'"));
  let m;
  if (/\b(vue (du )?monde|planisphere|reviens? au monde)\b/.test(t)) return sm.goWorld();
  if (/\b(mode apparitions?|passe (en|aux) apparitions?)\b/.test(t)) return sm.setCorpus('apparitions');
  if (/\b(mode saints|reviens? aux saints)\b/.test(t)) return sm.setCorpus('saints');
  if (/\bsiecle\b/.test(t)) { const c = parseCentury(text); if (c) return sm.century(c, sm.memory.country); }
  if (/\bcalendrier|saint du jour|fetes?\b/.test(t)) {
    m = /\b(\d{1,2}(?:er)?\s+\w+)/.exec(t);
    return sm.feastDay(/demain/.test(t) ? 'demain' : m ? m[1] : "aujourd'hui");
  }
  if ((m = /(?:cherche|trouve|recherche)\s+(.+)$/i.exec(text.trim().replace(/[.!?]$/, '')))) return sm.searchSaint(m[1]);
  if (/\b(ferme|referme)\b.*\bfiche\b/.test(t)) return sm.closeProfile();
  if (/\b(sa|la|cette) fiche\b/.test(t)) {
    if (sm.snapshot().ficheOpen) return sm.showProfile();
    if (sm.memory.saint) { await sm.openSaint(sm.memory.saint); return sm.showProfile(); }
    return sm.openNearestMarker();
  }
  if (/\bzoom(e|er)? arriere|dezoom|recule\b/.test(t)) return director.run({ action: 'zoom_out', params: { factor: 2 } });
  if ((m = /(?:zoome?r?\s+(?:sur|vers))\s+(?:la |le |les |l')?(.+)$/i.exec(text.trim().replace(/[.!?]$/, '')))) return sm.goPlace(m[1]);
  if (/\bzoom(e|er)?\b|rapproche/.test(t)) return director.run({ action: 'zoom_in', params: { factor: 2 } });
  if ((m = /\b(nord|sud|est|ouest)\b$/.exec(t))) {
    const r = await sm.pan({ nord: 'north', sud: 'south', est: 'east', ouest: 'west' }[m[1]]);
    return { ok: r.ok, toString: () => `${r.ok ? '✓' : '✗'} déplacement vers le ${m[1]}` };
  }
  if ((m = /(?:va|aller|allons|direction|montre(?:-moi)? les saints)\s+(?:en|au|aux|a|à|dans|vers|de|du|d'|des)?\s*(?:la |le |les |l')?(.+)$/i.exec(text.trim().replace(/[.!?]$/, '')))) {
    const target = m[1];
    const cid = data.continentId(target);
    if (cid) return sm.goContinent(cid);
    if (data.findCountry(target)) return sm.goCountry(target);
    return sm.goPlace(target);
  }
  return { ok: false, toString: () => `✗ commande non comprise : « ${text} »` };
}

async function runCommand(text) {
  if (busy || !text.trim()) return;
  setBusy(true);
  try { const r = await command(text); log(`> ${text}\n${r}`); } catch (e) { log(`> ${text}\n✗ ${e.message}`); }
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
ui.aspect.addEventListener('change', async () => { if (!busy) { setBusy(true); try { await loadStage(); if (scenario) scenario.aspect = ui.aspect.value, renderTimeline(); } finally { setBusy(false); } } });
ui.style.addEventListener('change', () => { if (scenario) { scenario.style = ui.style.value; renderTimeline(); } });
ui.cmdGo.addEventListener('click', () => runCommand(ui.cmd.value));
ui.cmd.addEventListener('keydown', (e) => { if (e.key === 'Enter') runCommand(ui.cmd.value); });
for (const b of document.querySelectorAll('[data-example]')) b.addEventListener('click', () => { ui.request.value = b.dataset.example; scenario = null; });
for (const b of document.querySelectorAll('[data-cmd]')) b.addEventListener('click', () => { ui.cmd.value = b.dataset.cmd; runCommand(b.dataset.cmd); });
if (params.get('demande')) ui.request.value = params.get('demande');
// Sur un téléphone tenu droit, l'enregistrement d'écran d'iOS filme en portrait :
// le format vertical remplit l'écran.
if (params.get('format') && LOGICAL[params.get('format')]) ui.aspect.value = params.get('format');
else if (!canRecord() && innerHeight > innerWidth) ui.aspect.value = '9:16';

ui.recHint.textContent = canRender()
  ? 'La vidéo est fabriquée image par image sur cet appareil (30 images/s, MP4), puis proposée à l\'enregistrement. Comptez quelques minutes ; gardez la page ouverte pendant le rendu.'
  : 'Ce navigateur ne sait pas fabriquer de vidéo (iOS 16.4 ou plus récent requis) : le bouton passe en plein écran pour l\'enregistrement de l\'écran.';

(async () => {
  setBusy(true);
  try {
    await data.load();
    await loadStage();
    log('SanctiMaps est prêt.');
  } catch (e) {
    overlay(`Impossible de charger SanctiMaps : ${e.message}`);
    log(`Échec du chargement : ${e.message}`);
  } finally { setBusy(false); }
})();

window.__studio = { get sm() { return sm; }, get director() { return director; }, get scenario() { return scenario; }, plan, data, command };
