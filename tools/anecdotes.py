#!/usr/bin/env python3
"""Anecdotes sourcées sur les saints, pour la voix off du studio.

Sources (choisies et validées par le propriétaire du projet) :
  * Wikipédia en français — le texte : seules les phrases appuyées sur une
    référence, tirées des parties qui racontent la vie, la légende ou le culte
    du saint, sont gardées ; chaque anecdote garde le lien permanent de la
    version lue (licence CC BY-SA : la source est toujours citée) ;
  * le Vatican (vatican.va) — biographies officielles en français des saints
    canonisés (``--vatican``) : quelques phrases courtes citées avec leur lien,
    et la confirmation des anecdotes de Wikipédia qu'elles corroborent ;
  * Nominis (Conférence des évêques de France) — la confirmation : le texte de
    Nominis n'est pas recopié (droit d'auteur) ; quand sa notice reprend les
    éléments d'une anecdote, celle-ci est marquée « confirmée par Nominis »,
    avec le lien.
Les récits légendaires sont gardés mais marqués ``legend`` : la voix les
annonce toujours comme tels (« selon la tradition… »).

Lecture lente et identifiée (règles des sites) ; reprise possible après coupure
(``--cache``). Sortie : ``studio/data/anecdotes/<lettre>.json``.

    python3 tools/anecdotes.py --site ../sanctimaps-gif/sanctimaps --limit 10
"""
from __future__ import annotations

import argparse
import html
import html.parser
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

UA = 'SanctiMapsStudio/1.0 (https://sanctimaps.fr; anecdotes sourcees pour videos)'
DELAY = {'fr.wikipedia.org': 1.6, 'nominis.cef.fr': 1.2}
_last = {}

# Parties d'un article qui ne racontent pas la vie du saint.
SKIP_SECTIONS = re.compile(r'(notes?|références|bibliographie|liens externes|voir aussi|articles connexes|sources|'
                           r'filmographie|discographie|dans la culture|culture populaire|œuvres|toponymie|odonymie|'
                           r'galerie|homonymie|annexes|iconographie|représentations?|héraldique|patronymie|historiograph|'
                           r'postérité|controverse|débat|réception|hommage|mémoire|commémoration|récupération|imposture|'
                           r'faux|fausses|survivance|mythe|polémique|critique|famille|ascendance|descendance|généalogie)', re.I)
LEGEND = re.compile(r"\b(légende|légendaire|tradition|selon la tradition|on raconte|raconte-t-on|dit-on|rapporte-t-on|"
                    r"aurait|auraient|serait|seraient|hagiograph\w*|selon (?:sa|la) vita|pieuse|attribu\w*|prodige\w*|miracul\w*|miracles?|ressuscit\w*)\b", re.I)
LEGEND_SECTION = re.compile(r'(légende|tradition|hagiographie|miracles?)', re.I)
# Ce qui fait une anecdote : une action concrète, un détail, un lieu, une date.
ACTION = re.compile(r"\b(partage|partagea|refuse|refusa|fuit|s'enfuit|voit|vit|entend|entendit|guérit|guérissait|sauve|sauva|"
                    r"meurt|mourut|brûl\w*|décapit\w*|martyris\w*|emprisonn\w*|exil\w*|fonde|fonda|construit|bâtit|bâtir|marche|"
                    r"traverse|traversa|rencontre|rencontra|demande|demanda|convertit|prêche|prêcha|donne|donna|vend|vendit|"
                    r"quitte|quitta|part|partit|arrive|arriva|soigne|soigna|nourrit|libère|libéra|apparaît|apparut|"
                    r"tranch\w*|coupe|coupa|jet\w*|cach\w*|retrouv\w*|enl[eè]v\w*|transport\w*|port\w*|offr\w*|"
                    r"fleur\w*|tomb\w*|ressuscit\w*|apprivois\w*|dompt\w*|parl\w*|prédit|prédis\w*|chass\w*)\b", re.I)
MODERN = re.compile(r'\b(rue|avenue|boulevard|lycée|collège|école|station|métro|club|football|équipe|film|roman|série|'
                    r'chanson|album|jeu vidéo|commune|code postal|blason|armoiries|timbre|billet|patronyme|prénom)\b', re.I)
