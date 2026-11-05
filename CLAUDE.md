# djing

Configuration reproductible pour mixer avec la Hercules DJControl Inpulse 300 MK2 sous Ubuntu avec Mixxx.
Tout ce qui est vrai du matériel et du logiciel est dans `README.md` : le lire avant d'agir.

## Stack

- Scripts Bash (`scripts/`), lintés par shellcheck. Configuration Mixxx dans `mixxx/`, fichier système dans
  `system/`. Côté platine, pas de dépendance autre que Mixxx (paquet Ubuntu) et les outils ALSA ; `make check`
  exige aussi `node` depuis l'arrivée des visuels.
- Visuels Ambilight dans `visuals/` : HTML + Canvas 2D ou WebGL 1 (GLSL ES 1.0, helper `gl-visual.js`) en ES5
  (navigateur de TV ; `make check` le vérifie), serveur d'analyse audio en Node 24 (`ws`, `npm install` dans
  `visuals/`), capture PipeWire par `pw-record`.
- Prose en français, code et commentaires en anglais, Conventional Commits en français (cadre du workspace).

## Règles

- Ne jamais modifier `~/.mixxx` sans sauvegarde : passer par `scripts/apply-mixxx-config.sh`, qui la fait.
- Ne pas lancer `apply` pendant que Mixxx tourne : il réécrit sa configuration en quittant.
- Tout ce qui exige `sudo` est laissé à l'utilisateur (`scripts/install-realtime.sh`).
- Les faits sur Mixxx (format des fichiers, noms de clés) se vérifient dans la branche `2.5` du dépôt
  `mixxxdj/mixxx`, pas de mémoire.

## Workflow agent

- **Mode** : poc.
- **Vérification** : `make check` (shellcheck + `bash -n`), puis `make hardware` si la platine est branchée.
- **Branches** : `issue/<n>-<slug>` sur `main`.
- **Fusion** : le mainteneur.
