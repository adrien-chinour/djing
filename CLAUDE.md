# dj-ubuntu

Configuration reproductible pour mixer avec la Hercules DJControl Inpulse 300 MK2 sous Ubuntu avec Mixxx.
Tout ce qui est vrai du matériel et du logiciel est dans `README.md` : le lire avant d'agir.

## Stack

- Scripts Bash (`scripts/`), lintés par shellcheck. Configuration Mixxx dans `mixxx/`, fichier système dans
  `system/`. Pas de dépendance autre que Mixxx (paquet Ubuntu) et les outils ALSA.
- Prose en français, code et commentaires en anglais, Conventional Commits en français (cadre du workspace).

## Règles

- Ne jamais modifier `~/.mixxx` sans sauvegarde : passer par `scripts/apply-mixxx-config.sh`, qui la fait.
- Ne pas lancer `apply` pendant que Mixxx tourne : il réécrit sa configuration en quittant.
- Tout ce qui exige `sudo` est laissé à l'utilisateur (`scripts/install-realtime.sh`).
- Les faits sur Mixxx (format des fichiers, noms de clés) se vérifient dans la branche `2.5` du dépôt
  `mixxxdj/mixxx`, pas de mémoire.

## Workflow agent

- **Vérification** : `make check` (shellcheck + `bash -n`), puis `make hardware` si la platine est branchée.
- **Branches** : `issue/<n>-<slug>` sur `main`.
- **Fusion** : le mainteneur.