VAGUE_START = re.compile(r'^(Ce|Cette|Ces|Celui-ci|Celle-ci|Ceux-ci|Ils|Elles|Là|Cela|Ceci|En revanche|Toutefois|Cependant|'
                         r'Par ailleurs|De plus|En outre|Ainsi|Donc|Mais|Or|Puis|Ensuite|Enfin)\b')


def fold(text: str) -> str:
    t = unicodedata.normalize('NFKD', text or '').encode('ascii', 'ignore').decode().lower()
    return re.sub(r'[^a-z0-9]+', ' ', t).strip()


def get(url: str, *, attempts: int = 5) -> str:
    """Une page, lentement (une à la fois par site) et en se présentant."""
    host = urllib.parse.urlparse(url).netloc
    wait = DELAY.get(host, 1.5) - (time.time() - _last.get(host, 0))
    if wait > 0:
        time.sleep(wait)
    for k in range(attempts):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Language': 'fr'})
            with urllib.request.urlopen(req, timeout=30) as r:
                _last[host] = time.time()
                raw = r.read()
                # L'encodage déclaré (les pages anciennes du Vatican sont en Latin-1).
                charset = r.headers.get_content_charset()
                if not charset:
                    m = re.search(rb'charset=["\']?([\w-]+)', raw[:2000])
                    charset = m.group(1).decode() if m else 'utf-8'
                # Les vieilles pages déclarent parfois un encodage qui n'est pas le leur : UTF-8 d'abord
                # s'il convient, puis l'encodage déclaré (Latin-1 lu comme Windows-1252).
                try:
                    text = raw.decode('utf-8')
                except UnicodeDecodeError:
                    cs = 'cp1252' if charset.lower() in ('iso-8859-1', 'latin-1', 'latin1', 'iso8859-1') else charset
                    try:
                        text = raw.decode(cs)
                    except (LookupError, UnicodeDecodeError):
                        text = raw.decode('utf-8', 'replace')
                # Caractères de contrôle à la place des apostrophes typographiques (U+0092 → ’).
                return re.sub('[\u0080-\u009f]', lambda m: bytes([ord(m.group())]).decode('cp1252', 'ignore'), text)
        except urllib.error.HTTPError as e:
            _last[host] = time.time()
            if e.code == 404:
                return ''
            if e.code in (429, 503) and k < attempts - 1:
                time.sleep(30 * (k + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if k < attempts - 1:
                time.sleep(5 * (k + 1))
                continue
            raise
    return ''


# ------------------------------------------------------------------ Wikipédia

class WikiText(html.parser.HTMLParser):
    """Les paragraphes d'un article, avec leur partie, et ⟦R⟧ là où une référence est appelée."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.section = 'Introduction'
        self.paras: list[tuple[str, str]] = []
        self.buf: list[str] | None = None
        self.skip = 0          # profondeur d'un élément à ignorer (tableau, figure, note…)
        self.in_heading = None
        self.heading: list[str] = []
        self.content = False
        self.stack: list[str] = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = a.get('class', '') or ''
        if tag == 'div' and 'mw-parser-output' in cls:
            self.content = True
        if not self.content:
            return
        if self.skip:
            if tag not in ('br', 'img', 'wbr', 'meta', 'link', 'input', 'hr'):
                self.skip += 1
            return
        if tag in ('table', 'figure', 'style', 'script', 'math', 'ol', 'ul') or 'navbox' in cls or 'bandeau' in cls \
                or 'mw-editsection' in cls or 'infobox' in cls or 'noprint' in cls:
            self.skip = 1
            return
        if tag == 'sup' and 'reference' in cls:
            if self.buf is not None:
                self.buf.append('⟦R⟧')
            self.skip = 1
            return
        if tag == 'span' and ('need_ref' in cls or 'refnec' in cls):
            if self.buf is not None:
                self.buf.append('⟦NR⟧')
        if tag in ('h2', 'h3', 'h4'):
            self.in_heading = tag
            self.heading = []
        if tag == 'p':
            self.buf = []

    def handle_endtag(self, tag):
        if not self.content:
            return
        if self.skip:
            self.skip -= 1
            return
        if tag == self.in_heading:
            self.section = ' '.join(''.join(self.heading).split())
            self.in_heading = None
        if tag == 'p' and self.buf is not None:
            text = ' '.join(''.join(self.buf).split())
            if text:
                self.paras.append((self.section, text))
            self.buf = None

    def handle_data(self, data):
        if not self.content or self.skip:
            return
        if self.in_heading:
            self.heading.append(data)
        elif self.buf is not None:
            self.buf.append(data)


SENT = re.compile(r'(?<=[.!?])(?:⟦R⟧)*\s+(?=[A-ZÉÈÀÂÎÔÛ«])')


def sentences(text: str):
    """Les phrases d'un paragraphe ; une phrase est sourcée si une référence la suit dans le paragraphe."""
    parts = []
    start = 0
    for m in SENT.finditer(text):
        parts.append(text[start:m.end()].strip())
        start = m.end()
    parts.append(text[start:].strip())
    out = []
    for i, p in enumerate(parts):
        sourced = '⟦R⟧' in p or any('⟦R⟧' in q for q in parts[i + 1:])
        unsure = '⟦NR⟧' in p
        clean = re.sub(r'⟦N?R⟧', '', p)
        clean = re.sub(r'\s*\[[^\]]*\]', '', clean)       # [réf. nécessaire], [1]…
        clean = re.sub(r'\s+([,.;:!?])', r'\1', ' '.join(clean.split())).strip()
        out.append((clean, sourced and not unsure))
    return out


def wikipedia(url: str):
    page = get(url)
    if not page:
        return None
    rev = re.search(r'"wgRevisionId":(\d+)', page)
    title = re.search(r'"wgPageName":"([^"]+)"', page)
    parser = WikiText()
    parser.feed(page)
    perma = url
    if rev and title:
        perma = f'https://fr.wikipedia.org/w/index.php?title={urllib.parse.quote(title.group(1))}&oldid={rev.group(1)}'
    return {'url': perma, 'paras': parser.paras}


DOUBT = re.compile(r"(interprétation abusive|référence nécessaire|réf\. nécessaire|qui \?|quand \?|lequel \?|pas clair|douteux|"
                   r"non neutre|à vérifier|source insuffisante|travail inédit|style à revoir)", re.I)
LEAD = re.compile(r"^(?:(?:En|Le|La|Les|Au|Aux|À|A|Dans|Lors|Avant|Après|Pendant|Vers|Alors|Dès|Depuis|Selon|D'après|Un|Une)\b[^,;:]{0,80},\s*)+")


# Une prière ou une invocation (« Saint Antoine, rends-nous attentifs… ») n'est pas une anecdote.
PRAYER = re.compile(r"(^(saint|sainte|ô|o)\s[^,]{2,40},\s*(vous|tu|rends|donne|priez|prie|aide|accorde|obtiens|intercède|protège|garde|apprends|enseigne)|"
                    r"\b(priez pour nous|prie pour nous|rends-nous|donne-nous|aide-nous|apprends-nous|accorde-nous|amen)\b)", re.I)
FR_WORDS = set('le la les un une des de du et à au aux en dans pour par sur avec qui que il elle est était fut a ont son sa ses se ne pas plus'.split())


def acceptable(text: str) -> bool:
    """Une anecdote dite en français, et pas une prière."""
    w = fold(text).split()
    french = sum(1 for x in w if x in FR_WORDS) / max(1, len(w))
    return french >= 0.12 and not PRAYER.search(text)


def is_subject(s: str, first: str) -> bool:
    """Le saint est-il le sujet ? Son nom arrive dans les tout premiers mots (après une date ou un lieu)."""
    rest = LEAD.sub('', s)
    head = fold(rest).split()[:4]
    return first in head or ('saint' in head[:2] and first in fold(rest).split()[:5])


def candidates(article, name: str, known: str, sex: str = 'm', died: int | None = None, official: bool = False, no_ref: bool = False):
    """``official`` : une biographie entière consacrée au saint (Vatican) — pas besoin de
    référence, et « il / elle » en tête de phrase désigne forcément le saint."""
    """Les phrases qui font une bonne anecdote, avec un score."""
    out = []
    first = fold(name).split(' ')[0]
    seen = fold(known)
    # Le saint doit être le sujet : nommé, ou désigné par « il / elle » en tête de phrase.
    pronoun = re.compile(r'^(Elle|La sainte|La jeune)\b' if sex == 'f' else r'^(Il|Le saint|Le jeune)\b')
    for section, para in article['paras']:
        if SKIP_SECTIONS.search(section):
            continue
        before = ''
        for s, sourced in sentences(para):
            prev, before = before, s
            words = s.split()
            if not (12 <= len(words) <= 42) or not (sourced or official or no_ref):
                continue
            if VAGUE_START.search(s) or MODERN.search(s) or not ACTION.search(s):
                continue
            # Une vraie phrase : majuscule au début, parenthèses équilibrées, point final.
            if not re.match(r'^[A-ZÉÈÀÂÎÔÛ«]', s) or s.count('(') != s.count(')') or not re.search(r'[.!?»]$', s):
                continue
            # Le saint est le sujet : nommé en tête, ou « il / elle » juste après avoir été nommé.
            if not (is_subject(s, first) or (pronoun.search(LEAD.sub('', s)) and (official or (prev and is_subject(prev, first))))):
                continue
            # « ce dernier », « celui-ci » : incompréhensible une fois la phrase isolée.
            if re.search(r"\b(ce dernier|cette dernière|ces derniers|celui-ci|celle-ci|ceux-ci|lequel|laquelle|ce même|cette même)\b", s, re.I):
                continue
            if DOUBT.search(s) or s.count('«') != s.count('»') or '?' in s[:-1] or not acceptable(s):
                continue
            # Rien de moderne : l'anecdote raconte sa vie, sa mort ou les siècles qui ont suivi de près.
            years = [int(y) for y in re.findall(r'\b(1\d{3}|[2-9]\d{2})\b', s)]
            if years and (max(years) > 1950 or (died and max(years) > died + 100)):
                continue
            if fold(s)[:60] in seen:
                continue
            legend = bool(LEGEND.search(s)) or bool(LEGEND_SECTION.search(section))
            score = 2
            score += 2 if re.search(r'\b\d{3,4}\b', s) else 0                    # une date
            score += 1 if re.search(r'\b[A-Z][a-zéèàâîôû]+\b', s[1:]) else 0      # un lieu, un nom
            score += 1 if first and first in fold(s) else 0
            score += 1 if section.lower().startswith(('biograph', 'vie', 'jeunesse', 'enfance', 'légende', 'miracle', 'mort', 'martyre')) else 0
            score -= 2 if section == 'Introduction' else 0                          # l'introduction résume, elle ne raconte pas
            out.append({'text': s, 'legend': legend, 'section': section, 'score': score})
    out.sort(key=lambda c: -c['score'])
    # Pas deux anecdotes qui se ressemblent.
    kept = []
    for c in out:
        f = set(fold(c['text']).split())
        if all(len(f & set(fold(k['text']).split())) < 0.5 * len(f) for k in kept):
            kept.append(c)
        if len(kept) >= 4:
            break
    return kept


# ------------------------------------------------------------------ Nominis

def nominis_index(cache: dict):
    """Toutes les notices de Nominis : nom → [(lien, titre)]."""
    if cache.get('nominis_index'):
        return cache['nominis_index']
    index = {}
    for letter in 'ABCDEFGHIJKLMNOPQRSTUVWXYZ':
        url = f'https://nominis.cef.fr/contenus/saint/alphabetique/{letter}.html'
        pages = [url]
        seen = set()
        while pages:
            u = pages.pop()
            if u in seen:
                continue
            seen.add(u)
            page = get(u)
            for href, label in re.findall(r'href="(/contenus/saints?/\d+/[^"]+\.html)"[^>]*>([^<]+)<', page):
                key = fold(re.sub(r'^(saint|sainte|saints|bienheureux|bienheureuse|venerable|bx)\s+', '', fold(html.unescape(label))))
                index.setdefault(key, []).append(('https://nominis.cef.fr' + href, html.unescape(label).strip()))
            for more in re.findall(rf'href="(/contenus/saint/alphabetique/{letter}[^"]*\.html)"', page):
                pages.append('https://nominis.cef.fr' + more)
    cache['nominis_index'] = index
    return index


def nominis_text(url: str) -> str:
    page = get(url)
    body = re.sub(r'(?is)<(script|style|nav|header|footer)[^>]*>.*?</\1>', ' ', page)
    return ' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', body)).split())


