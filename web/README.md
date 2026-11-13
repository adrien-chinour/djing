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
- Un scénario par fichier dans `test/scenarios/` (`poc.mjs` : le scénario ci-dessus ; `beatgrid.mjs` : l'analyse du BPM ; `key.mjs` : la tonalité ; `library.mjs` : la
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
- Keylock et transposition (`engine.js`) : le lecteur lit à la vitesse du pitch, puis un nœud
  [Signalsmith Stretch](https://signalsmith-audio.co.uk/code/stretch/) (`vendor/signalsmith-stretch.js`, version
  1.3.2 du paquet npm `signalsmith-stretch`, licence MIT dans `vendor/signalsmith-stretch.LICENSE`, WASM embarqué)
  décale la hauteur : transposition (−12..+12 demi-tons) moins `12·log2(vitesse)` avec KEYLOCK. Boucles, sauts et
  scratch se font dans le lecteur, en amont. En marche arrière ou au-delà de ±50 % de vitesse, la compensation est
  retirée (la hauteur suit la vitesse). Sans keylock ni transposition, le son prend le chemin direct ; sinon il
  prend 120 ms de latence (« latence » sous le deck), que `deck.position` retranche (`deck.playhead` reste la
  position de lecture). Le scénario `test/scenarios/keylock.mjs` le vérifie.
- `library/` : base IndexedDB unique `djing` (`db.js`, une migration par version : magasins `tracks`, données par
  titre, `settings`, dont le dossier de musique, `cues` et `playlists`) et liste des titres d'un `FileSystemDirectoryHandle` (`scan.js`).
  Identifiant d'un titre : `<chemin relatif>|<taille>|<lastModified>`.
- `analysis/` : BPM et grille de chaque titre, calculés une fois. `queue.js` décode les titres un par un
  (`OfflineAudioContext` à 22 050 Hz, mono) et les passe au Web Worker `worker.js`, qui appelle `beat.js` :
  montée d'énergie log par fenêtres de 20 ms toutes les 1,5 ms, autocorrélation sur les tempos 70–180 BPM (le
  plus rapide l'emporte quand un multiple est aussi fort), affinage de la période, puis régression linéaire sur
  les pics d'onset de chaque temps. Résultat sous `analysis: { bpm, firstBeat }` dans `tracks` (`bpm: null` :
  « BPM inconnu », pas de grille) ; un titre qui l'a n'est plus analysé. Le deck affiche BPM et premier temps,
  corrigés par ÷2, ×2, −10 ms, +10 ms (actions `grid.*`). Le scénario `test/scenarios/beatgrid.mjs` le vérifie
  sur des pistes de clics et du bruit blanc.
- Tonalité (`analysis/key.js`, dans le même worker que le BPM) : chromagramme (trames de 8192 échantillons,
  fenêtre de Hann, 55 à 1760 Hz, magnitude moyenne par classe de hauteur), corrélé aux 24 profils de
  Krumhansl-Schmuckler (majeur et mineur), converti en notation Camelot (`8A` = la mineur, `8B` = do majeur).
  Sauvegardée sous `analysis.key` (`null` : chromagramme trop plat ou corrélation trop faible, affiché « ? ») ; un
  titre analysé avant la tonalité ne reçoit que sa tonalité, BPM et grille gardés. Une seule tonalité par titre.
  Affichée dans la colonne « Tonalité » de la bibliothèque et sous le deck. Le scénario `test/scenarios/key.mjs`
  le vérifie sur des suites d'accords synthétiques (la mineur, do majeur, fa dièse mineur) et du bruit blanc.
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
  `fx.<n>.effect`, `fx.<n>.on`, `fx.<n>.param`, `fx.<n>.next`, `fx.unit`). Le scénario `test/scenarios/fx.mjs` le vérifie.
