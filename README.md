# Agent vidéo SanctiMaps

**➜ Studio en ligne : https://sanctimaps-gif.github.io/Video-/**

Le studio s'utilise directement dans le navigateur : on décrit la vidéo, il prépare
le scénario, pilote la carte de [sanctimaps.fr](https://sanctimaps.fr/) en direct et la filme.

* **Bibliothèque** : chaque vidéo terminée est rangée sur l'appareil (IndexedDB), avec sa
  vignette, son titre, sa date, sa durée, son format et son scénario : lire, enregistrer dans
  Photos / partager, télécharger, renommer, reprendre le scénario, supprimer. Rien ne quitte
  l'appareil. Safari efface les données d'un site après 7 jours d'utilisation sans l'ouvrir,
  sauf s'il est ajouté à l'écran d'accueil.
* **Scénario modifiable** : durée, ordre (↑ ↓) et suppression (✕) de chaque plan ; chaque
  commande testée dans « Piloter la carte » peut être ajoutée au scénario. Le scénario est
  conservé sur l'appareil.
* **« Montrer à la main »** : on agit soi-même sur la carte (toucher un continent ou un pays,
  zoomer, déplacer, ouvrir une croix, fermer une fiche, basculer en apparitions…) ; le studio
  reconnaît chaque action une fois la carte posée et la propose comme commande à ajouter.
  Un zoom ou un déplacement fait à la main devient un « cadrage » exact, rejoué tel quel.
* **Commandes** (« Toutes les commandes » dans le studio) : continents, pays, villes, points
  cardinaux, zoom avant/fort/arrière, vue du pays, remonter d'un niveau, monde ; recherche d'un
  saint, croix la plus proche, saint choisi dans la liste affichée (« Ouvre le premier saint de la
  liste », « Ouvre Remi de Reims »), lecture de la fiche, lieux marqués, saints croisés ; siècles
  (avec pays), saints nés à…, fêtes (aujourd'hui, demain, une date) ; apparitions (dans un
  pays), miracles, saints ; pauses ;
  **jeux** (quiz à trois niveaux et quatre degrés de notoriété, bonne réponse ou réponse n°,
  question suivante ; chaîne de saints et ses voisins, indice, abandon ; « Qui est-ce ? » et ses
  indices ; paliers) ; **paramètres** (thème, langue, fond de carte, rappel quotidien, écran
  d'accueil, compte), menu, onglet « Ajouter », saint du jour suivant/précédent, défilement des
  panneaux, bandeau et légende ; et tout autre bouton du site par « Appuie sur … ».
  Les boutons qui feraient sortir de la vidéo (téléchargement, autorisation du téléphone,
  installation, compte, envoi d'une proposition) ne sont jamais pressés. Chaque chargement de
  la carte repart des réglages par défaut du site.
* **« Enregistrer la vidéo (MP4) »** — iPhone, iPad et ordinateur : la vidéo est fabriquée
  image par image sur l'appareil (30 images/s exactes, 1080p, H.264), puis proposée au
  téléchargement ou, sur iPhone, à « Enregistrer la vidéo » dans Photos. Le rendu prend
  quelques minutes. **Le rendu continue en arrière-plan** : une piste audio quasi silencieuse,
  lancée par le toucher, garde la page éveillée quand on change d'application ou qu'on
  verrouille l'écran ; la progression s'affiche sur l'écran verrouillé et un carillon sonne à la
  fin. Le rendu ne dépend plus de l'affichage (horloge pas à pas, sans requestAnimationFrame),
  et les attentes réseau ne produisent pas d'images immobiles. **Rien n'est perdu si le
  téléphone suspend ou ferme la page** : chaque image est rangée aussitôt sur l'appareil
  (JPEG dans IndexedDB, avec l'avancement) ; une page mise en pause repart d'elle-même au
  retour, et une page fermée propose « Reprendre le rendu » — l'agent rejoue le scénario sans
  filmer jusqu'à l'image où il s'était arrêté, puis continue. Le rendu est noté dès le toucher (même fermé pendant la préparation, il est
  proposé à la reprise), et le journal des dernières secondes avant l'interruption est gardé et
  affiché. **La reprise est automatique** : après une panne en cours de rendu, ou quand Safari
  recharge la page, le rendu repart seul de la dernière image rangée (la fenêtre « Rendu
  interrompu » n'apparaît que s'il casse plusieurs fois au même endroit). Pour tenir dans la
  mémoire d'un iPhone, chaque image de la carte est écrite directement depuis la page, sans copie
  du DOM, avec une feuille de style partagée (SVG ~5× plus léger), et les toiles sont réutilisées. Le MP4 est assemblé à la fin à
  partir de ces images (quelques secondes), au retour dans Safari si iOS refuse l'encodeur en
  arrière-plan, puis rangé dans la bibliothèque. Nécessite iOS 16.4+ ou un navigateur récent
  (WebCodecs).
* **« Filmer l'onglet en direct »** (ordinateur, Chrome/Edge) : capture en temps réel de
  la carte, plus rapide mais dépendante de la fluidité de la machine.

Le studio charge à chaque fois la version actuelle de SanctiMaps (code et données servis par
sanctimaps.fr) : rien n'est copié ni figé. La version affichée sous le titre change à chaque mise à jour (les modules sont rechargés
d'office). Paramètres d'adresse : `?format=9:16`,
`?demande=…` (texte de la demande), `?src=…` (autre instance du site).

Pour des vidéos à cadence parfaite (rendu image par image, 30 i/s exacts, jusqu'en 4K),
utilisez l'agent en ligne de commande décrit ci-dessous.

---

## Agent en ligne de commande

Un agent réalisateur spécialisé **exclusivement** dans [SanctiMaps](https://sanctimaps.fr/) :
on lui décrit une vidéo en français, il construit le scénario, navigue dans la carte en
vérifiant chaque étape, filme image par image et exporte un MP4 H.264.

```bash
python -m sanctimaps_agent video "Fais une vidéo de 45 secondes qui commence avec une vue du monde, \
descend progressivement vers la France, puis Paris, affiche la fiche du saint sélectionné et revient \
progressivement à une vue de la France."
```

## Installation

```bash
pip install -r requirements.txt
playwright install chromium        # FFmpeg est fourni par imageio-ffmpeg (libx264)
export ANTHROPIC_API_KEY=…         # facultatif : vision de secours + planification par Claude
```

## Utilisation

| Commande | Rôle |
|---|---|
| `python -m sanctimaps_agent video "<demande>"` | **Mode réalisateur** : scénario → répétition → tournage → contrôle → export |
| `python -m sanctimaps_agent plan "<demande>"` | Affiche le scénario minuté, sans tourner |
| `python -m sanctimaps_agent do "Va en France." "Zoome sur Paris."` | Enchaîne des commandes |
| `python -m sanctimaps_agent shell` | Conversation (mémoire de session, retouches de la dernière vidéo) |

Options : `--style cinematic|documentary|fast|slow|educational`, `video --format 16:9|9:16|1:1`,
`video --resolution 720p|1080p|4k`, `--headed` (voir le navigateur), `--no-ai`, `--url` (autre
instance du site, par ex. une copie locale), `-v` (journal détaillé).

Commandes reconnues en conversation : « Ouvre SanctiMaps. », « Va en France. », « Zoome sur Paris. »,
« Montre les saints de France. », « Cherche saint Louis. », « Ouvre sa fiche. », « Fais un zoom
arrière. », « Maintenant zoome davantage », « Montre-moi les saints du XIIe siècle. », « Ouvre le
calendrier. », « Montre les saints fêtés aujourd'hui. », « Passe en mode apparitions. »,
« Commence / Arrête l'enregistrement. », « Fais une vidéo de 30 secondes… », « Fais-la plus lente. »,
« Fais une version verticale. », « Recommence uniquement la dernière séquence. », « Refais la vidéo
avec des mouvements plus fluides. », « État », « Aide ».

## Ce que l'agent sait de SanctiMaps

`sanctimaps_agent/adapter/knowledge.py` (profil `SANCTIMAPS_ADAPTER`) décrit la **structure** du
site, jamais son contenu :

* une carte SVG à trois niveaux — monde → continent → pays — dont la scène porte
  `translate(x y) scale(k)` ; le zoom libre (molette) n'existe qu'au continent et au pays ;
* la projection Mercator du site (`projection.py`, portage de `src/js/map/projection.js`) ;
* les repères (`[data-cluster]`), la liste « N saints ici », la fiche dans la moitié basse
  (`#fiche`), le panneau latéral (recherche à jetons pays/siècle/date, saint du jour), la bascule
  Saints / Apparitions / Miracles, le fil d'Ariane.

Les **données** (pays, continents, villes, fiches) sont lues à chaque session dans les fichiers que
le site publie lui-même (`data/generated/…`) : c'est la source de vérité. Elles servent à choisir
et à vérifier ; ce qui est filmé passe toujours par l'interface du site.

Ordre de priorité pour agir : DOM / accessibilité → sélecteurs connus → coordonnées calculées
(projection + transformation de la scène) → vision IA (Claude, si une clé est fournie).

## Comment la vidéo est fabriquée

* **Rendu image exacte.** L'agent remplace `requestAnimationFrame` et `performance.now` de la page
  par une horloge qu'il fait avancer lui-même : chaque image de la vidéo correspond à 1/30 s de
  temps de la page, quelle que soit la vitesse de la machine. Pas d'images perdues, pas de saccades.
* **Transitions au ralenti.** Les changements de niveau sont les animations du site (720 ms) ; le
  style choisit sur combien de secondes de vidéo elles sont échantillonnées (3,2 s en cinématique).
* **Mouvements libres** : molette répartie sur des dizaines d'images (courbe douce en échelle
  logarithmique), glisser de souris en un seul geste. Jamais « clic-clic-clic ».
* **Synchronisation réelle** (`sync.py`) : `wait_until_map_stable`, `wait_until_panel_open`,
  `wait_until_search_results`, `wait_until_animation_finished`, `wait_until_page_ready` interrogent
  la page ; aucun `sleep` aveugle.
* **Vérification systématique** : après chaque action, l'état est relu (fil d'Ariane, nom de la
  fiche, jeton de siècle, date du calendrier…). Échec → autre méthode → vision → abandon borné.
* **Répétition hors caméra** avant le tournage : les choix ouverts (« une fiche intéressante »,
  « plusieurs zones ») sont fixés et vérifiés ; un plan impossible est retiré avant de filmer.
* **Temps morts** : les images d'attente identiques sont supprimées ; les pauses voulues restent.
* **Contrôle qualité** (`quality.py`) : écrans de chargement, images vides, sauts brusques,
  mouvements figés, fiche filmée incomplète, actions non vérifiées, durées excessives. Les
  séquences fautives — et elles seules — sont retournées.
* **Formats** : 16:9, 9:16, 1:1 ; la fenêtre du navigateur prend directement les proportions du
  format (la carte est mise en page en portrait, pas recadrée). 720p, 1080p, ou 4K rendu nativement
  (facteur d'échelle 2). Export H.264, 30 i/s, `+faststart`, avec un manifeste JSON par séquence.

## Exactitude

* L'agent n'affiche et ne rapporte que ce que le site montre : fiche lue dans le DOM, dates
  « vers … » signalées comme approximatives.
* Un lieu que le site ne connaît pas comme ville (une contrée comme « Quercy ») est montré à
  l'échelle d'une région et signalé « approximatif » : pas plus de précision que le site.
* Le filtre par siècle est celui de la recherche du site (jeton « 12e siècle ») : il filtre la
  liste, pas les croix de la carte — l'agent le dit tel quel.

## Architecture

```
sanctimaps_agent/
  agent.py            SanctiMapsVideoAgent — façade, commandes en français
  nlu.py              compréhension des commandes
  planner.py          ScenarioPlanner — demande → scénario minuté (règles, ou Claude vérifié)
  scenario.py         Shot, Scenario
  director.py         DIRECTOR MODE — répétition, tournage, reprises, export
  executor.py         plan → méthodes successives vérifiées
  adapter/
    knowledge.py      SANCTIMAPS_ADAPTER : sélecteurs, concepts, lecture du DOM
    sanctimaps.py     SanctiMapsAdapter : pays, lieux, recherche, fiches, siècles, calendrier
    map_controller.py MapController : zoom, déplacement, transitions, stabilisation
    apparitions.py    ApparitionsController
    site_data.py      données publiées par le site (géographie, villes, fiches)
    state.py          détection d'état (LOADING … UNKNOWN)
  browser.py          Chromium + horloge virtuelle
  stage.py            avance du temps et prise d'images
  sync.py             attentes sur état réel
  recorder.py         images par séquence, temps morts, export FFmpeg
  quality.py          contrôle qualité
  vision.py           secours visuel (Claude) et mesures d'image
  session.py          mémoire de session
```

## Tests

```bash
pytest                                                       # tests unitaires, sans navigateur
SANCTIMAPS_TEST_URL=https://sanctimaps.fr/ pytest tests/test_integration.py
```

Le dépôt du site peut servir de banc d'essai hors ligne :
`git clone https://github.com/sanctimaps-gif/sanctimaps && cd sanctimaps && npm start`, puis
`--url http://127.0.0.1:8080/`.
