// Mode réalisateur dans le navigateur : répétition (vérification hors champ),
// puis tournage en direct, plan par plan, minuté.
import { Report } from './sanctimaps.js';
import { STYLES, scaled } from './planner.js';

export class Director {
  constructor(sm, data, hooks = {}) { this.sm = sm; this.data = data; this.hooks = hooks; this.stopped = false; }

  async resolve(shot) {
    const p = shot.params;
    if (p.query === '@interesting' && !p.resolved) p.resolved = await this.data.interesting(p.country || this.sm.memory.country, p.place);
    if (String(p.place || '').startsWith('@tour:') && !p.resolvedPlace) {
      const iso = p.country || this.sm.memory.country;
      const tour = iso ? await this.data.tour(iso) : [];
      p.resolvedPlace = tour[+p.place.split(':')[1]];
    }
  }

  async attempt(name, methods) {
    let last = null;
    for (const m of methods) {
      try { last = await m(); } catch (e) { last = new Report(name, false, e.message); }
      if (last?.ok) return last;
    }
    return last || new Report(name, false, 'aucune méthode');
  }

  async run(shot) {
    await this.resolve(shot);
    const sm = this.sm, p = shot.params;
    switch (shot.action) {
      case 'establish_world': return this.attempt('monde', [() => sm.goWorld(), () => sm.goWorld()]);
      case 'back_to_world': return this.attempt('monde', [() => sm.goWorld()]);
      case 'open_continent': return this.attempt('continent', [() => sm.goContinent(p.continent), async () => { await sm.goWorld(); return sm.goContinent(p.continent); }]);
      case 'open_country': return this.attempt('pays', [() => sm.goCountry(p.country), async () => { await sm.goWorld(); return sm.goCountry(p.country); }]);
      case 'zoom_to_place': case 'pan_to_place': {
        const place = p.resolvedPlace || p.place;
        if (!place || place.startsWith('@')) return new Report('lieu', false, 'aucun lieu à montrer');
        return this.attempt('lieu', [() => sm.goPlace(place, p.country, p.ratio, shot.action === 'pan_to_place'), () => sm.goPlace(place, null, p.ratio)]);
      }
      case 'zoom_in': case 'zoom_out': {
        const f = shot.action === 'zoom_in' ? (p.factor || 2) : 1 / (p.factor || 2);
        if (sm.snapshot().mode === 'world') return new Report('zoom', f < 1, f < 1 ? 'déjà au plus loin' : 'au niveau monde, on descend par un continent');
        const r = await sm.wheelZoom(f);
        if (f < 1 && !r.ok && sm.snapshot().mode === 'country') {
          await sm.transition(() => sm.D.querySelectorAll('.trail .crumb')[1].click());
          return new Report('zoom', true, 'remontée au continent');
        }
        return new Report('zoom', r.ok, `×${r.achieved.toFixed(2)} ${r.note || ''}`);
      }
      case 'fit_country': return this.attempt('pays', [async () => {
        await sm.closeProfile();
        const iso = p.country || sm.memory.country;
        if (iso && sm.snapshot().trail[2] !== this.data.countryName(iso)) return sm.goCountry(iso);
        await sm.fit();
        return new Report('pays', true, 'vue du pays');
      }]);
      case 'open_saint': {
        const q = p.resolved || p.query;
        if (!q || q.startsWith('@')) return this.attempt('fiche', [() => sm.openNearestMarker()]);
        return this.attempt('fiche', [() => sm.openSaint(q), () => sm.searchSaint(q.split(' ')[0])]);
      }
      case 'show_profile': return sm.showProfile(Math.max(1, shot.duration * 0.8));
      case 'close_profile': return sm.closeProfile();
      case 'century_filter': return this.attempt('siècle', [() => sm.century(p.century, p.country), () => sm.century(p.century)]);
      case 'calendar': return sm.feastDay(p.day);
      case 'apparitions_on': return sm.setCorpus('apparitions');
      case 'apparitions_off': return sm.setCorpus('saints');
      case 'open_apparition': return sm.openApparition(p.name);
      case 'hold': return new Report('pause', true);
      default: return new Report(shot.action, false, 'action inconnue');
    }
  }

  /** Joue le scénario. ``rehearsal`` : vérifie sans se soucier du minutage. */
  async play(scenario, { rehearsal = false } = {}) {
    this.stopped = false;
    this.sm.style = scaled(STYLES[scenario.style] || STYLES.documentary, scenario.speed || 1);
    const reports = {};
    for (const shot of scenario.shots) {
      if (this.stopped) break;
      this.hooks.onShot?.(shot, rehearsal);
      const t0 = this.sm.clock.now();
      let rep;
      try { rep = await this.run(shot); } catch (e) { rep = new Report(shot.action, false, e.message); }
      reports[shot.id] = rep;
      if (!rehearsal) {
        const left = shot.duration * 1000 - (this.sm.clock.now() - t0);
        if (left > 0) await this.sm.clock.wait(left);
      }
      this.hooks.onReport?.(shot, rep, rehearsal, (this.sm.clock.now() - t0) / 1000);
    }
    return reports;
  }
  stop() { this.stopped = true; }
}
