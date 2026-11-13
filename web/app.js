// Assembles the page: shared state, then the header, mixer and deck modules of web/ui/.
import { refreshLeds } from './actions.js';
import { createLog } from './ui/log.js';
import { createHeader } from './ui/header.js';
import { createMixer } from './ui/mixer.js';
import { createDecks } from './ui/decks.js';
import { createPads } from './ui/pads.js';
import { createHotcues } from './ui/hotcues.js';
import { createSlicer } from './ui/slicer.js';
import { createLibrary } from './ui/library.js';
import { createMeters } from './ui/meters.js';
import { createFx } from './ui/fx.js';

const ctx = {
  engine: null, // created by the "Démarrer l'audio" button
  rateInvert: true,
  log: createLog(document.querySelector('#log')),
};

const decks = createDecks(ctx);
createPads(ctx, decks.panels);
createHotcues(ctx, decks.panels);
createSlicer(ctx, decks.panels);
createFx(ctx, decks.panels);
createMixer(ctx);
createLibrary(ctx, decks.load);
const meters = createMeters(ctx);
createHeader(ctx, {
  onStart: () => {
    setInterval(decks.draw, 50);
    meters.start();
  },
});
refreshLeds();
