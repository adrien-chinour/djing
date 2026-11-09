# djing web (POC)

Logiciel de mix dans le navigateur, piloté par la Hercules DJControl Inpulse 300 MK2. But du POC : vérifier que
Chrome sait lire la platine (Web MIDI) et sortir le MAIN sur les canaux 1-2 et le casque sur les canaux 3-4 de sa
carte son, sans Mixxx.

## Lancer

1. Fermer Mixxx (il garde le port MIDI et la carte son).
2. Brancher la platine.
3. `make web`, puis ouvrir <http://localhost:8800> dans **Chrome ou Edge** (Web MIDI et `AudioContext.setSinkId`).
4. Cliquer « Démarrer l'audio » et accepter l'accès MIDI.
5. Si la liste des sorties n'a pas de noms, cliquer « Noms des sorties » (Chrome ne les donne qu'après une
   autorisation micro), puis choisir la sortie de la platine.

## Ce qu'il faut vérifier

- Pastille « sortie » verte : 4 canaux. Orange : stéréo seulement, le casque ne reçoit rien.
- « Bip MAIN » sonne dans les enceintes (440 Hz), « Bip casque » dans le casque seul (880 Hz).
- Les messages MIDI s'affichent dans le journal en bas quand on touche la platine.
- PLAY, CUE, PFL, volumes, EQ, gain, filtre, pitch, crossfader et jogs agissent sur les decks ; les LED PLAY, CUE
  et PFL suivent.

Si la sortie reste en stéréo, passer la carte en profil « Pro Audio » (`pavucontrol`, onglet Configuration) et
recharger la page.

## Contenu

- `midi.js` : lecture des messages et LED ; numéros MIDI tirés de
  `mixxx/controllers/Hercules_DJControl_Inpulse_300_MK2.midi.xml`.
- `engine.js` : Web Audio, deux decks (gain, EQ 3 bandes, filtre, fader, PFL), crossfader à puissance constante,
  sortie 4 canaux discrets.
- `app.js`, `index.html` : interface ; chaque commande existe aussi à l'écran, la page marche sans platine.

## Limites connues

- Pas de keylock : le pitch change la tonalité (il faudrait un time-stretch en WASM).
- Pas de vrai scratch : le jog fait du nudge en lecture et du déplacement à l'arrêt ou touché.
- Sens du pitch fader non vérifié sur le matériel : case « pitch inversé » dans le mixer.
- Pas de BPM, de sync, de hotcues ni de boucles.
