import { Clock, DRY, SanctiMaps, SiteData, fold } from './sanctimaps.js';
import { KeepAlive } from './keepalive.js';
import { Library, fileName } from './library.js';
import { Planner, STYLES, parseCentury, total } from './planner.js';
import { Director } from './director.js';
import { StageRecorder, canRecord } from './recorder.js';
import { FrameRenderer, canRender, encodeJob } from './render.js';

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
  resume: $('#resume'), resumeText: $('#resume-text'), resumeLog: $('#resume-log'), resumeGo: $('#resume-go'), resumeDrop: $('#resume-drop'),
  addPause: $('#add-pause'), clear: $('#clear'), library: $('#library'), libList: $('#library-list'), libUsage: $('#library-usage'),
  demo: $('#demo'), demoList: $('#demo-list'), demoAll: $('#demo-all'), demoEmpty: $('#demo-empty'),
};

const clock = new Clock();
const keepAlive = new KeepAlive();
const library = new Library();
const data = new SiteData(SRC);
let sm = null, director = null, scenario = null, busy = false, iframe = null;

// Le journal est aussi gardé sur l'appareil : si le téléphone ferme la page
// pendant un rendu, on retrouve au retour ce qui s'est passé juste avant.
const JOURNAL = 'sanctimaps-studio.journal';
const previousJournal = (() => { try { return JSON.parse(localStorage.getItem(JOURNAL) || '[]'); } catch { return []; } })();
let journal = [];
function log(line) {
  ui.log.textContent += line + '\n'; ui.log.scrollTop = ui.log.scrollHeight;
  const d = new Date();
  journal.push(`${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')} ${line}`);
  if (journal.length > 120) journal = journal.slice(-120);
  try { localStorage.setItem(JOURNAL, JSON.stringify(journal)); } catch { /* sans stockage */ }
}
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
  iframe.src = `studio/frame.html?vt=1&src=${encodeURIComponent(SRC)}`;
  ui.stage.append(iframe);
  layout();
  await new Promise((r) => iframe.addEventListener('load', r, { once: true }));
  // Le studio tient l'horloge des animations dès le chargement (voir frame.html).
  clock.attach(iframe.contentWindow);
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
  scenario.title = text.split(/[.:]/)[0].trim().slice(0, 80);
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
      if (out) out.seconds = total(scenario);
      document.body.classList.remove('shooting'); layout();
      if (!out || out.blob.size < 20000) throw new Error(`enregistrement vide (${recorder.mime || 'format inconnu'}) : essayez Chrome ou Edge à jour`);
      await showResult(out);
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

function untilVisible() {
  return new Promise((resolve) => {
    if (!document.hidden) return resolve();
    const on = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', on); resolve(); } };
    document.addEventListener('visibilitychange', on);
  });
}

/**
 * Fabriquer la vidéo, image par image, sur l'appareil.
 *
 * Chaque image est rangée aussitôt dans la base de l'appareil, avec l'avancement
 * (un « rendu en cours »). Si iOS met la page en pause, le rendu repart tout
 * seul au retour ; s'il ferme la page, le studio propose au retour de reprendre
 * là où il s'était arrêté. ``resume`` est un rendu interrompu à poursuivre.
 */
