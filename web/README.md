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

## Tester sans la platine

- `make web-test` : test de bout en bout, sans matériel ni Mixxx. Il crée une platine simulée (port MIDI virtuel
  au nom de la platine), une sortie PipeWire 4 canaux qui tient lieu de carte son, la découpe avec
  `split-outputs.sh`, pilote Chrome headless, joue un titre depuis la platine simulée et mesure avec `pw-record`
  le son de chaque canal (MAIN, PFL, fader, crossfader), les LED reçues, le pitch et le jog. Tout ce qu'il crée
  est supprimé à la fin. Prérequis : `google-chrome`, PipeWire (`pw-cli`, `pw-dump`, `pw-record`,
  `pw-loopback`, `pw-link`), `uv`.
- Un scénario par fichier dans `test/scenarios/` (`poc.mjs` : le scénario ci-dessus). `make web-test` les lance
  tous, `make web-test SCENARIO=poc` un seul ; le code de sortie est non nul si un scénario échoue. Le sink et les
  sorties découpées sont partagés ; chaque scénario part d'une page rechargée et d'une platine simulée neuve. Un
  scénario exporte par défaut `async ({ page, sim, url }) => …` et vérifie avec `check()` ; les outils (sink,
  découpage, platine simulée, Chrome, mesure RMS par canal) sont dans `test/lib.mjs`.
- `make web-sim` : la platine simulée seule, pour jouer à la main avec la page. Une commande par ligne :
  `press A play`, `knob A volume 0.5`, `xfader 0`, `rate B 0.3`, `jog A 20 touched`, `pad A hotcue 1 shift`,
  `note 91 07 7f`, `cc b1 00 40`, `leds`… (liste en tête de
  `sim/controller.py`). Les LED que la page allume s'affichent en JSON.

que ne reçoit rien.
- « Bip MAIN » sonne dans les enceintes (440 Hz), « Bip casque » dans le casque seul (880 Hz).
- Les messages MIDI s'affichent dans le journal en bas quand on touche la platine.
- PLAY, CUE, PFL, volumes, EQ, gain, filtre, pitch, crossfader et jogs agissent sur les decks ; les LED PLAY, CUE
  et PFL suivent.

## Contenu

- `sim/controller.py` : platine simulée (MIDI). `test/e2e.mjs` : lanceur des scénarios de `test/scenarios/`,
  outils communs dans `test/lib.mjs`.
- `midi.js` : lecture des messages et LED ; numéros MIDI tirés de
  `mixxx/controllers/Hercules_DJControl_Inpulse_300_MK2.midi.xml`.
- `engine.js` : Web Audio, deux decks (gain, EQ 3 bandes, filtre, fader, PFL), crossfader à puissance constante,
  sortie en deux flux stéréo ou en 4 canaux discrets.
- `app.js`, `index.html` : interface ; chaque commande existe aussi à l'écran, la page marche sans platine.

## Limites connues

- Pas de keylock : le pitch change la tonalité (il faudrait un time-stretch en WASM).
- Pas de vrai scratch : le jog fait du nudge en lecture et du déplacement à l'arrêt ou touché.
- Sens du pitch fader non vérifié sur le matériel : case « pitch inversé » dans le mixer.
- Pas de BPM, de sync, de hotcues ni de boucles.