def confirms(anecdote: str, notice: str) -> bool:
    """La notice reprend les éléments marquants de l'anecdote (noms, lieux, dates, mots rares)."""
    words = [w for w in fold(anecdote).split() if len(w) >= 6 or w.isdigit()]
    if len(words) < 3:
        return False
    hit = sum(1 for w in set(words) if w in fold(notice))
    return hit >= max(3, 0.4 * len(set(words)))


# ------------------------------------------------------------------ tout ensemble

# ------------------------------------------------------------------ Vatican

VATICAN_INDEX = 'https://www.vatican.va/news_services/liturgy/saints/index_saints_fr.html'


def vatican_pages():
    """Les biographies officielles en français des saints canonisés (sommaire du Vatican)."""
    page = get(VATICAN_INDEX)
    links = sorted(set(re.findall(r'href="([^"]*ns_lit_doc[^"]*_fr\.html)"', page)))
    out = []
    for href in links:
        url = urllib.parse.urljoin(VATICAN_INDEX, href)
        try:
            body = get(url)
        except Exception:  # noqa: BLE001
            continue
        title = re.search(r'<title>(.*?)</title>', body, re.S)
        title = ' '.join(html.unescape(title.group(1)).split()) if title else ''
        years = [int(y) for y in re.findall(r'\((\d{4})\s*-\s*(\d{4})\)', title)[0]] if re.search(r'\(\d{4}\s*-\s*\d{4}\)', title) else []
        paras = [' '.join(html.unescape(re.sub(r'<[^>]+>', '', p)).split()) for p in re.findall(r'(?is)<p[^>]*>(.*?)</p>', body)]
        # Les noms en capitales (« JEAN-GABRIEL PERBOYRE naquit… ») redeviennent des noms.
        paras = [re.sub(r"\b([A-ZÉÈÀÂÎÔÛÇ][A-ZÉÈÀÂÎÔÛÇ'-]{2,}(?:\s+[A-ZÉÈÀÂÎÔÛÇ][A-ZÉÈÀÂÎÔÛÇ'-]{2,})*)\b",
                        lambda m: m.group(1).title(), p) for p in paras if len(p) > 40]
        if paras:
            out.append({'url': url, 'title': title, 'years': years, 'paras': [('Vie', p) for p in paras], 'text': ' '.join(paras)})
    return out