async function renderVideo(resume = null) {
  if (busy) return;
  if (!canRender()) {
    log("Ce navigateur ne sait pas fabriquer la vidéo (WebCodecs absent : iOS 16.4 ou plus récent requis). Passage en mode plein écran.");
    return captureTab();
  }
  // Tout de suite, dans le toucher : le son qui garde la page éveillée en arrière-plan.
  keepAlive.start(`SanctiMaps — ${(resume?.title || scenario?.title || ui.request.value || 'vidéo').slice(0, 40)}`);
  setBusy(true);
  ui.resume.hidden = true;
  let renderer = null, wakeLock = null, job = resume;
  try {
    try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* pas de verrou : tant pis */ }
    if (job) {
      // Le scénario exact du rendu interrompu (déjà vérifié par la répétition).
      scenario = JSON.parse(JSON.stringify(job.scenario));
      ui.aspect.value = job.aspect; ui.style.value = scenario.style || ui.style.value;
      renderTimeline(); layout();
    } else {
      if (!scenario?.shots?.length) await plan();
      if (!scenario) return;
      // Le rendu est noté sur l'appareil dès le toucher : quoi qu'il arrive
      // ensuite (page quittée, fermée par iOS), il pourra être repris.
      job = { id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`, created: Date.now(), updated: Date.now(),
        title: (scenario.title || ui.request.value.split(/[.:]/)[0]).trim().slice(0, 80) || 'Vidéo SanctiMaps',
        scenario: JSON.parse(JSON.stringify(scenario)), aspect: ui.aspect.value, fps: 30,
        framesDone: 0, expected: total(scenario), thumb: null, status: 'preparing' };
      await library.saveJob(job);
      log(`Rendu lancé : « ${job.title} » (${job.expected.toFixed(0)} s, ${job.aspect}).`);
    }
    if (job.status !== 'encoding') {
      // Répétition et chargement au pas à pas, eux aussi : rien ne dépend de l'écran.
      clock.beginRender(DRY, 30);
      if (job.status === 'preparing') {
        keepAlive.update('vérification du scénario', true);
        if (!(await rehearse())) { log('Aucun plan réalisable.'); await library.dropJob(job.id).catch(() => {}); job = null; return; }
        job.scenario = JSON.parse(JSON.stringify(scenario));
      }
      await loadStage();
      for (const s of scenario.shots) markShot(s.id, null, null);
      const [w, h] = OUTPUT[ui.aspect.value];
      const expected = total(scenario);
      if (job.status === 'preparing') {
        Object.assign(job, { width: w, height: h, expected, framesDone: 0, thumbAt: Math.round(expected * 30 * 0.4), status: 'rendering', updated: Date.now() });
        await library.saveJob(job);
      } else log(`Reprise du rendu à ${(job.framesDone / 30).toFixed(1)} s : l'agent rejoue sans filmer jusque-là.`);
      renderer = new FrameRenderer(iframe, { width: w, height: h, fps: 30, skip: job.framesDone, thumbAt: job.thumb ? -1 : job.thumbAt,
        store: async (batch, thumb, done) => {
          job.framesDone = done; job.updated = Date.now();
          if (thumb) job.thumb = thumb;
          try { await library.putFrames(job, batch); } catch (e) {
            throw new Error(e?.name === 'QuotaExceededError' ? "plus de place sur l'appareil pour les images de la vidéo" : `images non rangées (${e?.message})`);
          }
        } });
      await renderer.start();
      ui.progress.hidden = false;
      let lastBeat = Date.now();
      const onFrame = () => {
        const now = Date.now();
        // Page suspendue par le téléphone ? On le dit au retour : le rendu, lui, repart.
        if (now - lastBeat > 20000) log(`Rendu en pause ${Math.round((now - lastBeat) / 1000)} s (page suspendue par le téléphone) : il reprend là où il était.`);
        lastBeat = now;
        const t = renderer.frames / 30;
        const pct = Math.min(100, (t / expected) * 100);
        ui.progressFill.style.width = `${pct}%`;
        ui.progressText.textContent = renderer.frames < renderer.skip ? `Reprise ${t.toFixed(1)} / ${(renderer.skip / 30).toFixed(0)} s` : `Rendu ${t.toFixed(1)} / ${expected.toFixed(0)} s`;
        keepAlive.update(`${Math.floor(pct)} % — ${t.toFixed(0)} / ${expected.toFixed(0)} s`);
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
      const done = await renderer.finish();
      job.frames = done.frames; job.framesDone = done.frames; job.status = 'encoding'; job.updated = Date.now();
      if (done.thumb && !job.thumb) job.thumb = done.thumb;
      await library.saveJob(job);
      log(`Images rendues : ${(done.frames / 30).toFixed(1)} s, ${w}×${h}, en ${((performance.now() - started) / 1000).toFixed(0)} s de calcul (carte ${done.stats.mapMs.toFixed(0)} ms/image, interface ${done.stats.overlayRenders}× ${done.stats.overlayMs.toFixed(0)} ms, ${(done.bytes / 1e6).toFixed(0)} Mo d'images).`);
    }
    const out = await assemble(job);
    out.thumb = job.thumb;
    const saved = await showResult(out, job);
    if (saved) await library.dropJob(job.id);
    await keepAlive.finish(saved ? 'Vidéo prête — rangée dans la bibliothèque' : 'Vidéo prête — à enregistrer dans Safari');
  } catch (e) {
    renderer?.abort(); clock.endRender();
    log(`Échec : ${e.message}`); overlay('');
    keepAlive.update('échec du rendu', true); keepAlive.stop();
    if (job) await offerResume();
  } finally {
    clock.endRender();
    keepAlive.stop();
    wakeLock?.release().catch(() => {});
    ui.progress.hidden = true;
    setBusy(false);
  }
}

/**
 * Le MP4, à partir des images rangées. Si l'encodeur vidéo est refusé pendant
 * que la page est en arrière-plan, l'assemblage se fait au retour dans Safari.
 */
async function assemble(job) {
  ui.progress.hidden = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const t0 = performance.now();
      const out = await encodeJob(library, job, (i, n) => {
        const pct = Math.round((i / n) * 100);
        ui.progressFill.style.width = `${pct}%`;
        ui.progressText.textContent = `Assemblage du MP4 ${pct} %`;
        keepAlive.update(`assemblage du MP4 — ${pct} %`);
      });
      log(`MP4 assemblé : ${out.seconds.toFixed(1)} s, ${out.codec === 'avc' ? 'H.264' : 'VP9'}, ${(out.blob.size / 1e6).toFixed(1)} Mo, en ${((performance.now() - t0) / 1000).toFixed(0)} s.`);
      return out;
    } catch (e) {
      if (attempt >= 3) throw e;
      if (document.hidden) {
        log(`Assemblage interrompu en arrière-plan (${e.message}) : il reprendra au retour dans Safari.`);
        keepAlive.update('revenez dans Safari pour terminer', true);
        await untilVisible();
      } else await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Au démarrage (ou après un échec) : proposer de finir un rendu interrompu. */
async function offerResume() {
  let jobs = [];
  try { jobs = (await library.jobs()).sort((a, b) => b.updated - a.updated); } catch { return; }
  // Un seul rendu à la fois : les plus anciens sont abandonnés.
  for (const old of jobs.slice(1)) await library.dropJob(old.id).catch(() => {});
  const job = jobs[0];
  if (!job) { ui.resume.hidden = true; return; }
  const pct = Math.min(100, Math.round((job.framesDone / 30 / job.expected) * 100));
  ui.resumeText.textContent = job.status === 'encoding'
    ? `« ${job.title} » : toutes les images sont prêtes, il reste à assembler le MP4.`
    : job.status === 'preparing' || !job.framesDone
      ? `« ${job.title} » a été arrêté pendant la préparation, avant la première image. Le scénario est gardé : le rendu repart du début.`
      : `« ${job.title} » s'est arrêté à ${pct} % (${(job.framesDone / 30).toFixed(0)} s sur ${job.expected.toFixed(0)}). Les images déjà faites sont gardées : le rendu reprend là où il s'était arrêté.`;
  ui.resume.hidden = false;
  ui.resume.dataset.id = job.id;
}

ui.resumeGo.addEventListener('click', async () => {
  if (ui.resumeGo.disabled) return;
  // Le son qui garde la page éveillée doit partir dans ce toucher, même si la
  // carte est encore en train de charger : le rendu démarre dès qu'elle est prête.
  keepAlive.start('SanctiMaps — reprise du rendu');
  ui.resumeGo.disabled = true; ui.resumeGo.textContent = 'Chargement de la carte…';
  try {
    await stageReady;
    while (busy) await new Promise((r) => setTimeout(r, 200));
    const job = (await library.jobs()).find((j) => j.id === ui.resume.dataset.id);
    if (job) renderVideo(job); else ui.resume.hidden = true;
  } finally { ui.resumeGo.disabled = false; ui.resumeGo.textContent = 'Reprendre le rendu'; }
});
ui.resumeDrop.addEventListener('click', async () => {
  if (busy) return;
  await library.dropJob(ui.resume.dataset.id).catch(() => {});
  ui.resume.hidden = true;
  log('Rendu interrompu abandonné.');
});

// Ce que le téléphone fait de la page pendant un rendu, noté dans le journal.
for (const [target, type, text] of [[window, 'pagehide', 'Safari quitte la page'], [window, 'pageshow', 'Safari rouvre la page'],
  [document, 'freeze', 'Safari gèle la page'], [document, 'resume', 'Safari dégèle la page']]) {
  target.addEventListener(type, () => { if (busy) log(`${text} (${ui.progressText.textContent || 'préparation'}).`); });
}

// En arrière-plan, le journal dit où en est le rendu à chaque aller-retour.
document.addEventListener('visibilitychange', () => {
  if (!busy || !keepAlive.active) return;
  if (!document.hidden) keepAlive.resume();
  log(document.hidden ? 'Page en arrière-plan : le rendu continue.' : `De retour : ${ui.progressText.textContent || 'rendu en cours'}.`);
});

/**
 * Une vidéo terminée va directement dans la bibliothèque : enregistrée tout de
 * suite (même page en arrière-plan), puis signalée en tête de liste. Si la
 * bibliothèque refuse (plus de place), on montre la vidéo pour l'enregistrer.
 */
let newestId = null;
async function showResult(out, job = null) {
  let item = null, lastError = null;
  const thumb = out.thumb || await thumbFromVideo(out.blob);
  for (let i = 0; i < 3 && !item; i++) {
    try {
      item = await library.add({ blob: out.blob, thumb, title: job?.title || (scenario?.title || ui.request.value.split(/[.:]/)[0]).trim().slice(0, 80) || 'Vidéo SanctiMaps',
        seconds: out.seconds, aspect: job?.aspect || ui.aspect.value, codec: out.codec, ext: out.ext, scenario: job?.scenario || scenario });
    } catch (e) { lastError = e; await new Promise((r) => setTimeout(r, 500)); }
  }
  if (!item) {
    log(`La vidéo n'a pas pu être rangée dans la bibliothèque (${lastError?.message}) : enregistrez-la maintenant.`);
    playItem({ id: null, blob: out.blob, ext: out.ext, title: 'Vidéo SanctiMaps', created: Date.now(), size: out.blob.size });
    return null;
  }
  newestId = item.id;
  log(`Vidéo rangée dans la bibliothèque : « ${item.title} ».`);
  await renderLibrary();
  revealNewest();
  return item;
}

/** Montre la dernière vidéo en tête de bibliothèque — tout de suite, ou au retour dans Safari. */
function revealNewest() {
  if (!newestId) return;
  if (document.hidden) { document.addEventListener('visibilitychange', revealNewest, { once: true }); return; }
  const li = ui.libList.querySelector(`[data-id="${newestId}"]`);
  (li || ui.library).scrollIntoView({ behavior: 'smooth', block: 'center' });
  li?.classList.add('is-flash');
  setTimeout(() => li?.classList.remove('is-flash'), 2500);
}

/** Lecteur et boutons d'une vidéo de la bibliothèque. */
function playItem(item) {
  const url = URL.createObjectURL(item.blob);
  const name = fileName(item);
  const file = new File([item.blob], name, { type: item.blob.type || 'video/mp4' });
  const shareable = !!navigator.canShare?.({ files: [file] });
  ui.result.innerHTML = `<h2></h2><video controls playsinline></video>
    <div class="actions">
      ${shareable ? '<button class="primary share">Enregistrer / partager</button>' : ''}
      <a class="dl" download="${name}"><button class="${shareable ? '' : 'primary'}">Télécharger (${(item.ext || 'mp4').toUpperCase()}, ${(item.blob.size / 1e6).toFixed(1)} Mo)</button></a>
    </div>
    <p class="hint">${shareable ? 'Sur iPhone : « Enregistrer / partager » puis « Enregistrer la vidéo » pour la mettre dans Photos.' : ''}</p>`;
  ui.result.querySelector('h2').textContent = item.title || 'Vidéo';
  ui.result.querySelector('video').src = url;
  ui.result.querySelector('a.dl').href = url;
  ui.result.querySelector('.share')?.addEventListener('click', () => navigator.share({ files: [file], title: item.title || 'SanctiMaps' }).catch(() => {}));
  ui.result.hidden = false;
  ui.result.scrollIntoView({ behavior: 'smooth' });
}

/** Vignette tirée de la vidéo elle-même (enregistrements de l'onglet). */
async function thumbFromVideo(blob) {
  try {
    const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.src = URL.createObjectURL(blob);
    await new Promise((r, j) => { v.onloadeddata = r; v.onerror = j; setTimeout(j, 5000); });
    v.currentTime = Math.min(2, (v.duration || 4) * 0.4);
    await new Promise((r) => { v.onseeked = r; setTimeout(r, 3000); });
    const c = document.createElement('canvas'); c.width = 360; c.height = Math.round(360 * (v.videoHeight || 9) / (v.videoWidth || 16));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    URL.revokeObjectURL(v.src);
    return await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
  } catch { return null; }
}

const thumbs = new Map();
function thumbUrl(item) {
  if (!item.thumb) return '';
  if (!thumbs.has(item.id)) thumbs.set(item.id, URL.createObjectURL(item.thumb));
  return thumbs.get(item.id);
}

/** La bibliothèque : toutes les vidéos de l'appareil, des plus récentes aux plus anciennes. */
async function renderLibrary() {
  let items = [];
  try { items = await library.list(); } catch (e) { ui.libUsage.textContent = `Bibliothèque indisponible (${e.message}).`; return; }
  const { persisted, used, quota } = await library.usage();
  const total = items.reduce((a, it) => a + (it.size || 0), 0);
  ui.libUsage.textContent = items.length
    ? `${items.length} vidéo${items.length > 1 ? 's' : ''} · ${(total / 1e6).toFixed(0)} Mo sur cet appareil`
      + (quota ? ` (place disponible : ${((quota - (used || 0)) / 1e9).toFixed(1)} Go)` : '')
      + (persisted ? ' · conservation garantie' : '')
    : 'Aucune vidéo pour l’instant : chaque vidéo enregistrée viendra se ranger ici.';
  ui.libList.replaceChildren();
  for (const item of items) {
    const li = document.createElement('li'); li.className = `lib-item${item.id === newestId ? ' is-new' : ''}`; li.dataset.id = item.id;
    const d = new Date(item.created);
    li.innerHTML = `<button class="lib-thumb" aria-label="Lire"><img alt=""><span class="lib-dur"></span></button>
      <div class="lib-info"><p class="lib-title"></p><p class="lib-meta"></p>
        <div class="lib-actions">
          <button class="mini" data-do="play">▶ Lire</button>
          <button class="mini primary" data-do="share">Enregistrer / partager</button>
          <button class="mini" data-do="rename">Renommer</button>
          ${item.scenario ? '<button class="mini" data-do="reuse">Reprendre le scénario</button>' : ''}
          <button class="mini del" data-do="delete">Supprimer</button>
        </div></div>`;
    const img = li.querySelector('img');
    if (item.thumb) img.src = thumbUrl(item); else img.remove();
    li.querySelector('.lib-thumb').classList.add(`is-${(item.aspect || '16:9').replace(':', 'x')}`);
    li.querySelector('.lib-dur').textContent = `${Math.round(item.seconds || 0)} s`;
    li.querySelector('.lib-title').textContent = item.title;
    if (item.id === newestId) li.querySelector('.lib-title').insertAdjacentHTML('afterbegin', '<span class="lib-new">Nouvelle</span> ');
    li.querySelector('.lib-meta').textContent = `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${item.aspect || ''} · ${((item.size || 0) / 1e6).toFixed(1)} Mo`;
    li.addEventListener('click', async (e) => {
      const what = e.target.closest('[data-do]')?.dataset.do || (e.target.closest('.lib-thumb') ? 'play' : null);
      if (!what) return;
      if (what === 'play') playItem(await library.get(item.id));
      if (what === 'share') {
        const full = await library.get(item.id);
        const file = new File([full.blob], fileName(full), { type: full.blob.type || 'video/mp4' });
        if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file], title: full.title }).catch(() => {});
        else { const a = document.createElement('a'); a.href = URL.createObjectURL(full.blob); a.download = fileName(full); a.click(); }
      }
      if (what === 'rename') {
        const title = prompt('Nouveau titre', item.title);
        if (title && title.trim()) { await library.rename(item.id, title.trim()); renderLibrary(); }
      }
      if (what === 'reuse' && !busy) {
        scenario = JSON.parse(JSON.stringify(item.scenario));
        if (scenario.aspect && scenario.aspect !== ui.aspect.value) { ui.aspect.value = scenario.aspect; setBusy(true); try { await loadStage(); } finally { setBusy(false); } }
        if (scenario.request) ui.request.value = scenario.request;
        renderTimeline();
        log(`Scénario de « ${item.title} » repris : modifiez-le puis enregistrez une nouvelle vidéo.`);
        ui.timeline.scrollIntoView({ behavior: 'smooth' });
      }
      if (what === 'delete' && confirm(`Supprimer « ${item.title} » de la bibliothèque ?`)) {
        await library.remove(item.id);
        if (thumbs.has(item.id)) { URL.revokeObjectURL(thumbs.get(item.id)); thumbs.delete(item.id); }
        renderLibrary();
      }
    });
    ui.libList.append(li);
  }
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

  const runAll = async (shots) => {
    let last = null;
    for (const shot of shots) { last = await director.run({ params: {}, ...shot }); if (!last.ok) return done(last); }
    return done(last, shots);
  };
  const press = (label, extra = {}) => ({ action: 'press', params: { label, ...extra } });
  const pressAt = (selector, index, what) => ({ action: 'press', params: { selector, index, what } });
  const ordinal = (txt) => {
    const O = { premier: 0, premiere: 0, '1er': 0, '1re': 0, deuxieme: 1, second: 1, seconde: 1, troisieme: 2, quatrieme: 3,
      cinquieme: 4, sixieme: 5, septieme: 6, huitieme: 7, dernier: -1, derniere: -1 };
    const w = /\b(premier|premiere|1er|1re|deuxieme|second|seconde|troisieme|quatrieme|cinquieme|sixieme|septieme|huitieme|dernier|derniere|\d+)(?:e|eme)?\b/.exec(txt);
    return w ? (w[1] in O ? O[w[1]] : parseInt(w[1], 10) - 1) : 0;
  };
  const NOTO = [['tres connus', 'Très connus'], ['moins connus', 'Moins connus'], ['peu connus', 'Peu connus'], ['inconnus', 'Inconnus']];
  const notoriety = () => NOTO.find(([k]) => t.includes(k))?.[1];

  // ------------------------------------------------ onglets, paramètres
  if (/\b(ouvre|affiche|montre|va dans) (le |les |l )?(menu|sommaire)\b/.test(t)) return run({ action: 'open_tab', params: { tab: 'menu' } });
  if (/\b(parametres|reglages)\b/.test(t) && !/\b(theme|langue|fond)\b/.test(t)) return run({ action: 'open_tab', params: { tab: 'settings' } });
  if (/\b(onglet )?(ajouter|proposer un saint|proposition)\b/.test(t) && /\b(ouvre|montre|affiche|onglet)\b/.test(t)) return run({ action: 'open_tab', params: { tab: 'add' } });
  if (/\b(ouvre|montre|affiche) (l onglet )?(le )?saint du jour\b/.test(t)) return run({ action: 'open_tab', params: { tab: 'daily' } });
  if (/\b(ouvre|montre|affiche) (l onglet |la )?recherche\b/.test(t)) return run({ action: 'open_tab', params: { tab: 'search' } });
  if ((m = /\btheme (sombre|clair|systeme|automatique)\b|\bmode (sombre|clair)\b/.exec(t))) {
    const v = { sombre: 'dark', clair: 'light', systeme: 'system', automatique: 'system' }[m[1] || m[2]];
    return run({ action: 'select_option', params: { field: 'theme', value: v, label: m[1] || m[2] } });
  }
  if ((m = /\b(?:langue|en) (francais|anglais|espagnol|italien|portugais|allemand|neerlandais|polonais|russe|arabe|chinois|latin|english)\b/.exec(t)) && /\b(langue|passe|mets|affiche)\b/.test(t)) {
    const code = { francais: 'fr', anglais: 'en', english: 'en', espagnol: 'es', italien: 'it', portugais: 'pt', allemand: 'de', neerlandais: 'nl', polonais: 'pl', russe: 'ru', arabe: 'ar', chinois: 'zh', latin: 'la' }[m[1]];
    return run({ action: 'select_option', params: { field: 'language', value: code, label: m[1] } });
  }
  if (/\bfond de carte\b/.test(t)) {
    const off = /\b(desactive|jamais|sans|coupe|enleve)\b/.test(t);
    return run({ action: 'select_option', params: { field: 'basemap', value: off ? 'off' : 'auto', label: off ? 'jamais' : 'au zoom rapproché' } });
  }
  if ((m = /\b(?:montre|va a|defile jusqu a|descends? jusqu a) (?:la |le |l )?(rappel quotidien|rappel|installation|ecran d accueil|compte|affichage)\b/.exec(t))) {
    const section = { 'rappel quotidien': '.reminder', rappel: '.reminder', installation: '.install', 'ecran d accueil': '.install', compte: '.account', affichage: '.settings' }[m[1]];
    const label = { '.reminder': 'Rappel quotidien', '.install': "Écran d'accueil", '.account': 'Compte', '.settings': 'Affichage' }[section];
    return runAll([{ action: 'open_tab', params: { tab: 'settings' } }, { action: 'scroll_panel', params: { target: 'panel', section, text: label } }]);
  }

  // -------------------------------------------------------------- jeux
  if (/\b(ouvre|montre|affiche) (les )?jeux\b|^jeux$/.test(t)) return run({ action: 'open_tab', params: { tab: 'jeux' } });
  if (/\b(lance|commence|joue|demarre)\b.*\bquiz\b|^quiz$/.test(t)) {
    const lvl = /niveau 3|ecrit/.test(t) ? 'Niveau 3' : /niveau 2|etendu/.test(t) ? 'Niveau 2' : 'Niveau 1';
    const shots = [{ action: 'open_tab', params: { tab: 'jeux' } }, press('Quiz des saints'), press(lvl)];
    if (notoriety()) shots.push(press(notoriety()));
    return runAll([...shots, press('Commencer')]);
  }
  if (/\b(lance|commence|joue|demarre)\b.*\bchaine\b/.test(t)) {
    const lvl = ['facile', 'moyen', 'complique', 'difficile', 'impossible'].find((k) => t.includes(k));
    const label = { facile: 'Facile', moyen: 'Moyen', complique: 'Compliqué', difficile: 'Difficile', impossible: 'Impossible' }[lvl];
    return runAll([{ action: 'open_tab', params: { tab: 'jeux' } }, press('Chaîne de saints'), ...(label ? [press(label)] : []), press('Commencer')]);
  }
  if (/\b(lance|commence|joue|demarre)\b.*\bqui est ce\b/.test(t)) {
    return runAll([{ action: 'open_tab', params: { tab: 'jeux' } }, press('Qui est-ce'), ...(notoriety() ? [press(notoriety())] : []), press('Commencer')]);
  }
  if (/\b(bonne reponse|reponds? juste|la bonne)\b/.test(t)) return run({ action: 'quiz_correct' });
  if (/\b(reponds?|reponse|choisis la reponse)\b/.test(t) && /\b(\d+|premiere|deuxieme|troisieme|quatrieme|derniere)\b/.test(t) && sm.q('.jeux__reponse')) {
    return run(pressAt('.jeux__reponse', ordinal(t), 'réponse'));
  }
  if ((m = /^(?:reponds|ecris|demande|indice)\s*:?\s+(.+)$/i.exec(clean)) || (m = /^est[- ]ce (?:un|une|que)?\s*(.+?)\s*\??$/i.exec(clean))) {
    return run({ action: 'type_field', params: { text: m[1], submit: true } });
  }
  if (/\bquestion suivante\b/.test(t)) return run(press('Question suivante'));
  if (/\b(affiche|montre|voir) la reponse\b/.test(t)) return run(press('Afficher la réponse'));
  if (/\b(avance|va|choisis|passe)\b.*\b(voisin|maillon|saint suivant)\b|\bavance vers\b/.test(t) && sm.q('.jeux__voisin')) {
    return run(pressAt('.jeux__voisin', ordinal(t), 'voisin'));
  }
  if (/\b(un indice|donne un indice)\b/.test(t)) return run(press('Un indice'));
  if (/\b(recule d un maillon|revenir d un maillon)\b/.test(t)) return run(press('Revenir d’un maillon'));
  if (/\babandonne\b/.test(t)) return run(press('Abandonner'));
  if (/\brejoue[rz]?\b/.test(t)) return run(press('Rejouer'));
  if (/\b(retour aux jeux)\b/.test(t)) return run(press('Jeux', { scope: '#panel' }));
  if (/\bpaliers\b/.test(t)) return run({ action: 'toggle', params: { what: 'paliers', open: true } });
  if (/\bidees d indices\b/.test(t)) return run({ action: 'toggle', params: { what: 'idees', open: true } });

  // --------------------------------------------- panneaux, bandeau, légende
  if (/\b(saint du jour )?(jour suivant|suivant)\b/.test(t) && sm.q('#panel.is-open .daily')) return run(pressAt('.daily__nav button', 1, 'jour suivant'));
  if (/\b(jour precedent|precedent)\b/.test(t) && sm.q('#panel.is-open .daily')) return run(pressAt('.daily__nav button', 0, 'jour précédent'));
  if (/\b(deplie|ouvre|montre)\b.*\b(bandeau|en tete|index)\b/.test(t)) return run({ action: 'toggle', params: { what: 'intro', open: true } });
  if (/\b(replie|ferme)\b.*\b(bandeau|en tete|index)\b/.test(t)) return run({ action: 'toggle', params: { what: 'intro', open: false } });
  if (/\b(deplie|ouvre|montre)\b.*\blegende\b/.test(t)) return run({ action: 'toggle', params: { what: 'legend', open: true } });
  if (/\b(replie|ferme|cache)\b.*\blegende\b/.test(t)) return run({ action: 'toggle', params: { what: 'legend', open: false } });
  if (/\bdefile|descends dans|remonte dans|fais defiler\b/.test(t) && !/\bfiche\b/.test(t)) {
    const to = /\b(haut|remonte)\b/.test(t) ? (/tout en haut/.test(t) ? 'top' : 'up') : (/tout en bas|jusqu en bas/.test(t) ? 'bottom' : 'down');
    return run({ action: 'scroll_panel', params: { target: 'auto', to } });
  }
  if (/\bvoir sur la carte\b/.test(t)) return run(press('Voir sur la carte'));
  if (/\bretour aux resultats\b/.test(t)) return run(press('Retour aux résultats'));
  if (/\bvoir la fiche\b/.test(t) && sm.q('#panel.is-open .jeux')) return run(press('Voir la fiche'));
  if ((m = /^(?:appuie sur|appuyer sur|presse|clique sur|touche)\s+(?:le bouton |la touche |l onglet )?(.+)$/i.exec(clean)) && !sm.visibleList().some((r) => fold(r.name).includes(fold(m[1])))) {
    return run(press(m[1].replace(/^[«"]\s*|\s*[»"]$/g, '')));
  }

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

