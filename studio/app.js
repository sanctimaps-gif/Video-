import { Clock, DRY, SanctiMaps, SiteData, fold } from './sanctimaps.js';
import { KeepAlive } from './keepalive.js';
import { Library, fileName } from './library.js';
import { Planner, STYLES, parseCentury, total } from './planner.js';
import { Director } from './director.js';
import { StageRecorder, canRecord } from './recorder.js';
import { FrameRenderer, canRender, encodeJob } from './render.js';
import { EMOJI, Realisateur, VARIANTS, renumber as renumberScenes } from './realisateur.js';

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
  toast: $('#toast'), resume: $('#resume'), resumeText: $('#resume-text'), resumeLog: $('#resume-log'), resumeGo: $('#resume-go'), resumeDrop: $('#resume-drop'),
  auto: $('#auto'), steps: $('#steps'), versions: $('#versions'), reasoning: $('#reasoning'), checks: $('#checks'), captions: $('#captions'),
  board: $('#board'), edit: $('#edit'), improve: $('#improve'), addScene: $('#add-scene'), caption: $('#caption'), tasks: $('#tasks'), taskList: $('#task-list'),
  addPause: $('#add-pause'), clear: $('#clear'), library: $('#library'), libList: $('#library-list'), libUsage: $('#library-usage'),
  demo: $('#demo'), demoList: $('#demo-list'), demoAll: $('#demo-all'), demoEmpty: $('#demo-empty'),
};

const clock = new Clock();
const keepAlive = new KeepAlive();
// Garder la musique du téléphone (par défaut) ou prendre la main pour le rendu en arrière-plan le plus sûr.
const MUSIC = 'sanctimaps-studio.musique';
try { $('#keep-music').checked = localStorage.getItem(MUSIC) !== 'non'; } catch { /* sans stockage */ }
keepAlive.mix = $('#keep-music').checked;
$('#keep-music').addEventListener('change', (e) => {
  keepAlive.mix = e.target.checked;
  try { localStorage.setItem(MUSIC, e.target.checked ? 'oui' : 'non'); } catch { /* sans stockage */ }
});
const library = new Library();
const data = new SiteData(SRC);
const dataReady = data.load();
dataReady.catch(() => {});
let sm = null, director = null, scenario = null, busy = false, iframe = null, activeRenderer = null;
// ``busy`` : la carte sert à une action en direct (aperçu, pilotage).
// ``rendering`` : une vidéo se fabrique en arrière-plan ; le reste du studio
// (réalisateur, storyboard, bibliothèque) reste utilisable.
let rendering = false, generating = false, stageAspect = null, playingScn = null, directed = null;

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
function setBusy(b) { busy = b; refresh(); }
/** L'état des boutons : seul ce qui a besoin de la carte attend la fin d'un rendu. */
function refresh() {
  const stageBusy = busy || rendering;
  ui.plan.disabled = ui.auto.disabled = generating;
  ui.improve.disabled = generating || !scenario?.shots?.length;
  ui.shoot.disabled = generating || (busy && !rendering);
  for (const el of [ui.play, ui.cmdGo, ui.capture, ui.demo]) el.disabled = stageBusy;
  ui.stop.disabled = !busy || rendering;
  ui.play.title = rendering ? 'La carte est occupée par la vidéo en cours de fabrication.' : '';
}

// ---------------------------------------------------------------- scène

function layout() {
  const [lw, lh] = LOGICAL[stageAspect || ui.aspect.value];
  const shooting = document.body.classList.contains('shooting');
  const availW = shooting ? innerWidth : ui.wrap.parentElement.clientWidth;
  const availH = shooting ? innerHeight : Math.max(260, Math.min(innerHeight * 0.72, availW * lh / lw));
  const scale = Math.min(availW / lw, availH / lh);
  ui.stage.style.width = `${lw}px`; ui.stage.style.height = `${lh}px`;
  ui.stage.style.transform = `translate(${(availW - lw * scale) / 2}px, ${shooting ? (availH - lh * scale) / 2 : 0}px) scale(${scale})`;
  ui.wrap.style.height = `${shooting ? availH : lh * scale}px`;
}
addEventListener('resize', layout);

