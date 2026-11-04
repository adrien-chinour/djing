# dj-ubuntu

Mixer avec la platine **Hercules DJControl Inpulse 300 MK2** directement sur ce portable Ubuntu, avec
**Mixxx**, au lieu de passer par le Mac Mini et DJUCED. Ce dépôt contient la configuration et les scripts
qui rendent l'installation reproductible.

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
   casque sur 3-4) avec le bon numéro de carte, et active le mapping Hercules dans `mixxx.cfg`.

4. Vérifier :

   ```sh
   make hardware
   ```

   Tout doit être `[OK]`. Lancer Mixxx ensuite et contrôler dans *Préférences > Matériel audio* (périphérique
   `DJControl Inpulse 300 Mk2: USB Audio`) et *Préférences > Contrôleurs* (platine activée, mapping
   « Hercules DJControl Inpulse 300 »).

## Sortie sur le PC (sans les enceintes)

Pour mixer avec le son du portable, la platine ne servant que de contrôleur, Mixxx fermé :

```sh
make apply-pc
```

Le Master part alors dans le périphérique ALSA `pipewire`, donc sur la sortie par défaut du système
(haut-parleurs, casque Bluetooth…), en 48 kHz, en cohabitant avec les autres applications. La latence est
plus haute qu'en direct, acceptable pour s'entraîner. Pas de sortie casque dans ce mode : la pré-écoute passe
par le Master. Revenir aux enceintes branchées sur la platine : `make apply`.

Même chose à la main, Mixxx ouvert : *Préférences > Matériel audio*, API `ALSA`, Master → `pipewire`.

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

Les morceaux sont sur le Mac Mini. Mixxx ne lit pas la base DJUCED : copier les fichiers audio dans
`~/Musique` (ou un disque), puis *Préférences > Bibliothèque > Ajouter* et laisser l'analyse (BPM, grille,
tonalité) tourner une fois. Les cues DJUCED ne sont pas récupérables.

## Dépannage

- `make hardware` dit `[KO] rtprio limit is 0` après `install-realtime.sh` : il faut une nouvelle session
  (déconnexion/reconnexion, pas seulement un nouveau terminal).
- Mixxx ne trouve pas la carte : vérifier `cat /proc/asound/cards`, relancer `make apply` si le numéro
  `hw:N` a changé (autre périphérique USB audio branché avant la platine).
- Pas de son mais Mixxx joue : la carte est peut-être tenue par PipeWire (`wpctl status`), couper ce qui
  joue dessus ; à défaut, `pw-cli` ou une règle WirePlumber qui désactive la carte.
- Retour arrière complet : restaurer les fichiers du dernier `~/.mixxx/backup-*/`, supprimer
  `/etc/security/limits.d/99-audio-realtime.conf`, `sudo gpasswd -d adrien audio`.

## Références

- [Mixxx : Hercules DJControl Inpulse 300](https://manual.mixxx.org/2.5/en/hardware/controllers/hercules_djcontrol_inpulse_300)
- [DJing on Ubuntu with Hercules](https://discourse.ubuntu.com/t/djing-on-ubuntu-with-hercules-a-celebration-of-open-source-software/47194)
- [Mixxx wiki : Adjusting Audio Latency](https://github.com/mixxxdj/mixxx/wiki/Adjusting-Audio-Latency)