# ------------------------------------------------------------------ sanctuaires

# Sites officiels de sanctuaires catholiques (autorisés par le propriétaire du projet), version
# française : chacun est consacré à un saint de la carte.
SANCTUAIRES = [
    {'saints': ['therese-lisieux'], 'start': 'https://www.therese-de-lisieux.catholique.fr/', 'name': 'Sanctuaire de Lisieux', 'keys': ['therese', 'vie', 'histoire', 'carmel', 'famille', 'martin']},
    {'saints': ['bernadette-soubirous'], 'start': 'https://www.lourdes-france.org/', 'name': 'Sanctuaire de Lourdes', 'keys': ['bernadette', 'apparition', 'histoire', 'grotte']},
    {'saints': ['bernadette-soubirous'], 'start': 'https://sainte-bernadette-nevers.com/fr/', 'name': 'Espace Bernadette, Nevers', 'keys': ['bernadette', 'vie', 'histoire', 'nevers']},
    {'saints': ['jean-marie-vianney'], 'start': 'https://www.arsnet.org/', 'name': 'Sanctuaire d\'Ars', 'keys': ['vianney', 'cure', 'vie', 'histoire', 'saint']},
    {'saints': ['catherine-laboure'], 'start': 'https://www.medaillemiraculeuse.org/fr/', 'name': 'Chapelle de la Médaille miraculeuse', 'keys': ['catherine', 'laboure', 'apparition', 'histoire', 'medaille']},
    {'saints': ['antoine-padoue'], 'start': 'https://www.santantonio.org/fr', 'name': 'Basilique Saint-Antoine de Padoue', 'keys': ['antoine', 'vie', 'saint', 'histoire', 'miracle']},
    {'saints': ['andre-bessette'], 'start': 'https://saint-joseph.org/fr/', 'name': 'Oratoire Saint-Joseph du Mont-Royal', 'keys': ['andre', 'frere', 'histoire', 'bessette']},
    {'saints': ['francisco-marto', 'jacinta-marto'], 'start': 'https://www.fatima.pt/fr/', 'name': 'Sanctuaire de Fatima', 'keys': ['francisco', 'jacinta', 'pastoureaux', 'apparition', 'histoire', 'voyants']},
    {'saints': ['martin-tours'], 'start': 'https://www.basiliquesaintmartin.fr/', 'name': 'Basilique Saint-Martin de Tours', 'keys': ['martin', 'vie', 'histoire', 'saint']},
]