/**
 * Les gestes sur l'interface (onglets, boutons des jeux et des fiches, réglages,
 * saisies). Ce que la comparaison d'états reconnaît déjà — pays, fiche, corpus,
 * lieux, calendrier — n'est pas noté deux fois.
 */
function demoPush(shot) { shot.params ||= {}; demo.pending.push(shot); renderDemo(); }
function demoClick(target) {
  const el = target.closest?.('button, summary, a[href], [role=button], label.check, .chip');
  if (!el || el.closest('svg.map')) return;
  if (el.matches('.menu__item[data-tab]')) {
    const tab = el.dataset.tab;
    if (tab === 'map') return demoPush({ action: 'close_panel' });
    return demoPush({ action: 'open_tab', params: { tab } });
  }
  if (el.matches('.panel-toggle')) return demoPush({ action: 'open_tab', params: { tab: 'menu' } });
  if (el.matches('.panel__close')) return demoPush({ action: 'close_panel' });
  if (el.matches('.panel__back')) return demoPush({ action: 'open_tab', params: { tab: 'menu' } });
  // Déjà traduits par la comparaison d'états :
  if (el.matches('.result, .picker__item, .corpus__btn, .crumb, .fiche__close, .detail__lieux-btn, .detail__croises-btn, .daily__nav button, .zoom__btn')) return;
  if (el.matches('.jeux__reponse')) return demoPush({ action: 'press', params: { selector: '.jeux__reponse', index: [...sm.D.querySelectorAll('.jeux__reponse')].indexOf(el), what: 'réponse' } });
  if (el.matches('.jeux__voisin')) return demoPush({ action: 'press', params: { selector: '.jeux__voisin', index: [...sm.D.querySelectorAll('.jeux__voisin')].indexOf(el), what: 'voisin' } });
  if (el.tagName === 'SUMMARY') {
    const d = el.closest('details');
    const what = d?.matches('.intro__fold') ? 'intro' : d?.matches('.legend') ? 'legend' : d?.matches('.jeux__paliers') ? 'paliers' : d?.matches('.jeux__idees') ? 'idees' : null;
    if (what) return demoPush({ action: 'toggle', params: { what, open: !d.open } });
  }
  if (el.type === 'submit') return;              // noté par l'envoi du formulaire
  // Une carte (jeu, entrée de menu) se désigne par son titre, pas par tout son texte.
  const title = el.querySelector('.menu__name, .jeux__voisin-nom, .picker__name');
  const label = ((title || el).textContent || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ');
  if (label && label.length <= 60) demoPush({ action: 'press', params: { label } });
}
function demoChange(target) {
  const box = target.closest?.('.settings label.field');
  if (box && target.tagName === 'SELECT') {
    const name = fold(box.querySelector('.field__label')?.textContent);
    const field = name.startsWith('langue') ? 'language' : name.startsWith('theme') ? 'theme' : name.startsWith('fond') ? 'basemap' : null;
    if (field) demoPush({ action: 'select_option', params: { field, value: target.value, label: target.selectedOptions[0]?.textContent } });
  } else if (target.matches?.('.search__input') && target.value.trim()) {
    demoPush({ action: 'search_list', params: { query: target.value.trim() } });
  }
}
function demoSubmit(form) {
  const input = form.querySelector?.('input[type=text], input:not([type])');
  if (input?.value.trim() && !form.matches('form.add')) demoPush({ action: 'type_field', params: { text: input.value.trim(), submit: true } });
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
      D.addEventListener('click', (e) => { if (e.isTrusted && demo.on) demoClick(e.target); }, true);
      D.addEventListener('change', (e) => { if (e.isTrusted && demo.on) demoChange(e.target); }, true);
      D.addEventListener('submit', (e) => { if (e.isTrusted && demo.on) demoSubmit(e.target); }, true);
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
ui.shoot.addEventListener('click', () => renderVideo());
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
  ? 'La vidéo est fabriquée image par image sur cet appareil (30 images/s, MP4). Vous pouvez changer d\'application ou verrouiller l\'écran : la progression s\'affiche sur l\'écran verrouillé et un carillon sonne à la fin. La vidéo va d\'elle-même dans la bibliothèque. Chaque image est gardée sur l\'appareil au fur et à mesure : si le téléphone met la page en pause, le rendu repart au retour ; s\'il la ferme, « Reprendre le rendu » le termine sans recommencer.'
  : 'Ce navigateur ne sait pas fabriquer de vidéo (iOS 16.4 ou plus récent requis) : le bouton passe en plein écran pour l\'enregistrement de l\'écran.';

restore();
renderLibrary();
offerResume().then(() => {
  if (ui.resume.hidden) return;
  // Le rendu a été coupé : on montre ce que le journal disait juste avant.
  const tail = previousJournal.slice(-8);
  if (tail.length) {
    ui.resumeLog.textContent = tail.join('\n'); ui.resumeLog.hidden = false; ui.resumeLog.scrollTop = ui.resumeLog.scrollHeight;
    ui.log.textContent += '— Journal avant l\'interruption —\n' + previousJournal.slice(-30).join('\n') + '\n—\n';
  }
  log(`Rendu interrompu retrouvé (page ${performance.getEntriesByType?.('navigation')?.[0]?.type === 'reload' ? 'rechargée' : 'rouverte'} par Safari).`);
});
let markReady;
const stageReady = new Promise((r) => { markReady = r; });
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
  } finally { setBusy(false); markReady(); }
})();

window.__studio = { get sm() { return sm; }, get director() { return director; }, get scenario() { return scenario; }, plan, data, command };
