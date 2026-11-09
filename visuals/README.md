# Visuels

Fond animé plein écran piloté par le son, pour la TV Ambilight du salon ou pour n'importe quel écran via une session
en ligne (`https://v.chinour.fr`). Un seul processus Node, `server.js`, en deux modes.

```
visuals/
  server.js            HTTP + WebSocket + sessions ; capture PipeWire en local
  switch               bascule un visuel depuis le terminal (POST /active/<nom>)
  Dockerfile           image du mode distant (voir « Déploiement »)
  package.json         Node ≥ 24 ; dépendances : ws, qrcode-generator
  public/              tout ce qui est servi, en ES5 (navigateur de TV ; `make check` le vérifie)
    index.html         écran : une iframe qui charge la scène active poussée par le serveur
    home.html          accueil du mode distant : saisie du code à 4 caractères, bouton vers start.html
    start.html         page de démarrage d'une session distante (capture du son dans le navigateur)
    control.html       téléphone : un bouton par scène, jauges de calibrage
    debug.html         calibrage complet, sur ordinateur
    webgl-check.html   sonde WebGL de la TV (outil affichable sur l'écran, POST /report)
    style.css          feuille de style commune à home, start, control et debug (les scènes ne l'utilisent pas)
    audio-client.js    partagé par les scènes : WebSocket, lissage, punch/hit, simulation 160 BPM
    gl-visual.js       moteur WebGL 1 commun aux scènes en shader
    analysis.js        analyse du son, le même code dans Node et dans le navigateur
    scenes/            une page par visuel : corridor, sunburst, tunnel3d, terrain (+ privés, voir .gitignore)
  reports.jsonl        rapports de la sonde WebGL (mode local seulement, ignoré par git)
```

## Deux modes

- **Local** (défaut, la TV de la maison) : `server.js` capture le monitor PipeWire de la sortie (`pw-record --target
  <sink>` avec `stream.capture.sink=true`, sinon le micro est relié aussi), analyse le son et alimente la session
  réservée `local`. La TV ouvre `http://<ip>:8765/`, le téléphone `/control.html` (redirigé vers la page de contrôle
  signée de `local`), le terminal `make visual V=…`.
- **Distant** (`--no-capture`, le conteneur) : `/` est `home.html` (saisir le code d'une session pour l'afficher, ou
  démarrer une session via `/start.html`). Un visiteur partage le son d'un onglet ou de
  l'écran (`getDisplayMedia`, Chrome ou Edge ; micro ou entrée audio en secours), son navigateur analyse le son avec
  `analysis.js` et publie les valeurs au serveur. Il obtient un lien d'écran public `/s/<id>` (4 caractères), un lien
  de contrôle signé `/c/<id>/<token>` et son QR code. Les sessions vivent en mémoire et expirent 12 h après le départ du
  dernier écran et de la source. L'audio ne quitte jamais le navigateur du visiteur.

```sh
npm install                            # une fois, dans visuals/
make visuals                           # local ; Ctrl-C pour arrêter (ARGS="--range 25")
make visual V=sunburst                 # bascule depuis le terminal
node visuals/server.js --no-capture    # mode distant en local, pour tester start.html
```

Options : `--no-capture`, `--target <sink>` (carte interne par défaut), `--min-ref <dB>` et `--range <dB>` (−35 et 20,
calibrés sur un mix réel le 2026-11-05), `--rise <dB>` (8, seuil de kick ; sur un mix à 156 BPM le résultat ne bouge pas
entre 6 et 12), `--port <n>` (8765, ou la variable `PORT`). Variable `SESSION_SECRET` : clé HMAC des liens ; générée au
démarrage si absente, les liens de contrôle changent alors à chaque redémarrage. Variables `UMAMI_SRC`, `UMAMI_WEBSITE_ID`
et, en option, `UMAMI_DOMAINS` : en mode `--no-capture` seulement, quand les deux premières sont définies, le serveur
injecte la balise Umami dans `home.html`, `start.html` et dans l'écran (`/`, `/s/<id>`), jamais dans la page de contrôle (son URL porte
le jeton) ni dans les scènes. Elles sont posées dans l'environnement Coolify de l'instance déployée (`umami.chinour.fr`,
`UMAMI_DOMAINS=v.chinour.fr`), pas dans l'image ni dans le dépôt : une image construite ailleurs ne compte rien, la TV en
mode local non plus.

## Analyse du son (`public/analysis.js`)

FFT 4096 / pas 1024 (≈47 messages par seconde à 48 kHz), bandes `level` (30-16 000 Hz), `low` (40-120), `mid`
(250-2000), `high` (4000-12 000) avec gain automatique borné (la référence suit le pic récent, jamais sous `min-ref`,
tout ce qui est sous référence − `range` vaut 0), `onset` = kick (la bande 40-120 Hz monte de plus de `rise` dB en 3 pas,
64 ms, réfractaire 150 ms), `tone` (balance grave/aigu, 1 = grave) et `dbg` (dB bruts, références, montée et seuil, pour
`debug.html`). Dans le navigateur : `AudioContext` à 48 kHz, `ScriptProcessorNode` de 1024 trames (un pas), traitements
vocaux de Chrome désactivés (`echoCancellation`, `noiseSuppression`, `autoGainControl`). Sous Linux, Chrome ne partage le
son que d'un **onglet** : pour un logiciel (Mixxx), passer par « entrée audio » et choisir le « Monitor of … ».