- Effets à la platine (`mapping.js`, `ui/fx.js`, entrées `EffectRack1_EffectUnit*` de la table MIDI de Mixxx) : bouton
  FX (`0x91`/`0x92` `0x00`, LED) = emplacement 3 actif ou coupé, SHIFT + FX = effet suivant de l'emplacement 3 ;
  potentiomètres `0xB1`/`0xB2` `0x06` = paramètre de l'emplacement 3, `0x07` = dry/wet. Pads en mode FX
  (`0x96`/`0x97`) : `0x50` à `0x52` = emplacements 1 à 3 (LED), `0x53` = unité appliquée au deck ou retirée
  (signal sec ; LED, bouton « FX sur le deck » à l'écran), `0x54` à `0x56` = effet suivant des emplacements 1 à 3.
  Une unité par deck : `0x57` (l'unité de l'autre deck) et la page SHIFT `0x58` à `0x5F` (unités 3 et 4 de Mixxx)
  ne font rien. Le scénario `test/scenarios/fx-controller.mjs` le vérifie.
- Hotcues (`ui/hotcues.js`) : 8 par deck, sur les pads en mode hotcue (`0x96`/`0x97`, `0x00` à `0x07`) et sur 8
  boutons à l'écran. Un pad vide pose le hotcue à la position courante, un pad posé y saute sans changer lecture ou
  arrêt ; SHIFT + pad (`0x08` à `0x0F`), ou Maj + clic, l'efface. Q (`0x91`/`0x92` `0x02`, LED, bouton Q à l'écran)
  cale la pose sur le temps le plus proche de la grille du titre ; sans grille, pas de calage. LED du pad allumée
  quand le hotcue existe. Sauvegardés par identifiant de titre dans le magasin IndexedDB `cues` (`{ id, hotcues }`)
  et relus au chargement depuis la bibliothèque ; un fichier glissé sur le deck n'est pas sauvegardé. Le scénario
  `test/scenarios/hotcues.mjs` le vérifie.
- Boucles (`engine.js`, bornes dans le worklet) : LOOP IN (`0x09`) pose le début, LOOP OUT (`0x0A`) la fin et active
  la boucle, ou la quitte si elle est active (la lecture continue) ; LED LOOP IN allumée tant qu'une boucle est
  active. SHIFT + LOOP IN / OUT : longueur ÷2 / ×2 depuis le début, entre 1/32 et 64 temps (en secondes sans
  grille). Boutons à l'écran de 1/2 à 16 temps, qui exigent une grille : début au temps courant si QUANTIZE
  (`0x02`, bouton Q) est actif, sinon à la position. Le worklet recule de la longueur exacte de la boucle, avec le
  fondu de 5 ms d'un saut. Le scénario `test/scenarios/loops.mjs` le vérifie.
- Slicer (`ui/slicer.js`, comme `DJCi300.deck[n].slicerPad` du script Hercules de Mixxx) : modes SLICER
  (`0x91`/`0x92` `0x11`, pads `0x96`/`0x97` `0x20` à `0x27`) et SLICER LOOP (`0x15`, pads `0x60` à `0x67`). Appui sur
  le mode : fenêtre de 8 temps depuis le temps le plus proche de la position entendue, 8 tranches d'un temps ;
  nouvel appui sur SLICER ou SLICER LOOP pendant que le slicer tourne : il s'arrête (comme le script) ; autre mode :
  il s'arrête avec sa boucle. SLICER : pas de boucle, la fenêtre avance de 8 temps quand la lecture en sort ; SLICER
  LOOP : la fenêtre boucle. Pads tenus : boucle de la première à la dernière tranche tenue, saut à son début ;
  relâchés : retour à la fenêtre. LED : pads tenus, sinon la tranche en cours (suivie toutes les 20 ms). Un titre
  chargé ou une boucle posée par une autre commande (LOOP IN / OUT, boucles auto) l'arrête. Sans grille : inactif,
  « Slicer inactif : pas de grille » sous les pads. Taille de fenêtre fixe. Le scénario `test/scenarios/slicer.mjs`
  le vérifie.