def sanctuary_pages(site, limit=30):
    """Les pages d'un sanctuaire qui parlent de la vie du saint (même site, mots-clés dans l'adresse)."""
    start = site['start']
    host = urllib.parse.urlparse(start).netloc
    queue, seen, pages = [start], set(), []
    while queue and len(seen) < limit:
        url = queue.pop(0)
        if url in seen:
            continue
        seen.add(url)
        try:
            body = get(url)
        except Exception:  # noqa: BLE001
            continue
        clean = re.sub(r'(?is)<(script|style|nav|header|footer|form)[^>]*>.*?</\1>', ' ', body)
        paras = [' '.join(html.unescape(re.sub(r'<[^>]+>', '', p)).split()) for p in re.findall(r'(?is)<p[^>]*>(.*?)</p>', clean)]
        paras = [p for p in paras if len(p) > 60]
        if paras:
            pages.append({'url': url, 'paras': [('Vie', p) for p in paras]})
        for href in re.findall(r'href="([^"#?]+)"', body):
            u = urllib.parse.urljoin(url, href)
            pu = urllib.parse.urlparse(u)
            if pu.netloc != host or re.search(r'\.(jpg|jpeg|png|pdf|gif|svg|mp3|mp4|zip|css|js)$', pu.path, re.I):
                continue
            path = fold(urllib.parse.unquote(pu.path))
            if any(k in path for k in site['keys']) and u not in seen and u not in queue:
                queue.append(u)
    return pages


