// AutoDJ (#53): plays the shown playlist on its own. The next track waits on the free deck; 10 s
// before the end of the track playing it starts, synced first when both tracks have a BPM, and the
// crossfader glides to it in 10 s. Stops after the last track; switched off at any time (AUTODJ on
// the controller, 0x90 0x03, or the screen button), the crossfader then stays where it is.
import { register, dispatch, led, onLed, refreshLeds } from '../actions.js';

const FADE_SECONDS = 10;
const TICK_MS = 50;

const $ = (sel) => document.querySelector(sel);

/** `load(deck, file, track)` is createDecks().load; `playlists.current` the playlist shown. */
export function createAutoDj(ctx, { load, playlists }) {
  const button = $('#autoDj');
  const status = $('#autoDjStatus');
  let library = new Map(); // track id -> track of the last library listing
  const loaded = [null, null]; // track of each deck
  let run = null; // { playlist, next, current, incoming, fade, timer, busy } while active

  const decks = () => ctx.engine.decks;
  const say = (text) => { status.textContent = text; };

  document.addEventListener('djing:library', ({ detail: { tracks } }) => {
    library = new Map(tracks.map((t) => [t.id, t]));
  });
  document.addEventListener('djing:load', ({ detail: { deck, track } }) => { loaded[deck] = track; });

  /** Loads the next readable item of the playlist on deck d; false when the playlist is over. */
  async function loadNext(d) {
    while (run && run.next < run.playlist.items.length) {
      const i = run.next++;
      const track = library.get(run.playlist.items[i]);
      if (track && !track.unreadable && (await load(d, track.file, track))) {
        if (run) say(`AutoDJ : titre ${i + 1} / ${run.playlist.items.length} sur le deck ${'AB'[d]}`);
        return true;
      }
    }
    return false;
  }

  /** The track of run.current plays: the next one waits on the other deck. */
  async function prepare() {
    const free = 1 - run.current;
    run.incoming = (await loadNext(free)) ? free : null;
    if (run && run.incoming === null) say('AutoDJ : dernier titre');
  }

  async function start() {
    if (!ctx.engine) return ctx.log('Démarrer l\'audio avant l\'AutoDJ');
    const playlist = playlists.current;
    if (!playlist?.items.length) return ctx.log('AutoDJ : choisir une playlist non vide');
    const playing = decks().filter((deck) => deck.playing).map((deck) => deck.index);
    // Deck playing: the playlist goes on after its track (from the top if it is not in it).
    const current = playing.length === 1 ? playing[0] : playing.length ? (ctx.engine.crossfader < 0.5 ? 0 : 1) : null;
    const at = current === null ? -1 : playlist.items.indexOf(loaded[current]?.id);
    run = { playlist, next: at + 1, current, incoming: null, fade: null, busy: true, timer: setInterval(tick, TICK_MS) };
    refreshLeds();
    if (current === null) {
      if (!(await loadNext(0))) return stop('AutoDJ : aucun titre lisible');
      if (!run) return;
      run.current = 0;
      dispatch('crossfader', null, 0);
      decks()[0].play();
      refreshLeds();
    }
    await prepare();
    if (run) run.busy = false;
  }

  function stop(text = 'AutoDJ arrêté') {
    if (!run) return;
    clearInterval(run.timer);
    run = null;
    say(text);
    refreshLeds();
  }

  /** Starts the transition to the incoming deck: sync when both tracks have a BPM, play, fade. */
  function transition() {
    const incoming = decks()[run.incoming];
    const sync = ctx.engine.sync;
    if (incoming.bpm && decks()[run.current].bpm && sync.follower !== run.incoming) {
      const error = sync.toggle(run.incoming);
      if (error) ctx.log(`AutoDJ : ${error}`);
    }
    incoming.play();
    run.fade = { from: ctx.engine.crossfader, to: run.incoming === 0 ? 0 : 1, start: performance.now() };
    refreshLeds();
  }

  async function tick() {
    if (!run || run.busy) return;
    const deck = decks()[run.current];
    if (run.fade) {
      const p = Math.min(1, (performance.now() - run.fade.start) / (FADE_SECONDS * 1000));
      dispatch('crossfader', null, run.fade.from + (run.fade.to - run.fade.from) * p);
      if (p < 1 || deck.playing) return;
      // Fade over and the outgoing track finished: the incoming deck is the current one.
      if (ctx.engine.sync.follower !== null) ctx.engine.sync.release();
      run.current = run.incoming;
      run.fade = null;
      run.busy = true;
      await prepare();
      if (run) run.busy = false;
      return;
    }
    if (run.incoming === null) {
      if (!deck.playing) stop('AutoDJ : fin de la playlist');
      return;
    }
    const left = (deck.duration - deck.position) / Math.max(deck.rate, 0.01);
    if (deck.playing && left <= FADE_SECONDS) transition();
  }

  register('autoDj', (_d, v) => {
    if (v <= 0) return;
    if (run) stop();
    else start().catch((err) => { stop(); ctx.log(`AutoDJ : ${err.message}`); });
  });
  led('autoDj', null, () => !!run);
  onLed((name, d, on) => {
    if (name === 'autoDj' && d === null) button.classList.toggle('on', on);
  });
  button.addEventListener('click', () => dispatch('autoDj', null, 1));
}