async function loadStage(aspect = ui.aspect.value, styleName = ui.style.value) {
  if (demo.on) toggleDemo(false);
  stageAspect = aspect;
  overlay('Chargement de SanctiMaps…');
  // L'ancienne carte est vidée avant d'être retirée : sur iPhone, sa mémoire
  // (des centaines de Mo) est rendue tout de suite au lieu de s'accumuler.
  if (iframe) { try { iframe.src = 'about:blank'; } catch { /* déjà parti */ } }
  ui.stage.replaceChildren();
  iframe = document.createElement('iframe');
  iframe.title = 'SanctiMaps';
  iframe.src = `studio/frame.html?vt=1&src=${encodeURIComponent(SRC)}`;
  ui.stage.append(iframe);
  layout();
  await new Promise((r) => iframe.addEventListener('load', r, { once: true }));
  // Le studio tient l'horloge des animations dès le chargement (voir frame.html).
  clock.attach(iframe.contentWindow);
  sm = new SanctiMaps(iframe, clock, STYLES[styleName] || STYLES.documentary, log);
  // La page du cadre est remplacée par celle du site : on attend qu'elle soit là.
  await sm.waitFor('page SanctiMaps', () => iframe.contentDocument?.querySelector('#map-host'), 60000);
  await sm.open(data);
  director = new Director(sm, data, {
    onShot: (shot, rehearsal) => {
      if (cancelId && rendering) throw Object.assign(new Error('vidéo annulée'), { renderFailure: true, fatal: true, cancelled: true });
      if (playingScn === scenario) markShot(shot.id, rehearsal ? 'répétition' : 'en cours');
      if (!rehearsal) showCaption(shot);
    },
    onReport: (shot, rep, rehearsal) => { if (playingScn === scenario) markShot(shot.id, null, rep); log(`${rehearsal ? '[répétition] ' : ''}${shot.id} ${rep}`); },
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

/**
 * Le storyboard : chaque scène avec sa fonction, son action, son titre à
 * l'écran et sa durée. « ✏️ Modifier » ouvre l'édition : durée, ordre,
 * remplacement de l'action, suppression.
 */
function renderTimeline() {
  ui.timeline.replaceChildren();
  if (!scenario) { ui.total.textContent = ''; ui.notes.textContent = ''; save(); refresh(); return; }
  let t = 0;
  scenario.shots.forEach((s, i) => {
    const li = document.createElement('li'); li.dataset.id = s.id;
    li.innerHTML = `<span class="t">${t.toFixed(1)} s</span>
      <span class="scene-head"></span>
      <span class="lbl"></span>
      <span class="st"></span>
      <span class="scene-cap"></span>
      <span class="edit">
        <label class="dur"><input type="number" min="0.5" max="60" step="0.5" inputmode="decimal" aria-label="Durée en secondes"> s</label>
        <button class="mini" data-do="change" aria-label="Changer l'action">✎</button>
        <button class="mini" data-do="up" aria-label="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="mini" data-do="down" aria-label="Descendre" ${i === scenario.shots.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="mini del" data-do="del" aria-label="Supprimer">✕</button>
      </span>`;
    li.querySelector('.scene-head').textContent = `SCÈNE ${i + 1} — ${s.duration.toFixed(1).replace('.0', '')} s${s.purpose ? ' · ' + s.purpose : ''}`;
    li.querySelector('.lbl').textContent = `${EMOJI[s.action] || '•'} ${s.label}`;
    const capEl = li.querySelector('.scene-cap');
    if (s.caption?.title && scenario.captions !== false) capEl.textContent = `« ${s.caption.title}${s.caption.sub ? ' — ' + s.caption.sub : ''} »`; else capEl.remove();
    if (s.narration) li.title = `Narration : ${s.narration}`;
    const input = li.querySelector('input'); input.value = s.duration;
    input.addEventListener('change', () => {
      const v = parseFloat(String(input.value).replace(',', '.'));
      if (Number.isFinite(v) && v >= 0.5 && v <= 60) s.duration = +v.toFixed(2);
      // Redessiner après la fin de l'événement : le champ est encore en cours d'édition.
      setTimeout(renderTimeline);
    });
    li.querySelector('.edit').addEventListener('click', async (e) => {
      const what = e.target.closest('button')?.dataset.do; if (!what) return;
      const list = scenario.shots;
      if (what === 'del') list.splice(i, 1);
      if (what === 'up' && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
      if (what === 'down' && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
      if (what === 'change') {
        const text = prompt('Nouvelle action pour cette scène (une commande, ex. « Va à Rome », « Montre ses lieux », « Ouvre les jeux ») :');
        if (!text?.trim()) return;
        const shots = await sceneShots(text, s.duration);
        if (!shots) return;
        shots[0].purpose = s.purpose; list.splice(i, 1, ...shots);
      }
      renumber(); renderTimeline();
    });
    ui.timeline.append(li); t += s.duration;
  });
  const target = scenario.target ? ` / ${scenario.target} s demandées` : '';
  ui.total.textContent = `${total(scenario).toFixed(0)} s${target} · ${scenario.shots.length} scènes · ${scenario.aspect} · ${STYLES[scenario.style]?.label || scenario.style}`;
  ui.notes.textContent = (scenario.notes || []).join(' ');
  save(); refresh();
}
function renumber() { scenario.shots.forEach((s, i) => { s.id = `s${String(i + 1).padStart(2, '0')}`; }); }

/** Une commande en français → les scènes correspondantes, si elle existe. */
async function sceneShots(text, duration) {
  const { report, shots } = await dryCommand(text);
  if (!report.ok || !shots.length) { alert(`Commande non reconnue : « ${text} ». Voir « Toutes les commandes » dans « Piloter la carte ».`); return null; }
  const style = STYLES[scenario?.style] || STYLES.documentary; const planner = new Planner(data, sm?.memory);
  const caps = new Realisateur(data);
  const out = [];
  for (const sh of shots) {
    const shot = { id: '', action: sh.action, params: { ...(sh.params || {}) }, label: planner.describe({ action: sh.action, params: sh.params || {} }), purpose: 'Ajout', priority: 1, weight: 1,
      duration: sh.duration || +((Planner.natural(sh.action, style, false) ?? 2) / (scenario?.speed || 1) + (sh.action === 'show_profile' ? 2 : 1)).toFixed(1) };
    shot.caption = await caps.captionFor(shot, scenario || {});
    out.push(shot);
  }
  if (duration && out.length === 1) out[0].duration = duration;
  return out;
}

/** Ajoute des plans testés dans le pilotage, avant la conclusion du storyboard. */
function addShots(shots) {
  if (!scenario) scenario = { request: ui.request.value.trim(), shots: [], style: ui.style.value === 'auto' ? 'documentary' : ui.style.value, speed: 1, aspect: ui.aspect.value, target: null, notes: [], captions: ui.captions.checked };
  const style = STYLES[scenario.style] || STYLES.documentary;
  const at = scenario.shots.length && /^Conclusion/.test(scenario.shots.at(-1).purpose || '') ? scenario.shots.length - 1 : scenario.shots.length;
  const added = [];
  for (const shot of shots) {
    if (!scenario.shots.length && shot.action === 'back_to_world') shot.action = 'establish_world';
    const natural = Planner.natural(shot.action, style, false) ?? 2;
    added.push({ id: '', action: shot.action, params: shot.params || {}, purpose: 'Ajout', priority: 1, weight: 1,
      duration: shot.duration || +(natural / (scenario.speed || 1) + (shot.action === 'show_profile' ? 2 : 1)).toFixed(1),
      label: new Planner(data, sm?.memory).describe({ action: shot.action, params: shot.params || {} }) });
  }
  scenario.shots.splice(at, 0, ...added);
  if (scenario.target) scenario.target = Math.round(total(scenario));
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

/**
 * Le réalisateur : demande → réflexion → 3 storyboards → vérification. Les
 * étapes s'affichent au fur et à mesure ; la carte n'est pas touchée (une
 * vidéo peut être en train de se fabriquer pendant ce temps).
 */
async function plan() {
  const text = ui.request.value.trim();
  if (!text || generating) return null;
  generating = true; refresh();
  try { await dataReady; } catch (e) { generating = false; refresh(); log(`Données SanctiMaps indisponibles : ${e.message}`); return null; }
  ui.steps.hidden = false; ui.steps.replaceChildren();
  ui.versions.hidden = ui.reasoning.hidden = ui.checks.hidden = true;
  const steps = new Map();
  const onStep = async (key, line) => {
    const base = key.replace(/-ok$/, '');
    let li = steps.get(base);
    if (!li) { li = document.createElement('li'); steps.set(base, li); ui.steps.append(li); }
    li.textContent = line; li.classList.toggle('is-wait', !key.endsWith('-ok'));
    // Laisser l'écran se redessiner entre deux étapes.
    await new Promise((r) => setTimeout(r, key.endsWith('-ok') ? 60 : 30));
  };
  try {
    const r = new Realisateur(data, { dryCommand, memory: sm?.memory });
    directed = await r.direct(text, { aspect: ui.aspect.value, style: ui.style.value }, onStep);
    for (const v of Object.values(directed.variants)) v.captions = ui.captions.checked;
    await onStep('ready', '▶ Storyboard prêt : prévisualisez, améliorez ou exportez.');
    steps.get('ready').classList.remove('is-wait');
    chooseVariant(directed.recommended);
    renderReasoning();
    log(`Réalisateur : ${directed.variants[directed.recommended].shots.length} scènes, ${total(scenario).toFixed(0)} s, version ${VARIANTS[directed.recommended].label.toLowerCase()}.`);
    return scenario;
  } catch (e) {
    await onStep('error', `⚠️ ${e.message}`);
    log(`Réalisateur : échec (${e.message}).`);
    return null;
  } finally { generating = false; refresh(); }
}

/** Une des trois versions devient le storyboard. */
function chooseVariant(name) {
  if (!directed?.variants[name]) return;
  scenario = JSON.parse(JSON.stringify(directed.variants[name]));
  scenario.title = scenario.title || ui.request.value.split(/[.:]/)[0].trim().slice(0, 80);
  if (scenario.aspect !== ui.aspect.value) ui.aspect.value = scenario.aspect;
  // La scène suit le format choisi, sauf si une vidéo est en cours de fabrication.
  if (stageAspect !== scenario.aspect && !rendering && !busy && sm) { setBusy(true); loadStage(scenario.aspect).finally(() => setBusy(false)); }
  ui.versions.replaceChildren();
  for (const [key, V] of Object.entries(VARIANTS)) {
    const v = directed.variants[key];
    const b = document.createElement('button');
    b.className = key === name ? 'is-on' : '';
    b.innerHTML = `${key === directed.recommended ? '<span class="reco">Recommandée</span>' : ''}<b></b><small></small>`;
    b.querySelector('b').textContent = V.label;
    b.querySelector('small').textContent = `${v.shots.length} scènes · ${STYLES[v.style]?.label || v.style}`;
    b.title = V.desc;
    b.addEventListener('click', () => chooseVariant(key));
    ui.versions.append(b);
  }
  ui.versions.hidden = false;
  renderChecks(directed.checks[name]);
  renderTimeline();
}

function renderReasoning() {
  const dl = ui.reasoning.querySelector('dl'); dl.replaceChildren();
  for (const { q, a } of directed.reasoning) {
    const dt = document.createElement('dt'); dt.textContent = q;
    const dd = document.createElement('dd'); dd.textContent = a;
    dl.append(dt, dd);
  }
  ui.reasoning.hidden = false;
}

function renderChecks(checks, extra = []) {
  const ul = ui.checks.querySelector('ul'); ul.replaceChildren();
  for (const c of [...extra, ...(checks || [])]) {
    const li = document.createElement('li');
    li.className = c.ok ? '' : 'warn';
    li.textContent = `${c.ok ? (c.fixed ? '🔧' : '✅') : '⚠️'} ${c.text}`;
    ul.append(li);
  }
  ui.checks.hidden = !ul.children.length;
  ui.checks.querySelector('summary').textContent = `Vérification${(checks || []).some((c) => !c.ok) ? ' (réserves)' : ''}`;
}

/** « ✨ Améliorer » : même sujet, meilleur rythme, introduction et conclusion soignées. */
async function improveScenario() {
  if (!scenario?.shots?.length || generating) return;
  const r = new Realisateur(data, { dryCommand, memory: sm?.memory });
  const changes = await r.improve(scenario);
  renderTimeline();
  renderChecks([], changes.map((text) => ({ ok: true, fixed: !/déjà équilibré/.test(text), text })));
  ui.checks.hidden = false; ui.checks.open = true;
  log(`Améliorer : ${changes.join(' ')}`);
}

/** Répétition hors champ : chaque scène est essayée sur la carte ; les impossibles sont retirées. */
async function rehearse(scn = scenario) {
  overlay('<div>Répétition : l\'agent vérifie chaque plan avant de filmer…</div>');
  ui.overlay.style.background = 'rgba(20,14,8,.25)';
  playingScn = scn;
  const elapsed = {};
  const hook = director.hooks.onReport;
  director.hooks.onReport = (shot, rep, reh, secs) => { elapsed[shot.id] = secs; hook(shot, rep, reh, secs); };
  let reports;
  try { reports = await director.play(scn, { rehearsal: true }); } finally { director.hooks.onReport = hook; }
  ui.overlay.style.background = '';
  const failed = scn.shots.filter((s) => !reports[s.id]?.ok);
  if (failed.length) {
    const removed = failed.reduce((a, s) => a + s.duration, 0);
    scn.shots = scn.shots.filter((s) => reports[s.id]?.ok);
    // Le temps des scènes impossibles va aux scènes voisines les plus importantes.
    const keep = scn.shots.filter((s) => s.action === 'show_profile')[0] || scn.shots.at(-1);
    if (keep) keep.duration = +(keep.duration + removed).toFixed(1);
    scn.notes = [...(scn.notes || []), `Scènes impossibles sur la carte, retirées : ${failed.map((s) => s.label).join(', ')}.`];
    if (scn === scenario) renderTimeline();
    log(`Répétition : ${failed.length} scène(s) impossible(s) retirée(s) — ${failed.map((s) => `${s.label} (${reports[s.id]?.detail || 'échec'})`).join(' ; ')}.`);
  }
  // Les durées réelles mesurées pendant la répétition recalent le minutage.
  if (scn.shots.length && scn.target) {
    const before = total(scn);
    const after = new Realisateur(data).retime(scn, elapsed);
    if (Math.abs(after - before) > 0.05 || scn.shots.some((s) => elapsed[s.id] > s.duration)) log(`Minutage recalé sur les durées réelles : ${after.toFixed(1)} s (demandé : ${scn.target} s).`);
    if (scn === scenario) renderTimeline();
  }
  overlay('');
  return scn.shots.length > 0;
}

/** Titre à l'écran : dessiné dans la vidéo pendant un rendu, affiché par-dessus la carte pendant l'aperçu. */
let captionTimer = null;
// Pendant qu'une fiche est ouverte (elle occupe le bas de l'écran), le titre passe en haut.
const FICHE_SHOTS = new Set(['open_saint', 'show_profile', 'show_lieux', 'show_croises', 'open_list_item', 'open_apparition', 'open_marker']);
function showCaption(shot) {
  const on = playingScn?.captions !== false && shot.caption?.title;
  const top = FICHE_SHOTS.has(shot.action);
  if (rendering && activeRenderer) { activeRenderer.setCaption(on ? { ...shot.caption, top } : null, shot.duration); return; }
  clearTimeout(captionTimer);
  ui.caption.classList.toggle('top', top);
  if (!on) { ui.caption.hidden = true; return; }
  ui.caption.querySelector('b').textContent = shot.caption.title;
  ui.caption.querySelector('span').textContent = shot.caption.sub || '';
  ui.caption.hidden = false;
  captionTimer = setTimeout(() => { ui.caption.hidden = true; }, Math.max(800, shot.duration * 1000 - 400));
}

async function countdown(n, text) {
  for (let i = n; i > 0; i--) { overlay(`<div><div class="big">${i}</div><p>${text}</p></div>`); await new Promise((r) => setTimeout(r, 1000)); }
  overlay('');
}

async function captureTab() {
  if (busy || rendering) return;
  setBusy(true);
  let recorder = null;
  try {
    if (!scenario?.shots?.length) await plan();
    if (!scenario) return;
    playingScn = scenario;
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

// ===================================================== vidéos en arrière-plan
//
// Chaque vidéo à fabriquer est une tâche rangée sur l'appareil (IndexedDB) :
// en attente → préparation des scènes → génération (images) → assemblage du
// MP4 → finalisation → bibliothèque. Une seule tâche à la fois (un téléphone
// ne fabrique pas deux vidéos en même temps), les autres attendent leur tour.
// Une tâche survit à une page mise en pause ou fermée : elle reprend à la
// dernière image rangée.

const STATUS = { queued: 'En attente', preparing: 'Préparation des scènes', rendering: 'Génération', encoding: 'Assemblage de la vidéo', finalizing: 'Finalisation' };
const progress = new Map(); // id → { pct, label } en direct
let cancelId = null, queueRunning = false;

function newJob(scn, title) {
  return { id: crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`, created: Date.now(), updated: Date.now(),
    title: (title || scn.title || 'Vidéo SanctiMaps').trim().slice(0, 80), scenario: JSON.parse(JSON.stringify(scn)), aspect: scn.aspect || ui.aspect.value,
    fps: 30, framesDone: 0, expected: total(scn), thumb: null, status: 'queued' };
}

/** « 🎬 Exporter » : la vidéo rejoint la file et se fabrique en arrière-plan. */
async function exportVideo({ gesture = true } = {}) {
  if (!canRender()) {
    log("Ce navigateur ne sait pas fabriquer la vidéo (WebCodecs absent : iOS 16.4 ou plus récent requis). Passage en mode plein écran.");
    return captureTab();
  }
  // Tout de suite, dans le toucher : le son qui garde la page éveillée en arrière-plan.
  if (gesture && !keepAlive.active) keepAlive.start(`SanctiMaps — ${(scenario?.title || ui.request.value || 'vidéo').slice(0, 40)}`);
  if (!scenario?.shots?.length) await plan();
  if (!scenario?.shots?.length) return;
  const job = newJob(scenario);
  await library.saveJob(job);
  log(`Vidéo ajoutée à la file : « ${job.title} » (${job.expected.toFixed(0)} s, ${job.aspect}).`);
  const waiting = (await library.jobs()).filter((j) => j.id !== job.id && !j.failed).length;
  toast(waiting ? `« ${job.title} » attend son tour (${waiting} vidéo${waiting > 1 ? 's' : ''} avant). Vous pouvez continuer à utiliser le studio.`
    : `« ${job.title} » se fabrique en arrière-plan. Vous pouvez continuer à utiliser le studio ou votre téléphone.`, [], 6000);
  await renderTasks();
  runQueue();
}

/** Fabrique les vidéos de la file, l'une après l'autre. */
async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  let wakeLock = null;
  try {
    await stageReady;
    for (;;) {
      const jobs = (await library.jobs().catch(() => [])).filter((j) => !j.failed).sort((x, y) => x.created - y.created);
      // Une tâche interrompue passe avant celles qui attendent.
      const next = jobs.find((j) => j.status !== 'queued') || jobs[0];
      if (!next) break;
      while (busy) await new Promise((r) => setTimeout(r, 300));
      if (!wakeLock) { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* pas de verrou */ } }
      await processJob(next);
    }
  } finally {
    queueRunning = false;
    wakeLock?.release().catch(() => {});
    keepAlive.stop();
    toast('', [], 0, 'resume');
    renderTasks();
  }
}

/** Une tâche, avec reprise automatique tant qu'elle avance. */
async function processJob(job) {
  rendering = true; refresh(); ui.resume.hidden = true;
  progress.set(job.id, { status: job.status, pct: null });
  renderTasks();
  if (!keepAlive.active) keepAlive.title = `SanctiMaps — ${job.title.slice(0, 40)}`;
  try {
    let saved = null;
    for (let attempt = 1; ; attempt++) {
      const before = job.framesDone;
      try { saved = await renderJob(job); break; } catch (e) {
        activeRenderer?.abort(); activeRenderer = null; clock.endRender();
        if (e.cancelled) throw e;
        log(`Incident : ${e.message}`);
        const fresh = (await library.jobs().catch(() => [])).find((j) => j.id === job.id);
        if (!fresh || e.fatal || attempt >= 40 || (fresh.framesDone <= before && attempt >= 3)) throw e;
        job = fresh;
        log(`Reprise automatique à ${(job.framesDone / 30).toFixed(1)} s.`);
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (saved === 'noplan') return;
    if (saved) notifyDone(saved);
    await keepAlive.ding(saved ? `Vidéo prête — « ${job.title} »` : 'Vidéo prête — à enregistrer');
  } catch (e) {
    activeRenderer?.abort(); clock.endRender();
    if (e.cancelled) {
      await library.dropJob(job.id).catch(() => {});
      log(`Vidéo annulée : « ${job.title} ».`);
    } else {
      log(`Échec : ${e.message}`);
      job = (await library.jobs().catch(() => [])).find((j) => j.id === job.id) || job;
      job.failed = e.message;
      await library.saveJob(job).catch(() => {});
      keepAlive.update('échec du rendu', true);
    }
  } finally {
    clock.endRender(); activeRenderer = null; cancelId = null; playingScn = null;
    rendering = false; progress.delete(job.id);
    overlay(''); ui.progress.hidden = true; ui.caption.hidden = true;
    refresh(); renderTasks();
  }
}

function setProgress(job, status, pct = null) {
  progress.set(job.id, { status, pct });
  const li = ui.taskList.querySelector(`[data-id="${job.id}"]`);
  if (!li) return;
  li.querySelector('.task-state').textContent = `${STATUS[status] || status}${pct != null ? ` — ${Math.floor(pct)} %` : ''}`;
  li.querySelector('.task-bar span').style.width = `${pct ?? 0}%`;
}

/** Une vidéo, de la préparation à la bibliothèque. Lève une erreur si quelque chose casse en route. */
async function renderJob(job) {
  const scn = job.scenario;
  playingScn = scn;
  if (job.status !== 'encoding') {
    // Répétition et chargement au pas à pas, eux aussi : rien ne dépend de l'écran.
    clock.beginRender(DRY, 30);
    if (job.status === 'queued' || job.status === 'preparing') {
      job.status = 'preparing'; job.updated = Date.now(); await library.saveJob(job);
      setProgress(job, 'preparing');
      keepAlive.update('préparation des scènes', true);
      log(`Vidéo « ${job.title} » : préparation des scènes.`);
      await loadStage(job.aspect, scn.style);
      if (!(await rehearse(scn))) { log('Aucune scène réalisable.'); await library.dropJob(job.id).catch(() => {}); return 'noplan'; }
      job.scenario = scn;
    }
    await loadStage(job.aspect, scn.style);
    const [w, h] = OUTPUT[job.aspect];
    const expected = total(scn);
    if (job.status === 'preparing') {
      Object.assign(job, { width: w, height: h, expected, framesDone: 0, thumbAt: Math.round(expected * 30 * 0.4), status: 'rendering', updated: Date.now() });
      await library.saveJob(job);
    } else log(`Reprise de « ${job.title} » à ${(job.framesDone / 30).toFixed(1)} s : l'agent rejoue sans filmer jusque-là.`);
    const renderer = activeRenderer = new FrameRenderer(iframe, { width: w, height: h, fps: 30, skip: job.framesDone, thumbAt: job.thumb ? -1 : job.thumbAt,
      store: async (batch, thumb, done) => {
        job.framesDone = done; job.updated = Date.now();
        if (thumb) job.thumb = thumb;
        try { await library.putFrames(job, batch); } catch (e) {
          const err = new Error(e?.name === 'QuotaExceededError' ? "plus de place sur l'appareil pour les images de la vidéo" : `images non rangées (${e?.message})`);
          err.fatal = e?.name === 'QuotaExceededError';
          throw err;
        }
      } });
    await renderer.start();
    ui.progress.hidden = false;
    let lastBeat = Date.now(), lastUi = 0;
    const onFrame = () => {
      if (cancelId === job.id) throw Object.assign(new Error('vidéo annulée'), { renderFailure: true, fatal: true, cancelled: true });
      const now = Date.now();
      // Page suspendue par le téléphone ? On le dit au retour : le rendu, lui, repart.
      if (now - lastBeat > 20000) log(`Rendu en pause ${Math.round((now - lastBeat) / 1000)} s (page suspendue par le téléphone) : il reprend là où il était.`);
      lastBeat = now;
      if (now - lastUi < 250) return;
      lastUi = now;
      const t = renderer.frames / 30;
      const pct = Math.min(100, (t / expected) * 100);
      ui.progressFill.style.width = `${pct}%`;
      ui.progressText.textContent = renderer.frames < renderer.skip ? `Reprise ${t.toFixed(1)} / ${(renderer.skip / 30).toFixed(0)} s` : `Rendu ${t.toFixed(1)} / ${expected.toFixed(0)} s`;
      setProgress(job, 'rendering', pct);
      keepAlive.update(`${Math.floor(pct)} % — ${t.toFixed(0)} / ${expected.toFixed(0)} s`);
    };
    clock.listeners.add(onFrame);
    clock.beginRender(renderer, 30);
    const started = performance.now();
    try {
      await director.play(scn);
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
  setProgress(job, 'finalizing', 100);
  out.thumb = job.thumb;
  const saved = await showResult(out, job);
  if (saved) await library.dropJob(job.id);
  return saved;
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
        if (cancelId === job.id) throw Object.assign(new Error('vidéo annulée'), { fatal: true, cancelled: true });
        const pct = Math.round((i / n) * 100);
        ui.progressFill.style.width = `${pct}%`;
        ui.progressText.textContent = `Assemblage du MP4 ${pct} %`;
        setProgress(job, 'encoding', pct);
        keepAlive.update(`assemblage du MP4 — ${pct} %`);
      });
      log(`MP4 assemblé : ${out.seconds.toFixed(1)} s, ${out.codec === 'avc' ? 'H.264' : 'VP9'}, ${(out.blob.size / 1e6).toFixed(1)} Mo, en ${((performance.now() - t0) / 1000).toFixed(0)} s.`);
      return out;
    } catch (e) {
      if (e.cancelled || attempt >= 3) throw e;
      if (document.hidden) {
        log(`Assemblage interrompu en arrière-plan (${e.message}) : il reprendra au retour dans Safari.`);
        keepAlive.update('revenez dans Safari pour terminer', true);
        await untilVisible();
      } else await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/** Les vidéos en cours et en attente, toujours à jour, même après réouverture. */
async function renderTasks() {
  const jobs = (await library.jobs().catch(() => [])).sort((x, y) => x.created - y.created);
  ui.taskList.replaceChildren();
  for (const job of jobs) {
    const li = document.createElement('li'); li.dataset.id = job.id;
    if (job.failed) li.className = 'is-failed';
    li.innerHTML = `<div class="task-title"></div><div class="task-state"></div><div class="task-bar"><span></span></div><div class="task-actions"></div>`;
    li.querySelector('.task-title').textContent = `${job.title} · ${Math.round(job.expected || 0)} s · ${job.aspect}`;
    const live = progress.get(job.id);
    const pct = live?.pct ?? (job.expected ? Math.min(100, (job.framesDone / 30 / job.expected) * 100) : 0);
    li.querySelector('.task-state').textContent = job.failed ? `Interrompue : ${job.failed}`
      : `${STATUS[live?.status || job.status] || job.status}${(live?.status || job.status) !== 'queued' && pct ? ` — ${Math.floor(pct)} %` : ''}${!queueRunning && job.status !== 'queued' ? ' (en pause)' : ''}`;
    li.querySelector('.task-bar span').style.width = `${pct}%`;
    const actions = li.querySelector('.task-actions');
    const btn = (label, fn, cls = '') => { const b = document.createElement('button'); b.className = `mini ${cls}`; b.textContent = label; b.addEventListener('click', fn); actions.append(b); };
    if (job.failed) {
      btn('Reprendre', async () => { if (!keepAlive.active) keepAlive.start(`SanctiMaps — ${job.title.slice(0, 40)}`); delete job.failed; job.stuck = 0; await library.saveJob(job); renderTasks(); runQueue(); }, 'primary');
    } else if (!queueRunning) {
      btn('Lancer', () => { if (!keepAlive.active) keepAlive.start(`SanctiMaps — ${job.title.slice(0, 40)}`); runQueue(); }, 'primary');
    }
    btn(rendering && progress.has(job.id) ? 'Annuler' : 'Retirer', async () => {
      if (!confirm(`Annuler la vidéo « ${job.title} » ?`)) return;
      if (rendering && progress.has(job.id)) { cancelId = job.id; toast('Annulation…', [], 3000); return; }
      await library.dropJob(job.id); renderTasks();
    }, 'del');
    ui.taskList.append(li);
  }
  ui.tasks.hidden = !jobs.length;
}

/**
 * Page rechargée par Safari au milieu d'un rendu : il repart tout seul, sans
 * bouton. Seul un rendu qui casse deux fois de suite au même endroit attend
 * qu'on décide (fenêtre « Rendu interrompu »).
 */
let resumedAutomatically = false;
async function autoResume() {
  const jobs = (await library.jobs().catch(() => [])).filter((j) => !j.failed);
  await renderTasks();
  if (!jobs.length) return;
  const job = jobs.find((j) => j.status !== 'queued');
  if (job) {
    const progressed = job.reloadFrames === undefined || job.framesDone > job.reloadFrames;
    job.stuck = progressed ? 0 : (job.stuck || 0) + 1;
    job.reloadFrames = job.framesDone;
    await library.saveJob(job).catch(() => {});
    if (job.stuck >= 2) {
      const pct = Math.min(100, Math.round((job.framesDone / 30 / (job.expected || 1)) * 100));
      ui.resumeText.textContent = `« ${job.title} » s'est arrêté plusieurs fois au même endroit (${pct} %). Les images déjà faites sont gardées.`;
      ui.resume.hidden = false; ui.resume.dataset.id = job.id;
      return;
    }
  }
  resumedAutomatically = true;
  toast(`${job ? "La vidéo en cours a repris toute seule." : `${jobs.length} vidéo${jobs.length > 1 ? 's' : ''} en attente : la fabrication reprend.`} Touchez l'écran une fois : elle pourra alors continuer si vous quittez Safari.`, [], 0, 'resume');
  // Le son qui garde la page éveillée en arrière-plan ne peut partir que d'un toucher.
  document.addEventListener('pointerdown', () => { if (rendering || queueRunning) keepAlive.start(`SanctiMaps — ${(job || jobs[0]).title.slice(0, 40)}`); toast('', [], 0, 'resume'); }, { once: true, capture: true });
  runQueue();
}

/**
 * Messages discrets en bas de l'écran, avec des boutons au besoin ; ils ne
 * bloquent rien et disparaissent seuls (``ms``) ou d'un toucher sur ✕.
 */
let toastTimer = null, toastKind = null;
function toast(text, actions = [], ms = 0, kind = null) {
  if (!text) { if (!kind || kind === toastKind) { ui.toast.hidden = true; toastKind = null; } return; }
  clearTimeout(toastTimer); toastKind = kind;
  ui.toast.replaceChildren();
  const close = document.createElement('button'); close.className = 'toast-close'; close.textContent = '✕'; close.setAttribute('aria-label', 'Fermer');
  close.addEventListener('click', () => { ui.toast.hidden = true; });
  const p = document.createElement('div'); p.textContent = text;
  ui.toast.append(close, p);
  if (actions.length) {
    const row = document.createElement('div'); row.className = 'toast-actions';
    for (const a of actions) {
      const b = document.createElement('button'); b.textContent = a.label; if (a.primary) b.className = 'primary';
      b.addEventListener('click', () => { a.run(); ui.toast.hidden = true; });
      row.append(b);
    }
    ui.toast.append(row);
  }
  ui.toast.hidden = false;
  if (ms) toastTimer = setTimeout(() => { ui.toast.hidden = true; }, ms);
}

/** Vidéo terminée : un message discret, avec « Ouvrir » et « Enregistrer sur mon téléphone ». */
function notifyDone(item) {
  toast(`✅ Vidéo terminée : « ${item.title} ». Elle est rangée dans la bibliothèque.`, [
    { label: '▶ Ouvrir', primary: true, run: async () => playItem(await library.get(item.id)) },
    { label: 'Enregistrer sur mon téléphone', run: () => saveToDevice(item.id) },
  ]);
}

/** Enregistrer sur l'appareil : feuille de partage (iPhone : « Enregistrer la vidéo »), sinon téléchargement. */
async function saveToDevice(id) {
  const full = await library.get(id);
  const file = new File([full.blob], fileName(full), { type: full.blob.type || 'video/mp4' });
  if (navigator.canShare?.({ files: [file] })) navigator.share({ files: [file], title: full.title }).catch(() => {});
  else { const a = document.createElement('a'); a.href = URL.createObjectURL(full.blob); a.download = fileName(full); a.click(); }
}

ui.resumeGo.addEventListener('click', async () => {
  // Le son qui garde la page éveillée doit partir dans ce toucher.
  keepAlive.start('SanctiMaps — reprise du rendu');
  const job = (await library.jobs()).find((j) => j.id === ui.resume.dataset.id);
  ui.resume.hidden = true;
  if (job) { job.stuck = 0; delete job.failed; await library.saveJob(job); }
  runQueue();
});
ui.resumeDrop.addEventListener('click', async () => {
  await library.dropJob(ui.resume.dataset.id).catch(() => {});
  ui.resume.hidden = true;
  log('Rendu interrompu abandonné.');
  renderTasks();
  runQueue();
});

// Ce que le téléphone fait de la page pendant un rendu, noté dans le journal.
for (const [target, type, text] of [[window, 'pagehide', 'Safari quitte la page'], [window, 'pageshow', 'Safari rouvre la page'],
  [document, 'freeze', 'Safari gèle la page'], [document, 'resume', 'Safari dégèle la page']]) {
  target.addEventListener(type, () => { if (rendering) log(`${text} (${ui.progressText.textContent || 'préparation'}).`); });
}

// En arrière-plan, le journal dit où en est le rendu à chaque aller-retour.
document.addEventListener('visibilitychange', () => {
  if (!rendering || !keepAlive.active) return;
  if (!document.hidden) keepAlive.resume();
  log(document.hidden ? 'Page en arrière-plan : le rendu continue.' : `De retour : ${ui.progressText.textContent || 'rendu en cours'}.`);
});

/**
 * Une vidéo terminée va directement dans la bibliothèque : enregistrée tout de
 * suite (même page en arrière-plan), puis signalée sans interrompre. Si la
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

/** Signale la dernière vidéo dans la bibliothèque, sans faire défiler la page. */
function revealNewest() {
  if (!newestId) return;
  if (document.hidden) { document.addEventListener('visibilitychange', revealNewest, { once: true }); return; }
  const li = ui.libList.querySelector(`[data-id="${newestId}"]`);
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
          ${item.scenario ? '<button class="mini" data-do="reuse">✏️ Modifier le scénario</button><button class="mini" data-do="regen">🔁 Regénérer</button>' : ''}
          <button class="mini del" data-do="delete">Supprimer</button>
        </div></div>`;
    const img = li.querySelector('img');
    if (item.thumb) img.src = thumbUrl(item); else img.remove();
    li.querySelector('.lib-thumb').classList.add(`is-${(item.aspect || '16:9').replace(':', 'x')}`);
    li.querySelector('.lib-dur').textContent = `${Math.round(item.seconds || 0)} s`;
    li.querySelector('.lib-title').textContent = item.title;
    if (item.id === newestId) li.querySelector('.lib-title').insertAdjacentHTML('afterbegin', '<span class="lib-new">Nouvelle</span> ');
    li.querySelector('.lib-title').insertAdjacentHTML('beforeend', ' <span class="lib-done">✓ Terminée</span>');
    li.querySelector('.lib-meta').textContent = `${d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })} ${d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} · ${item.aspect || ''} · ${((item.size || 0) / 1e6).toFixed(1)} Mo`;
    li.addEventListener('click', async (e) => {
      const what = e.target.closest('[data-do]')?.dataset.do || (e.target.closest('.lib-thumb') ? 'play' : null);
      if (!what) return;
      if (what === 'play') playItem(await library.get(item.id));
      if (what === 'share') saveToDevice(item.id);
      if (what === 'regen') {
        // Même scénario, nouvelle vidéo : elle rejoint la file d'attente.
        if (!keepAlive.active) keepAlive.start(`SanctiMaps — ${item.title.slice(0, 40)}`);
        const job = newJob(JSON.parse(JSON.stringify(item.scenario)), item.title);
        await library.saveJob(job);
        log(`« ${item.title} » : nouvelle vidéo ajoutée à la file.`);
        toast(`« ${item.title} » sera refabriquée en arrière-plan.`, [], 5000);
        renderTasks(); runQueue();
      }
      if (what === 'rename') {
        const title = prompt('Nouveau titre', item.title);
        if (title && title.trim()) { await library.rename(item.id, title.trim()); renderLibrary(); }
      }
      if (what === 'reuse') {
        scenario = JSON.parse(JSON.stringify(item.scenario));
        if (scenario.aspect && scenario.aspect !== ui.aspect.value) {
          ui.aspect.value = scenario.aspect;
          if (!busy && !rendering) { setBusy(true); try { await loadStage(); } finally { setBusy(false); } }
        }
        ui.board.classList.add('editing');
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

/** « ▶ Prévisualiser » : le storyboard joué en direct sur la carte, titres compris. */
async function playOnly() {
  if (busy || rendering) return;
  if (!scenario?.shots?.length) await plan();
  if (!scenario?.shots?.length) return;
  setBusy(true);
  try {
    playingScn = scenario;
    if (stageAspect !== scenario.aspect) await loadStage(scenario.aspect);
    ui.wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    await director.play(scenario);
  } catch (e) { log(`Échec : ${e.message}`); } finally { playingScn = null; ui.caption.hidden = true; setBusy(false); }
}

// --------------------------------------------------------------- commandes

/**
 * Une commande de pilotage : exécutée sur la carte, elle rend aussi les plans
 * équivalents, qu'on peut ajouter au scénario une fois l'essai réussi.
 * Les motifs vont du plus précis au plus général.
 */
async function command(text, { dry = false } = {}) {
  // À blanc (``dry``) : la commande est seulement traduite en plans, sans
  // toucher la carte — c'est ainsi que le réalisateur vérifie qu'une commande
  // existe vraiment avant de l'utiliser.
  const sm = dry ? DRY_STAGE : stage();
  const t = fold(text.replace('’', "'"));
  const clean = text.trim().replace(/[.!?]$/, '');
  let m;
  const done = (report, shots = []) => ({ report, shots });
  const run = async (shot) => done(dry ? planned() : await director.run({ params: {}, ...shot }), [shot]);

  const runAll = async (shots) => {
    if (dry) return done(planned(), shots);
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
    if (!dry) await clock.wait((seconds || 2) * 1000);
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

function stage() { return sm; }
function planned(data = {}) { return { ok: true, detail: '', data, toString: () => '✓ prévu' }; }
/** Une carte « à blanc » pour traduire les commandes sans les jouer. */
const DRY_STAGE = new Proxy({ memory: { saint: null, country: null, place: null }, q: () => ({}), visibleList: () => [{ name: '' }],
  locatePlace: async () => null }, {
  get: (o, k) => (k in o ? o[k] : async (arg) => planned(k === 'goPlace' ? { name: arg } : {})),
});
const dryCommand = (text) => command(text, { dry: true });

async function runCommand(text) {
  if (busy || rendering || !text.trim()) return;
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

ui.plan.addEventListener('click', () => plan());
// « 🤖 Génération automatique » : storyboard puis vidéo en arrière-plan, sans autre question.
ui.auto.addEventListener('click', async () => {
  if (!keepAlive.active) keepAlive.start('SanctiMaps — génération automatique');
  if (await plan()) await exportVideo({ gesture: false });
  else if (!rendering) keepAlive.stop();
});
ui.shoot.addEventListener('click', () => exportVideo());
ui.edit.addEventListener('click', () => ui.board.classList.toggle('editing'));
ui.improve.addEventListener('click', improveScenario);
ui.addScene.addEventListener('click', async () => {
  const text = prompt('Scène à ajouter (une commande, ex. « Va à Rome », « Montre ses lieux », « Ouvre les jeux ») :');
  if (!text?.trim()) return;
  const shots = await sceneShots(text);
  if (shots) addShots(shots);
});
ui.captions.addEventListener('change', () => { if (scenario) { scenario.captions = ui.captions.checked; renderTimeline(); } });
ui.capture.addEventListener('click', captureTab);
ui.capture.hidden = !canRecord();
ui.play.addEventListener('click', playOnly);
ui.stop.addEventListener('click', () => director?.stop());
ui.aspect.addEventListener('change', async () => {
  if (scenario) { scenario.aspect = ui.aspect.value; renderTimeline(); }
  // Pendant la fabrication d'une vidéo, la carte garde son format : seul le storyboard change.
  if (!busy && !rendering) { setBusy(true); try { await loadStage(); } finally { setBusy(false); } }
  save();
});
ui.style.addEventListener('change', () => { if (scenario && ui.style.value !== 'auto') { scenario.style = ui.style.value; renderTimeline(); } else save(); });
ui.demo.addEventListener('click', () => { if (sm && !rendering) toggleDemo(); });
ui.demoAll.addEventListener('click', () => { addShots(demo.pending.splice(0)); renderDemo(); });
ui.addPause.addEventListener('click', () => addShots([{ action: 'hold' }]));
ui.clear.addEventListener('click', () => { if (confirm('Vider le scénario ?')) { scenario = null; renderTimeline(); } });
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
  ? 'La vidéo est fabriquée image par image sur cet appareil (30 images/s, MP4). Vous pouvez changer d\'application ou verrouiller l\'écran ; un carillon sonne à la fin et la vidéo va d\'elle-même dans la bibliothèque. Votre musique continue (case cochée) ; décochée, le studio prend la main sur le son, ce qui garde le rendu actif plus sûrement en arrière-plan et affiche la progression sur l\'écran verrouillé. Chaque image est gardée au fur et à mesure : si le téléphone arrête la page, le rendu repart tout seul.'
  : 'Ce navigateur ne sait pas fabriquer de vidéo (iOS 16.4 ou plus récent requis) : le bouton passe en plein écran pour l\'enregistrement de l\'écran.';

restore();
renderLibrary();
autoResume().then(() => {
  if (ui.resume.hidden && !resumedAutomatically) return;
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
    await dataReady;
    renderTimeline();
    await loadStage();
    log('SanctiMaps est prêt.');
  } catch (e) {
    overlay(`Impossible de charger SanctiMaps : ${e.message}`);
    log(`Échec du chargement : ${e.message}`);
  } finally { setBusy(false); markReady(); }
})();

window.__studio = { get directed() { return directed; }, dryCommand, get renderer() { return activeRenderer; }, get sm() { return sm; }, get director() { return director; }, get scenario() { return scenario; }, plan, data, command };