- Sync (`sync.js`) : SYNC (`0x05`) cale le deck sur le maître, LED SYNC allumée tant que la synchro est active ;
  re-appui : elle s'arrête. Maître : celui choisi par SHIFT + SYNC (re-appui : plus de choix), sinon le seul deck en
  lecture, sinon l'autre deck ; « MAÎTRE » sous le deck. Tempo : vitesse du suiveur = BPM maître × vitesse maître ÷
  BPM suiveur, recalculée à chaque changement de tempo du maître. Phase : dans le worklet, le suiveur lit la position
  du maître au même quantum (les deux lecteurs partagent la portée du worklet) et compare les temps sur les
  positions entendues (compensées de la latence du keylock) ; au-delà de 20 ms d'écart il saute (fondu de 5 ms),
  en deçà il rattrape par un écart de vitesse d'au plus 2 %. Le pitch fader du suiveur est ignoré jusqu'à ce qu'il
  repasse par la valeur synchronisée ; il reprend alors la main et la synchro s'arrête. Sans BPM sur l'un des deux
  titres : « Sync impossible » sous le deck. SHIFT + Q : plage du pitch 8, 16, 50 % (défaut 8 %), le fader garde sa
  position. BPM affiché = BPM analysé × vitesse. Le scénario `test/scenarios/sync.mjs` le vérifie.
- Slip (`engine.js`, position fantôme dans le worklet) : SLIP (`0x91`/`0x92` `0x01`, LED, bouton SLIP à l'écran)
  active ou coupe le slip. Slip actif, un scratch (pas la recherche SHIFT + jog), une boucle ou un hotcue maintenu
  fait naître une position fantôme qui avance à la vitesse du deck hors scratch (pitch fader ou sync ; immobile deck arrêté) ; au relâchement
  du jog, à la sortie de boucle ou au relâchement du pad, la lecture y reprend, avec le fondu de 5 ms d'un saut.
  Slip actif, un hotcue n'agit que tant que le pad (ou le bouton à l'écran) est maintenu. Couper SLIP pendant un
  maintien abandonne la position fantôme. Le scénario `test/scenarios/slip.mjs` le vérifie.
- Roll et beatjump (`ui/rolls.js`, `engine.js`) : pads en mode roll (`0x96`/`0x97`, `0x10` à `0x17`) = boucle de
  1/8, 1/4, 1/2, 1, 2, 4, 8, 16 temps tant que le pad est maintenu (début calé sur le temps si Q), slip forcé même
  SLIP coupé : au relâchement, la lecture reprend à la position fantôme ; LED du pad allumée pendant le roll. Un
  autre pad pendant un roll en change la longueur ; couper SLIP pendant un roll garde sa position fantôme. Pads en
  mode beatjump (`0x70` à `0x77`) = −1, +1, −2, +2, −4, +4, −8, +8 temps, en lecture ou à l'arrêt. Les deux
  exigent une grille ; sans grille, rien ne bouge et « … impossible : pas de grille » s'affiche sous les pads.
  Boutons Roll (maintenus) et Beatjump à l'écran. Le scénario `test/scenarios/roll-beatjump.mjs` le vérifie.
