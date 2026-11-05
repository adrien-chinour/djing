# djing

Mixer avec la platine **Hercules DJControl Inpulse 300 MK2** sur un PC Ubuntu, avec **Mixxx**. Ce dépôt
contient la configuration et les scripts qui rendent l'installation reproductible.

## Pourquoi Mixxx

Aucun logiciel DJ commercial (DJUCED, Serato, VirtualDJ, djay, rekordbox, Traktor) n'existe sous Linux ;
Wine et les machines virtuelles ajoutent une latence et une fragilité incompatibles avec le mix. Mixxx est
le seul logiciel natif, et le mapping de l'Inpulse 300 livré avec Mixxx est écrit par le support technique
de Hercules. Il est confirmé fonctionnel avec le MK2 ([mixxx#16345](https://github.com/mixxxdj/mixxx/issues/16345),
[mixxx#14057](https://github.com/mixxxdj/mixxx/pull/14057)).

## Matériel

| Élément | Valeur |
|---|---|
| Contrôleur | Hercules DJControl Inpulse 300 MK2, USB `06f8:b12f` (Guillemot) |
| Pilote | aucun : USB audio et MIDI class compliant, reconnu par le noyau |
| Carte son intégrée | 4 canaux de sortie, 24 bits, 44,1 kHz uniquement |
| Canaux 1-2 | sortie **MAIN** (RCA rouge/blanc à l'arrière) vers les enceintes |
| Canaux 3-4 | sortie **casque** (jack en façade) |
| MIDI | un port entrée/sortie, `DJControl Inpulse 300 Mk2 MIDI` |

Linux expose la carte comme `hw:N,0` (N vaut 1 quand la platine est la seule carte USB) et PipeWire la
voit comme une sortie « Surround analogique 4.0 ». Mixxx l'utilise **en ALSA direct**, sans passer par
PipeWire, pour la latence ; PipeWire relâche la carte dès qu'elle est inactive, les deux cohabitent.

## Installation

En une fois, puis se déconnecter et se reconnecter :

```sh
sudo scripts/setup-ubuntu.sh
```

Ce script enchaîne les étapes 1 et 2 ci-dessous. Le détail :

1. Installer Mixxx (dépôts Ubuntu, version 2.5.6 sur 26.04) :

   ```sh
   sudo apt install mixxx
   ```

2. Autoriser l'ordonnancement temps réel, puis **se déconnecter et se reconnecter** :

   ```sh
   sudo scripts/install-realtime.sh
   ```

   Le script installe `system/99-audio-realtime.conf` dans `/etc/security/limits.d/` et ajoute l'utilisateur
   au groupe `audio`. Sans ça, Mixxx avertit « Engine thread not scheduled with the real-time policy
   SCHED_FIFO » et les craquements arrivent dès qu'on baisse le buffer.

3. Brancher la platine, **Mixxx fermé**, puis appliquer la configuration :

   ```sh
   make apply
   ```

   `scripts/apply-mixxx-config.sh controller` sauvegarde `~/.mixxx/soundconfig.xml` et `~/.mixxx/mixxx.cfg` dans
   `~/.mixxx/backup-<horodatage>/`, écrit `mixxx/soundconfig.xml` (API ALSA, Master sur les canaux 1-2,
   casque sur 3-4) avec le bon numéro de carte, installe le mapping MK2 (voir plus bas) et l'active dans
   `mixxx.cfg`.

4. Vérifier :

   ```sh
   make hardware
   ```

   Tout doit être `[OK]`. Lancer Mixxx ensuite et contrôler dans *Préférences > Matériel audio* (périphérique
   `DJControl Inpulse 300 Mk2: USB Audio`) et *Préférences > Contrôleurs* (platine activée, mapping
   « Hercules DJControl Inpulse 300 MK2 (djing) »).

## Sortie sur le PC (sans les enceintes)

Pour mixer avec la carte son du PC, la platine ne servant que de contrôleur, Mixxx fermé :

```sh
make apply-pc
```

Le Master part alors dans le périphérique ALSA `pipewire`, donc sur la sortie par défaut du système
(haut-parleurs, casque Bluetooth…), en 48 kHz, en cohabitant avec les autres applications. La latence est
plus haute qu'en direct, acceptable pour s'entraîner. Pas de sortie casque dans ce mode : la pré-écoute passe
par le Master. Revenir aux enceintes branchées sur la platine : `make apply`.

Même chose à la main, Mixxx ouvert : *Préférences > Matériel audio*, API `ALSA`, Master → `pipewire`.

## Mapping MK2

Le mapping livré avec Mixxx vise l'Inpulse 300 d'origine, qui a un bouton VINYL dédié. Sur le MK2 ce
bouton n'existe pas : Vinyl est **SHIFT + SLIP** et la plage de tempo **SHIFT + Q**. Avec le mapping
d'origine, SHIFT + SLIP ne fait rien et SHIFT + Q recale la grille rythmique.

`mixxx/controllers/` contient un mapping dérivé, « Hercules DJControl Inpulse 300 MK2 (djing) », généré par
`scripts/build-mapping.py` à partir du fichier officiel (`make mapping`) :

| Combinaison | Mapping officiel | Mapping MK2 |
|---|---|---|
| SHIFT + SLIP | rien | Vinyl (scratch) on/off, LED sur SLIP quand SHIFT est tenu |
| SHIFT + Q | recalage de la grille | plage de tempo : 8 % → 16 % → 50 % → 8 % |

Tout le reste vient du script officiel, chargé tel quel ; le fichier `Hercules-DJControl-Inpulse-300-MK2-script.js`
n'ajoute que ces deux fonctions. `make apply` ou `make apply-pc` installe les deux fichiers dans
`~/.mixxx/controllers/` et les sélectionne. Après une mise à jour de Mixxx, relancer `make mapping` puis
`make apply`.

## Agent MIDI (étape 1 : le port virtuel)

Objectif : piloter Mixxx depuis un programme et lire son état, pour un mix scénarisé ou en B2B.
Mixxx n'a pas d'API : il écoute du MIDI. Le pont `agent/bridge.py` crée un port MIDI virtuel ALSA
nommé `djing-agent` (entrée + sortie, aucun droit root) que Mixxx voit comme un contrôleur.

- `agent/protocol.py` est la source unique du protocole : canaux 1 et 2 pour les decks A et B, canal 3
  pour le master et la bibliothèque ; notes pour les boutons (play, cue, sync, hotcues, chargement…),
  CC 7 bits ou 14 bits (MSB sur n, LSB sur n + 32) pour volume, rate, EQ, filtre, seek, crossfader.
- `make agent-mapping` génère depuis ce fichier le mapping Mixxx `mixxx/controllers/djing-agent.midi.xml`
  et la table `djing-agent-protocol.js` ; `djing-agent-script.js` exécute les commandes et renvoie l'état
  (beat, play, BPM, position, durée, tonalité, VU, crossfader…) sur le même port.
- `make apply` installe le mapping et active le contrôleur `djing-agent` dans Mixxx.
- `make test` vérifie l'encodage et le décodage en boucle locale, sans Mixxx.
- `make demo` lance la preuve de l'étape 1 : le crossfader passe de A à B et revient, et le retour d'état
  s'affiche.

Le port appartient à un démon (`make daemon`, journal dans `/tmp/djing-daemon.log`) : Mixxx s'attache à un
périphérique MIDI au démarrage ou à l'ouverture de *Préférences > Contrôleurs* et garde une connexion morte si
le port disparaît. Le démon tourne donc en permanence et les outils (`mix`, `audition`, `demo`) lui parlent par
le socket Unix `/tmp/djing-agent.sock` (`agent/remote.py`, même interface que `agent/bridge.py`). Ordre :
`make daemon`, puis démarrer Mixxx (ou *Préférences > Contrôleurs > Appliquer* une fois). `make daemon-stop`
pour l'arrêter ; il faudra alors refaire ce rescan.

Le démon recharge `agent/protocol.py` depuis **le répertoire où il a été lancé** à chaque commande `reload` des
clients. Changer de branche dans ce checkout sous ses pieds, ou le lancer depuis un autre checkout que celui des
outils, désynchronise silencieusement le décodage du retour MIDI (durées fausses d'un facteur 10, identification
des morceaux impossible, « could not load A »). Lancer le démon depuis le worktree de travail et le redémarrer,
puis Mixxx, à chaque changement de branche de ce checkout.

Outillage Python : `uv` (`~/.local/bin/uv`), Python 3.12 géré par uv (`python-rtmidi` n'a pas de roue
précompilée pour 3.13+ et les en-têtes ALSA ne sont pas installés), dépendances `mido` et `python-rtmidi`
dans `pyproject.toml`, environnement dans `.venv/` (non versionné).

## Analyse des morceaux (étape 2)

`make analyze` produit une fiche JSON par morceau dans `analysis/` (non versionné) et un `analysis/index.json`.
Deux sources :

- **La base Mixxx** (`~/.mixxx/mixxxdb.sqlite`, lecture seule) : BPM et premier beat de la grille (protobuf
  `BeatGrid-2.0` : `Bpm` puis `Beat.frame_position` en frames au taux du fichier, vérifié contre les attaques
  audio), tonalité (convertie en Camelot), cues intro/outro/main (en échantillons stéréo entrelacés). La grille
  Mixxx fait foi : c'est elle qui pilote sync, quantize et les retours `beat_active`.
- **L'audio** (librosa, mono 22,05 kHz) : par beat puis par mesure, énergie globale, énergie des basses
  (< 150 Hz, présence du kick), médiums-aigus, attaque dans les basses.

Déductions, dans `agent/analysis/structure.py` :

- **Temps fort** : phase (mod 4) sur laquelle tombent les arrivées et départs de kick et les sauts d'énergie (les drops et les breaks commencent sur le un). Compter les attaques ne suffit pas : en four-on-the-floor, chaque temps se ressemble.
- **Phrases de 8 mesures** : phase (mod 8) qui concentre les « arrivées » (retour du kick, saut d'énergie).
  La techno coupe souvent le kick sur la dernière mesure d'une phrase ; c'est le marqueur principal.
- **Sections** : par présence du kick, avec absorption des coupures d'une mesure ; `intro`, `groove`, `break`,
  `drop` (kick de retour après un break, énergie ≥ 0,6), `outro`.
- **Points de mix** : `mix_in` = première frontière de phrase avec kick ; `mix_out` = dernière phrase complète
  de la dernière section avec kick.

Lancer l'analyse Mixxx d'abord (barre latérale > *Analyser*) : sans BPM Mixxx, l'analyseur se replie sur
librosa et la grille ne correspondra pas à celle de Mixxx.

## Transitions improvisées sur des patterns (étape 3)

L'agent n'a pas de transition pré-écrite par paire : il a un **vocabulaire de patterns** (`agent/patterns.py`)
et improvise au moment du mix. Pour l'état de A (mesure courante, sections à venir), il énumère les couples
(morceau B, pattern) qui remplissent leurs préconditions, les note (fitness du pattern, compatibilité Camelot,
écart de tempo, notes passées de l'auditeur) et joue le meilleur. `agent/mixer.py` exécute le plan : B calé
et démarré sur une mesure de A (quantize), façonné pendant le chevauchement selon son mode d'entrée, puis
coupure de A sur le premier temps et ouverture complète de B. Jamais deux morceaux pleins ensemble.

| Pattern | Préconditions | Geste |
|---|---|---|
| `break_drop` | break ou outro tardif de A d'au moins 8 mesures ; B a un vrai drop (section `drop` amenée par un break, à 8 mesures au moins du début) | B monte vers son drop sous le break pendant 8 à 16 mesures (batterie de B en passe-bas jusqu'à la coupure si sa montée a du kick, aigus si elle est clairsemée, sinon amorce à 30 %), A coupé là où son drop reviendrait, drop de B dessus. Un groove d'ouverture n'est pas un drop : B à froid est un `slam` |
| `slam` | A dans un break ou un outro tardif (phase basse) ; B a un drop | aucun chevauchement : A coupé sur le un à la fin de son break, là où son drop reviendrait (ou sur une phrase de l'outro), drop de B au même instant. Jamais d'une phase haute de A : deux phases hautes qui s'enchaînent ont été notées 1 |
| `bass_first` | break ou outro de A ≥ 8 mesures **non suivi d'un drop** (sinon l'oreille attend un drop et `break_drop` prend le relais) ; B a un groove à kick régulier | la batterie de B en passe-bas à 70 % sous le break de A pendant 8 à 16 mesures, ouverture progressive, coupure de A |

Sélection de B : tempo à ±3 % (±5 % si tonalité identique ou voisine), compatibilité Camelot ≥ 1, titres sous
110 BPM écartés ; keylock seulement au-delà de 2 % d'écart.

Boucle de validation : chaque transition jouée est consignée dans `analysis/transitions.jsonl` (paire, pattern,
plan, mesures réelles). `make rate N=4 C="amorce inutile"` note la dernière ; la moyenne par pattern et par
mode d'entrée pondère ensuite les choix (±0,2). Commandes :

```sh
make mix A="the man" ARGS=--skip-to            # A imposé, B et pattern choisis, A lancé 8 mesures avant
make mix A="the man" PATTERN=slam ARGS=--skip-to
make mix                                       # A = ce qui joue sur le deck A
uv run python -m agent.audition "tu tu" --section drop   # écouter ce que l'analyse prétend
```

Le temps musical vient de `agent/decks.py` : position renvoyée par Mixxx, extrapolée entre deux messages
avec la vitesse de lecture, convertie en mesures grâce à la grille de l'analyse ; play est envoyé 120 ms avant
la mesure cible pour que le quantize de Mixxx tombe sur le temps. Le chargement d'un morceau passe par la
table visible (contrôles `[Playlist]`, insensibles au focus clavier), tri par titre, et vérification par la
durée, le BPM et la tonalité renvoyés, avec correction du décalage.

## Visuels Ambilight (`visuals/`)

Fond animé plein écran pour une TV Ambilight (16:10), piloté par le son qui sort de l'ordinateur, donc par le
mix Mixxx. Un seul processus, `visuals/audio-server.js` (Node 24, dépendance `ws`, `npm install` dans `visuals/`),
fait tout sur le port 8765 :

- il capture le monitor PipeWire de la sortie (`pw-record --target <sink>` avec `stream.capture.sink=true`, sinon
  le micro est relié aussi), FFT 4096 / pas 1024, et envoie en WebSocket `level`, `low`, `mid`, `high`, `onset`,
  `tone` et `dbg` (valeurs brutes pour `debug.html`), ≈47 messages par seconde ; `onset` est un kick : la bande
  40-120 Hz monte de plus de 8 dB en 3 pas (64 ms), réfractaire 150 ms ;
- il sert les pages du dossier : `/` pour la TV, `/control.html` pour le téléphone (un bouton par visuel, la TV
  bascule dans les 2 s), `/debug.html` pour le calibrage ; `GET /visuals` liste les visuels et l'actif,
  `POST /active/<visuel>` en active un ; `active.html` est créé avec `corridor` s'il manque.

Options : `--target <sink>` (la carte interne est en dur par défaut), `--min-ref <dB>`, `--range <dB>` (défauts −35
et 20, calibrés sur un mix réel le 2026-11-05), `--rise <dB>` (8, seuil de kick : sur un mix à 156 BPM le résultat ne
bouge pas entre 6 et 12), `--port <n>` (8765).

```sh
make visuals                          # à la main, dans un terminal ; Ctrl-C pour arrêter
make visuals ARGS="--range 25"
make visuals-service                  # ou une fois pour toutes : service systemd utilisateur, lancé à la session
make visuals-service-remove
make visual V=sunburst                # bascule depuis le terminal (même effet que le téléphone)
```

Puis la TV ouvre `http://<ip de l'ordinateur>:8765/` et le téléphone `http://<ip>:8765/control.html`. Journal du
service : `journalctl --user -u djing-visuals -f`.

Côté pages, tout est en ES5 (navigateur de TV ; `make check` refuse `let`, `const`, `class`, fonctions fléchées et
gabarits) : `index.html` est une coquille dont l'iframe charge `active.html` et le recharge sans flash quand il
change ; `audio-client.js`, partagé, lisse les bandes, calcule `punch` (≥ 0,7 à chaque attaque, décroissance 0,28 s)
et `hit` (une frame par kick) et se replie sur une simulation à 160 BPM sans serveur ; le navigateur de la TV le met en
cache, incrémenter `?v=` dans les pages à chaque modification.

Visuels en Canvas 2D : `corridor` (couloir de carrés en flux vers l'écran, onde de choc par kick) et `sunburst`
(12 rayons tournants, étoile par kick). Les précédents (tunnel, rain, lava, aurora, tide, orbit, solar, geo) ont été
retirés et restent dans l'historique.

Visuels en WebGL 1 (GLSL ES 1.0, sans bibliothèque) : `tunnel3d` (tunnel infini raymarché, rayon sur les basses,
anneau de choc par kick) et `terrain` (grille filaire en perspective, relief basses / médiums / aigus selon la
profondeur, vague par kick). Ils passent par `gl-visual.js` : contexte, quad plein écran, uniforms audio (`uLevel`,
`uLow`, `uMid`, `uHigh`, `uPunch`, `uHit`, `uTone`), `uDist` (distance parcourue, bouclée tous les 64 pour la
précision `mediump` des GPU de TV) et `uHitDist` (distance au dernier kick) ; une erreur de shader s'affiche sur la
page. Option `scale: 0.5` dans la page pour rendre à moitié de résolution si la TV rame. Avant de s'en servir,
ouvrir `http://<ip>:8765/webgl-check.html` sur la TV : la page affiche le support WebGL, le renderer, la précision
`highp` et la cadence en pleine et demi-résolution, et l'envoie au serveur (`POST /report`, ajouté à
`visuals/reports.jsonl`).

La TV a `http://<ip>:8765/` en favori : pour tester une branche, arrêter le serveur en place et lancer `make visuals`
depuis le worktree de la branche, sur le même port. `--port` sert seulement aux tests automatiques.

## Utilisation

- Brancher la platine **avant** de lancer Mixxx. Enceintes sur MAIN (RCA), casque sur le jack de façade.
- Les boutons **Master** et **casque** de la platine agissent directement sur la carte son : ils ne sont pas
  mappés dans Mixxx, c'est voulu.
- Le pad **Slicer** est fragile si le BPM du morceau n'est pas constant (limite connue du mapping).
- Le bouton **Assistant** bascule l'AutoDJ : il faut une playlist AutoDJ préparée.

## Latence

Le réglage « latence » de `soundconfig.xml` est un index, pas une durée. À 44,1 kHz :

| Index | Buffer | Latence | Usage |
|---|---|---|---|
| 3 | 256 frames | 5,8 ms | scratch, si la machine suit |
| 4 | 512 frames | 11,6 ms | cible pour un contrôleur |
| 5 | 1024 frames | 23,2 ms | valeur livrée ici, sûre sans temps réel |

Baisser dans *Préférences > Matériel audio* une fois le temps réel actif. En cas de craquements : remonter
d'un cran, passer le profil énergie en performance (`powerprofilesctl set performance`), fermer les
applications qui jouent du son sur la platine.

## Bibliothèque musicale

Mixxx ne lit pas la base DJUCED : copier les fichiers audio dans un dossier local (ou un disque), puis
*Préférences > Bibliothèque > Ajouter* et laisser l'analyse (BPM, grille, tonalité) tourner une fois. Les cues
DJUCED ne sont pas récupérables.

## Dépannage

- `make hardware` dit `[KO] rtprio limit is 0` après `install-realtime.sh` : il faut une nouvelle session
  (déconnexion/reconnexion, pas seulement un nouveau terminal).
- Mixxx ne trouve pas la carte : vérifier `cat /proc/asound/cards`, relancer `make apply` si le numéro
  `hw:N` a changé (autre périphérique USB audio branché avant la platine).
- Pas de son mais Mixxx joue : la carte est peut-être tenue par PipeWire (`wpctl status`), couper ce qui
  joue dessus ; à défaut, `pw-cli` ou une règle WirePlumber qui désactive la carte.
- Retour arrière complet : restaurer les fichiers du dernier `~/.mixxx/backup-*/`, supprimer
  `/etc/security/limits.d/99-audio-realtime.conf`, `sudo gpasswd -d "$USER" audio`.

## Références

- [Mixxx : Hercules DJControl Inpulse 300](https://manual.mixxx.org/2.5/en/hardware/controllers/hercules_djcontrol_inpulse_300)
- [DJing on Ubuntu with Hercules](https://discourse.ubuntu.com/t/djing-on-ubuntu-with-hercules-a-celebration-of-open-source-software/47194)
- [Mixxx wiki : Adjusting Audio Latency](https://github.com/mixxxdj/mixxx/wiki/Adjusting-Audio-Latency)

## Licence

GPL-2.0-or-later (fichier `LICENSE`). Le mapping `mixxx/controllers/Hercules_DJControl_Inpulse_300_MK2.midi.xml`
dérive du mapping officiel livré avec Mixxx, lui-même sous GPL-2.0-or-later.