def match_vatican(page, saints, texts):
    """Le saint du site que la biographie raconte : même nom (au moins un mot rare), mêmes dates."""
    name = fold(re.split(r'\(|,', page['title'])[0])
    words = {w for w in name.split() if len(w) >= 4 and w not in ('saint', 'sainte', 'bienheureux', 'bienheureuse', 'mere', 'pere', 'marie', 'biographie')}
    best, score_best = None, 0
    for s in saints:
        n = s['name']['fr'] if isinstance(s['name'], dict) else s['name']
        common = words & set(fold(n).split())
        if not common:
            continue
        score = 3 * len(common)
        if page['years']:
            b, d = page['years']
            score += 4 if s.get('died') and abs(s['died'] - d) <= 1 else -6 if s.get('died') else 0
            score += 2 if s.get('born') and abs(s['born'] - b) <= 1 else 0
        if score > score_best:
            best, score_best = s, score
    # Deux mots rares du nom en commun suffisent quand la page ne donne pas de dates (« S. Thérèse de Lisieux »).
    return best if score_best >= 6 else None


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--site', required=True, help='dossier du dépôt SanctiMaps (données)')
    ap.add_argument('--out', default=str(Path(__file__).resolve().parent.parent / 'studio' / 'data' / 'anecdotes'))
    ap.add_argument('--cache', default=str(Path(__file__).resolve().parent / '.anecdotes-cache.json'))
    ap.add_argument('--limit', type=int, default=0, help='nombre de saints (0 : tous)')
    ap.add_argument('--only', default='', help='identifiants de saints, séparés par des virgules')
    ap.add_argument('--no-nominis', action='store_true')
    ap.add_argument('--vatican', action='store_true', help='ajouter les biographies officielles du Vatican (et rien d\'autre)')
    ap.add_argument('--sanctuaires', action='store_true', help='ajouter les sites officiels de sanctuaires (et rien d\'autre)')
    ap.add_argument('--write-only', action='store_true', help='réécrire les fichiers à partir de ce qui est déjà collecté (rien n\'est lu en ligne)')
    args = ap.parse_args()

    gen = Path(args.site) / 'data' / 'generated'
    saints = json.loads((gen / 'saints.json').read_text())['saints']
    texts = json.loads((gen / 'saints-texts.json').read_text())
    cache = json.loads(Path(args.cache).read_text()) if os.path.exists(args.cache) else {}
    done = cache.setdefault('done', {})

    # Les plus documentés d'abord : ce sont ceux dont on fait le plus de vidéos.
    def weight(s):
        t = texts.get(s['id'], {})
        return -(len(t.get('bio', {}).get('fr', '')) + 200 * len(t.get('sources', [])))
    todo = [s for s in sorted(saints, key=weight)
            if any('fr.wikipedia.org' in x.get('url', '') for x in texts.get(s['id'], {}).get('sources', []))]
    if args.only:
        wanted = set(args.only.split(','))
        todo = [s for s in todo if s['id'] in wanted]
    if args.limit:
        todo = todo[:args.limit]

    if args.vatican:
        todo = []
        vat = cache.setdefault('vatican', {})
        for page in vatican_pages():
            s = match_vatican(page, saints, texts)
            if not s:
                print(f'  ? sans correspondance : {page["title"]}', file=sys.stderr)
                continue
            name = s['name']['fr'] if isinstance(s['name'], dict) else s['name']
            t = texts.get(s['id'], {})
            known = (t.get('bio', {}).get('fr', '') + ' ' + t.get('desc', {}).get('fr', ''))
            found = candidates({'url': page['url'], 'paras': page['paras']}, name, known, s.get('sex', 'm'), s.get('died'), official=True)
            vat[s['id']] = {'url': page['url'], 'text': page['text'],
                            'items': [{'text': c['text'], 'legend': c['legend'], 'source': 'Vatican', 'url': page['url']} for c in found[:3]]}
            print(f'  {name} ← {page["title"][:60]} : {len(found[:3])} anecdote(s)')
        Path(args.cache).write_text(json.dumps(cache, ensure_ascii=False))

    if args.sanctuaires:
        todo = []
        sanct = cache.setdefault('sanctuaires', {})
        by_id = {s['id']: s for s in saints}
        for site in SANCTUAIRES:
            pages = sanctuary_pages(site)
            for sid in site['saints']:
                s = by_id.get(sid)
                if not s:
                    continue
                name = s['name']['fr'] if isinstance(s['name'], dict) else s['name']
                t = texts.get(sid, {})
                known = (t.get('bio', {}).get('fr', '') + ' ' + t.get('desc', {}).get('fr', ''))
                items = []
                for page in pages:
                    # (pas « official » : un site de sanctuaire parle aussi d'autres choses que du saint)
                    for c in candidates(page, name, known, s.get('sex', 'm'), s.get('died'), official=False, no_ref=True):
                        if all(fold(c['text'])[:60] != fold(i['text'])[:60] for i in items):
                            items.append({'text': c['text'], 'legend': c['legend'], 'source': site['name'], 'url': page['url'], 'score': c['score']})
                items.sort(key=lambda i: -i['score'])
                sanct.setdefault(sid, [])
                sanct[sid] = [i for i in sanct[sid] if i['source'] != site['name']] + [{k: v for k, v in i.items() if k != 'score'} for i in items[:3]]
                print(f'  {site["name"]} → {name} : {len(pages)} page(s) lue(s), {len(items[:3])} anecdote(s)')
        Path(args.cache).write_text(json.dumps(cache, ensure_ascii=False))

    if args.write_only:
        todo = []
    index = None if (args.no_nominis or args.vatican or args.sanctuaires or args.write_only) else nominis_index(cache)
    started = time.time()
    for n, s in enumerate(todo, 1):
        if s['id'] in done:
            continue
        name = s['name']['fr'] if isinstance(s['name'], dict) else s['name']
        url = next(x['url'] for x in texts[s['id']]['sources'] if 'fr.wikipedia.org' in x.get('url', ''))
        t = texts.get(s['id'], {})
        known = (t.get('bio', {}).get('fr', '') + ' ' + t.get('desc', {}).get('fr', ''))
        try:
            art = wikipedia(url)
        except Exception as e:  # noqa: BLE001 — une page ratée n'arrête pas le reste
            print(f'  ! {name} : {e}', file=sys.stderr)
            continue
        found = candidates(art, name, known, s.get('sex', 'm'), s.get('died')) if art else []
        result = []
        notice = ''
        if found and index is not None:
            # Une seule notice Nominis à ce nom (ou des dates qui concordent) : elle sert de confirmation.
            options = index.get(fold(name), [])
            if len(options) > 1 and s.get('died'):
                options = [o for o in options if str(s['died']) in o[1]] or options[:0]
            if len(options) == 1:
                try:
                    notice = nominis_text(options[0][0])
                except Exception:  # noqa: BLE001
                    notice = ''
                nominis_url = options[0][0]
        for c in found:
            a = {'text': c['text'], 'legend': c['legend'], 'source': 'Wikipédia', 'url': art['url']}
            if notice and confirms(c['text'], notice):
                a['confirmed'] = {'source': 'Nominis', 'url': nominis_url}
            result.append(a)
        done[s['id']] = result
        if n % 10 == 0 or n == len(todo):
            Path(args.cache).write_text(json.dumps(cache, ensure_ascii=False))
            rate = (time.time() - started) / max(1, n)
            print(f'{n}/{len(todo)} saints lus — {sum(1 for v in done.values() if v)} avec anecdotes '
                  f'(reste ≈ {int(rate * (len(todo) - n) / 60)} min)', flush=True)
    Path(args.cache).write_text(json.dumps(cache, ensure_ascii=False))

    # Sortie : un fichier par première lettre de l'identifiant (le studio n'en charge qu'un à la fois).
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    shards: dict[str, dict] = {}
    def clean(a):
        if not acceptable(a['text']):
            return None
        if not a.get('legend') and LEGEND.search(a['text']):
            a = {**a, 'legend': True}
        return a
    merged = {sid: [c for c in (clean(a) for a in items) if c] for sid, items in done.items() if items}
    # Le Vatican : ses anecdotes s'ajoutent, et il confirme celles de Wikipédia qu'il corrobore.
    for sid, v in cache.get('vatican', {}).items():
        lst = merged.setdefault(sid, [])
        for a in lst:
            if not a.get('confirmed') and confirms(a['text'], v['text']):
                a['confirmed'] = {'source': 'Vatican', 'url': v['url']}
        for a in v['items']:
            a = clean(a)
            if a and all(fold(a['text'])[:60] != fold(b['text'])[:60] for b in lst):
                lst.append(a)
    for sid, items in cache.get('sanctuaires', {}).items():
        lst = merged.setdefault(sid, [])
        for a in items:
            a = clean(a)
            if a and all(fold(a['text'])[:60] != fold(b['text'])[:60] for b in lst):
                lst.append(a)
    for sid, items in merged.items():
        if items:
            shards.setdefault(shard_of(sid), {})[sid] = items
    for key, data in shards.items():
        (out / f'{key}.json').write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')))
    total = sum(len(v) for v in merged.values())
    print(f'{total} anecdotes pour {sum(1 for v in merged.values() if v)} saints → {out}')


def shard_of(saint_id: str) -> str:
    c = fold(saint_id)[:1]
    return c if c.isalnum() else '_'


if __name__ == '__main__':
    main()