- Playlists (`ui/playlists.js`, `library/playlists.js`) : panneau sous la bibliothèque. « Nouvelle », « Renommer »
  (nom saisi dans le panneau), « Supprimer » (confirmation dans le panneau). On y glisse les lignes de la
  bibliothèque (insertion à l'endroit du dépôt, un titre peut y figurer plusieurs fois), on réordonne en glissant
  ses lignes, « Retirer » enlève une ligne. Sauvegardées dans le magasin IndexedDB `playlists`
  (`{ id, name, items: [identifiant de titre…] }`) ; un titre absent du dernier listage du dossier reste listé,
  grisé « introuvable ». « Exporter M3U8 » : `#EXTM3U`, puis `#EXTINF:-1,Artiste - Titre` et le chemin relatif au
  dossier de la bibliothèque pour chaque titre, en UTF-8 sans BOM (fichier à poser à la racine du dossier). Le
  scénario `test/scenarios/playlists.mjs` le vérifie.
- Waveforms (`ui/waveform.js`) : par deck, une vue d'ensemble du titre entier (clic : saut) et une vue défilante
  centrée sur la position entendue (`deck.position`), de 2 à 32 temps visibles (défaut 8, boutons − et +, 120 BPM
  supposés sans grille). Pics de trois bandes (graves < 250 Hz en rouge, médiums en orange, aigus > 4 kHz en bleu)
  calculés une fois au chargement dans le Web Worker `ui/waveform-worker.js` (filtres 24 dB/octave, 172 pics
  par seconde) ; chaque image ne dessine que la fenêtre visible, en `requestAnimationFrame`. Lignes de temps de la
  grille, premier temps de chaque mesure (tous les 4 temps depuis `firstBeat`) plus marqué ; repères du point CUE,
  des hotcues, de la boucle active (zone) ou du dernier LOOP IN. Le scénario `test/scenarios/waveform.mjs` le
  vérifie en lisant les pixels des canvas.
- Toneplay (`ui/toneplay.js`, comme `DJCi300.toneplay` du script Hercules de Mixxx) : pads en mode toneplay
  (`0x96`/`0x97`, `0x40` à `0x47`) = saut au hotcue 1 et transposition de +0, +1, +2, +3, −4, −3, −2, −1 demi-tons ;
  SHIFT + pad (`0x48` à `0x4F`), ou Maj + clic sur les boutons Toneplay à l'écran, transpose sans sauter. Sans
  hotcue 1, le pad le pose à la position entendue (calé sur le temps si Q), puis agit. Le saut ne change ni lecture
  ni arrêt et ne maintient pas le slip. Keylock forcé (LED KEYLOCK allumée, réglage KEYLOCK inchangé) tant que la
  transposition posée par toneplay est en place : une autre commande de transposition y met fin. LED : le pad de
  la transposition courante, bornée à −4..+3 et arrondie, avec et sans SHIFT, quelle qu'en soit l'origine. Le
  scénario `test/scenarios/toneplay.mjs` le vérifie.
- AutoDJ (`ui/autodj.js`) : AUTODJ (`0x90` `0x03`, LED) ou le bouton « AutoDJ » du panneau Playlists enchaîne la
  playlist affichée. Aucun deck en lecture : premier titre sur A, crossfader sur A ; sinon la playlist reprend
  après le titre du deck en lecture (du début s'il n'y figure pas). Le titre suivant se charge sur le deck libre ;
  à 10 s de la fin du titre en cours (temps réel, vitesse comprise), il démarre, synchronisé d'abord si les deux
  titres ont un BPM, et le crossfader glisse en 10 s vers lui. Titre sortant fini : synchro relâchée, titre suivant
  chargé sur ce deck. Un titre introuvable ou illisible est sauté. Arrêt après le dernier titre ; re-appui :
  arrêt immédiat, crossfader et decks laissés tels quels. Le scénario `test/scenarios/autodj.mjs` le vérifie.
- `ui/*.js` (en-tête, mixer, decks, modes de pads, journal), assemblés par `app.js`, et `index.html` : interface ; chaque commande existe aussi à l'écran, la page marche sans platine.

Ajouter une commande de la platine : une ligne dans `INPUTS` de `mapping.js` et un `register()` dans le module
`ui/` concerné ; une LED : une ligne dans `LEDS` et un `led()`. Une action non enregistrée ne fait rien mais
apparaît dans le journal (`MIDI 94 07 7f → shift.play`).

## Limites connues

- Scratch limité à la vitesse maximale du lecteur (±4) ; pas d'inertie au relâchement (pas de backspin) ; un
  scratch arrière jusqu'à 0 arrête la session de scratch.
- Sens du pitch fader non vérifié sur le matériel : case « pitch inversé » dans le mixer.
- Boucles non sauvegardées ; un roll remplace la boucle active, qui n'est pas rétablie après. Beatjump : taille fixe, une boucle active ne suit pas le saut. Sync : un saut (boucle, hotcue), un scratch ou un nudge du maître est suivi
  par le suiveur ; un nudge du suiveur est annulé par la synchro. Grille à tempo constant seulement ; précision du BPM sur de la vraie
  musique non mesurée par le test (clics synthétiques).
- Effets : pas d'affectation d'une unité à l'autre deck (pad FX `0x57`), pas d'unités 3 et 4.
