# djing web (POC)

Logiciel de mix dans le navigateur, piloté par la Hercules DJControl Inpulse 300 MK2. But du POC : vérifier que
Chrome sait lire la platine (Web MIDI) et sortir le MAIN sur les canaux 1-2 et le casque sur les canaux 3-4 de sa
carte son, sans Mixxx.

## Lancer

1. Fermer Mixxx (il garde le port MIDI et la carte son).
2. Brancher la platine.
3. `make web-split` dans un terminal (le laisser tourner : les deux sorties disparaissent à l'arrêt).
4. `make web` dans un autre, puis ouvrir <http://localhost:8800> dans **Chrome ou Edge**.
5. Cliquer « Démarrer l'audio » et accepter l'accès MIDI. Si les sorties n'ont pas de nom, cliquer « Noms des
   sorties » (Chrome ne les donne qu'après une autorisation micro) : « Inpulse MAIN » et « Inpulse Casque » sont
   alors choisies seules.

## Ce qu'il faut vérifier

- Pastille de sortie verte : MAIN et casque partent sur deux sorties différentes.
- « Bip MAIN » sonne dans les enceintes (440 Hz), « Bip casque » dans le casque seul (880 Hz).
- Les messages MIDI s'affichent dans le journal en bas quand on touche la platine.
- PLAY, CUE, PFL, volumes, EQ, gain, filtre, pitch, crossfader et jogs agissent sur les decks ; les LED PLAY, CUE
  et PFL suivent.
- Les VU-mètres de l'écran (A, B pré-fader, master L et R) et les LED VU de la platine suivent le son ; le voyant
  LIMIT s'allume quand le limiteur du MAIN réduit le gain de plus de 3 dB.

## Tester sans la platine

- `make web-test` : test de bout en bout, sans matériel ni Mixxx. Il crée une platine simulée (port MIDI virtuel
  au nom de la platine), une sortie PipeWire 4 canaux qui tient lieu de carte son, la découpe avec
  `split-outputs.sh`, pilote Chrome headless, joue un titre depuis la platine simulée et mesure avec `pw-record`
  le son de chaque canal (MAIN, PFL, fader, crossfader), les LED reçues, le pitch et le jog. Le scénario
  `vu-limiter.mjs` vérifie les VU-mètres, les LED VU et leur débit, et la crête du MAIN limité. Tout ce qu'il crée
  est supprimé à la fin. Prérequis : `google-chrome`, PipeWire (`pw-cli`, `pw-dump`, `pw-record`,
  `pw-loopback`, `pw-link`), `uv`.
- Un scénario par fichier dans `test/scenarios/` (`poc.mjs` : le scénario ci-dessus ; `beatgrid.mjs` : l'analyse du BPM ; `library.mjs` : la
  bibliothèque, sur un dossier de l'OPFS que `showDirectoryPicker` rend à la place du sélecteur). `make web-test` les lance
  tous, `make web-test SCENARIO=poc` un seul ; le code de sortie est non nul si un scénario échoue. Le sink et les
  sorties découpées sont partagés ; chaque scénario part d'une page rechargée et d'une platine simulée neuve. Un
  scénario exporte par défaut `async ({ page, sim, url }) => …` et vérifie avec `check()` ; les outils (sink,
  découpage, platine simulée, Chrome, mesure RMS par canal) sont dans `test/lib.mjs`.
- `make web-sim` : la platine simulée seule, pour jouer à la main avec la page. Une commande par ligne :
  `press A play`, `knob A volume 0.5`, `xfader 0`, `rate B 0.3`, `jog A 20 touched`, `jog A 100 touched 500` (tics étalés sur 500 ms), `jog A 25 shift`, `press A vinyl`, `pad A hotcue 1 shift`,
  `note 91 07 7f`, `cc b1 00 40`, `leds`… (liste en tête de
  `sim/controller.py`). Les LED que la page allume s'affichent en JSON.

que ne reçoit rien.
- « Bip MAIN » sonne dans les enceintes (440 Hz), « Bip casque » dans le casque seul (880 Hz).
- Les messages MIDI s'affichent dans le journal en bas quand on touche la platine.
- PLAY, CUE, PFL, volumes, EQ, gain, filtre, pitch, crossfader et jogs agissent sur les decks ; les LED PLAY, CUE
  et PFL suivent.

## Contenu

- `sim/controller.py` : platine simulée (MIDI). `test/e2e.mjs` : lanceur des scénarios de `test/scenarios/`,
  outils communs dans `test/lib.mjs`. `window.djing.engine` donne accès au moteur depuis la console.
- `mapping.js` : table déclarative de chaque entrée MIDI (statut, numéro, type note/cc/14 bits/jog, action) et de
  chaque LED ; numéros tirés de `mixxx/controllers/Hercules_DJControl_Inpulse_300_MK2.midi.xml`. Les messages
  SHIFT (`0x93` maître, `0x94`/`0x95` decks) ont leurs propres actions `shift.*`.
- `midi.js` : décodeur générique piloté par `mapping.js`, envoi des LED.
- `actions.js` : registre d'actions (`register(nom, fn)`, `dispatch(nom, deck, valeur)`) et de LED
  (`led(nom, deck, () => état)`), recalculées après chaque action et envoyées seulement si elles changent.
- `engine.js` : Web Audio, deux decks (gain, EQ 3 bandes, filtre, fader, PFL), crossfader à puissance constante,
  limiteur sur le MAIN, analyseurs de niveau (decks pré-fader, MAIN L/R après le limiteur), sortie en deux flux
  stéréo ou en 4 canaux discrets.
- `worklets/limiter.js` : AudioWorklet, limiteur crête à anticipation (5 ms) sur le MAIN, plafond −1 dBFS ; le casque n'est
  pas limité.
- `ui/meters.js` : VU-mètres (crête, échelle −48..0 dBFS), voyant LIMIT et LED VU de la platine (`METERS` de
  `mapping.js`, 0..125, toutes les 34 ms au plus, seulement quand la valeur change).
- `worklets/deck-player.js` : lecteur d'un deck dans un `AudioWorklet` : vitesse signée de −4 à +4, interpolation
  linéaire, saut en lecture avec fondu croisé de 5 ms, arrêt en fin de titre (ou à 0 en marche arrière), position
  remontée environ 120 fois par seconde. Le scénario `test/scenarios/deck-player.mjs` le vérifie.
- `library/` : base IndexedDB unique `djing` (`db.js`, une migration par version : magasins `tracks`, données par
  titre, et `settings`, dont le dossier de musique) et liste des titres d'un `FileSystemDirectoryHandle` (`scan.js`).
  Identifiant d'un titre : `<chemin relatif>|<taille>|<lastModified>`.
- `analysis/` : BPM et grille de chaque titre, calculés une fois. `queue.js` décode les titres un par un
  (`OfflineAudioContext` à 22 050 Hz, mono) et les passe au Web Worker `worker.js`, qui appelle `beat.js` :
  montée d'énergie log par fenêtres de 20 ms toutes les 1,5 ms, autocorrélation sur les tempos 70–180 BPM (le
  plus rapide l'emporte quand un multiple est aussi fort), affinage de la période, puis régression linéaire sur
  les pics d'onset de chaque temps. Résultat sous `analysis: { bpm, firstBeat }` dans `tracks` (`bpm: null` :
  « BPM inconnu », pas de grille) ; un titre qui l'a n'est plus analysé. Le deck affiche BPM et premier temps,
  corrigés par ÷2, ×2, −10 ms, +10 ms (actions `grid.*`). Le scénario `test/scenarios/beatgrid.mjs` le vérifie
  sur des pistes de clics et du bruit blanc.
- `ui/library.js` : « Choisir le dossier » (`showDirectoryPicker`, handle gardé en IndexedDB, « Rouvrir » au
  rechargement pour redemander la permission), tableau Artiste / Titre / Chemin, chargement par les boutons A/B, par
  l'encodeur (`0xB0 0x01`, sélection) et par LOAD (`0x91`/`0x92` `0x0D`). Un fichier que `decodeAudioData` refuse
  est grisé « illisible », et l'état est gardé.
- Scratch (`engine.js`, constantes de `DJCi300._scratchEnable` dans Mixxx) : VINYL active le mode vinyle (actif au
  démarrage, LED allumée). Jog touché en mode vinyle : 248 tics par tour, un tour = 1,8 s de titre (33 ⅓ tr/min),
  vitesse lissée par un filtre alpha-bêta (alpha 1/8, bêta alpha/32, pas de 1 ms) ; au relâchement, retour à la
  vitesse du pitch fader si le deck jouait. Tranche du jog ou mode vinyle coupé : nudge du POC. SHIFT + jog :
  recherche 4 fois plus rapide qu'un scratch. Le scénario `test/scenarios/scratch.mjs` le vérifie.
- `fx/` : une unité d'effets par deck (`fx/unit.js`), entre le filtre (après l'EQ) et le fader, entendue aussi en
  PFL et sur le VU-mètre du deck : 3 emplacements en série (effet, activation, paramètre principal 0..1) et un
  dosage dry/wet. Un emplacement coupé laisse passer le signal tel quel. Effets (`fx/effects.js`, nœuds Web Audio
  natifs) : écho (1/4, 1/2, 1 ou 2 temps, temps = 60 / (BPM × pitch), 500 ms sans BPM ; BPM de l'analyse du titre
  chargé, via `deck.setBpm()`), réverbe (convolution sur une réponse générée, paramètre = niveau), flanger
  (paramètre = profondeur), filtre résonant (passe-bas sous le centre, passe-haut au-dessus), bitcrusher (16 à 2
  bits, sans réduction de fréquence). À l'écran : bloc FX de chaque deck (`ui/fx.js`, actions `fx.mix`,
  `fx.<n>.effect`, `fx.<n>.on`, `fx.<n>.param`). Le scénario `test/scenarios/fx.mjs` le vérifie.
- `ui/*.js` (en-tête, mixer, decks, modes de pads, journal), assemblés par `app.js`, et `index.html` : interface ; chaque commande existe aussi à l'écran, la page marche sans platine.

Ajouter une commande de la platine : une ligne dans `INPUTS` de `mapping.js` et un `register()` dans le module
`ui/` concerné ; une LED : une ligne dans `LEDS` et un `led()`. Une action non enregistrée ne fait rien mais
apparaît dans le journal (`MIDI 94 07 7f → shift.play`).

## Limites connues

- Pas de keylock : le pitch change la tonalité (il faudrait un time-stretch en WASM).
- Scratch limité à la vitesse maximale du lecteur (±4) ; pas d'inertie au relâchement (pas de backspin) ; un
  scratch arrière jusqu'à 0 arrête la session de scratch.
- Sens du pitch fader non vérifié sur le matériel : case « pitch inversé » dans le mixer.
- Pas de sync, de hotcues ni de boucles. Grille à tempo constant seulement ; précision du BPM sur de la vraie
  musique non mesurée par le test (clics synthétiques).
- Pas de pilotage des effets par la platine.