## Routes et protocole

| Route | Rôle |
|---|---|
| `GET /` | écran de `local` s'il existe, sinon `home.html` (accueil) ; `/?unknown=<code>` après un `/s/<code>` inconnu |
| `POST /sessions` | crée une session : `id`, `screenUrl`, `controlUrl`, `controlQrUrl`, `sourceToken` ; 10 par minute et par IP, 200 vivantes |
| `GET /s/<id>` | écran public ; code inconnu → 302 vers l'accueil |
| `GET /c/<id>/<token>` | contrôle, jeton `control` |
| `GET /qr/<id>/<jeton source>.svg` | QR code du lien de contrôle (`qrcode-generator`) |
| `GET /visuals?s=<id>` | `{visuals, tools, active, activePath, source}` |
| `POST /sessions/<id>/active/<nom>` | bascule, `Authorization: Bearer <jeton control>` |
| `POST /active/<nom>` | raccourci réseau local sur `local` (`switch`) |
| `POST /report` | rapport de `webgl-check.html` ; écrit `reports.jsonl` en mode local |
| `GET /healthz` | `{ok, sessions}` |
| statique | `public/*.html`, `public/*.js`, `public/*.css`, `public/scenes/*.html` |

WebSocket `/ws?s=<id>&r=screen` (lecture seule, sans jeton) ou `/ws?s=<id>&r=source&t=<jeton>` (une source par session,
la dernière connexion remplace la précédente, 100 messages/s au plus). Serveur → client : `{t:'hello', id, active,
activePath, visuals, tools, source}`, `{t:'audio', level, low, mid, high, onset, tone, dbg}`, `{t:'active', visual, path}`,
`{t:'source', on}`. Les jetons sont des HMAC-SHA256 de `SESSION_SECRET` : le serveur ne stocke rien.

## Pages et scènes

Tout `public/` est en ES5 (`make check` refuse `let`, `const`, `class`, fonctions fléchées et gabarits). `index.html`
charge dans son iframe le chemin poussé par le serveur (`/scenes/<nom>.html` ou un outil), sans flash ; chaque scène ouvre
son propre WebSocket via `../audio-client.js`, qui choisit la session (`?s=`, `/s/<id>`, `/c/<id>/…`, sinon `local`), passe
en `wss:` derrière HTTPS, lisse les bandes, calcule `punch` (≥ 0,7 à chaque kick, décroissance 0,28 s) et `hit` (une frame
par kick) et se replie sur une simulation à 160 BPM sans son. Le navigateur de la TV met les `.js` en cache : incrémenter
`?v=` dans les pages à chaque modification.

Scènes Canvas 2D : `corridor` (couloir de carrés en flux vers l'écran, onde de choc par kick), `sunburst` (12 rayons
tournants, étoile par kick). Scènes WebGL 1 (GLSL ES 1.0, sans bibliothèque) : `tunnel3d` (tunnel raymarché, rayon sur
les basses, anneau par kick), `terrain` (grille filaire, relief basses / médiums / aigus, vague par kick). Elles passent
par `gl-visual.js` : contexte, quad plein écran, uniforms `uLevel`, `uLow`, `uMid`, `uHigh`, `uPunch`, `uHit`, `uTone`,
`uDist` (distance parcourue, bouclée tous les 64 pour la précision `mediump` des GPU de TV), `uHitDist` ; une erreur de
shader s'affiche sur la page ; option `scale: 0.5` pour rendre à moitié de résolution. Une scène privée reste dans
`scenes/` et se liste comme les autres, mais son fichier est inscrit dans `.gitignore` (section « Visuels privés »).
Les anciennes scènes (tunnel, rain, lava, aurora, tide, orbit, solar, geo) sont dans l'historique git.

Avant une scène WebGL sur la TV, ouvrir `http://<ip>:8765/webgl-check.html` dessus : support, renderer, précision `highp`,
cadence en pleine et demi-résolution, envoyés au serveur (`POST /report`, `reports.jsonl`).

Pour tester une branche sur la TV (favori `http://<ip>:8765/`) : arrêter le serveur en place et lancer `make visuals`
depuis le worktree de la branche, sur le même port.

## Déploiement (mode distant, Coolify)

`Dockerfile` : `node:24-alpine` épinglé par digest, `npm ci --omit=dev`, utilisateur `node`, `HEALTHCHECK` sur `/healthz`,
`node server.js --no-capture`. Seuls `server.js` et `public/` suivis par git entrent dans l'image quand Coolify construit
depuis GitHub : une scène privée n'est jamais publiée.

```sh
make visuals-lint-docker                              # hadolint
make visuals-image SECRET=$(openssl rand -hex 32)     # construit et lance sur http://localhost:8765/
```

Production : `https://v.chinour.fr`, ressource Coolify de type **Dockerfile** construite depuis
`github.com/adrien-chinour/djing` (branche `main`, répertoire de base `/visuals`, Dockerfile `/Dockerfile` relatif à la
base, port `8765`, déploiement automatique à chaque push sur `main`), variable `SESSION_SECRET`. Le proxy termine le TLS et
relaie les WebSockets ; le serveur lit `X-Forwarded-For` (limite par IP) et `X-Forwarded-Proto` / `X-Forwarded-Host`
(liens absolus). Le domaine passe par Cloudflare en mode SSL « Full ». Vérification : `curl https://v.chinour.fr/healthz`,
puis une session depuis `/`.
