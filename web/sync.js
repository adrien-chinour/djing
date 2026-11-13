// Tempo and phase sync of the two decks (#38). The main thread keeps the tempo: the follower's
// speed is the master's tempo over its own BPM. The phase is kept on the audio thread, by the
// follower's player (worklets/deck-player.js, followMaster()).

export const RATE_RANGES = [0.08, 0.16, 0.5];
const PICKUP_TOLERANCE = 0.01; // pitch fader within 1 % of its course of the synced value: taken over

const name = (d) => 'AB'[d];

export class Sync {
  constructor(engine) {
    this.engine = engine;
    this.leader = null; // master chosen with SHIFT + SYNC
    this.follower = null; // deck synced on the other one, null when no sync is active
    this.master = null; // its master
  }

  get decks() {
    return this.engine.decks;
  }

  /** Master of a sync of deck d: the SHIFT + SYNC choice, else the only deck playing, else the other deck. */
  masterFor(d) {
    if (this.leader !== null && this.leader !== d) return this.leader;
    const playing = this.decks.filter((deck) => deck.playing && deck.index !== d);
    if (playing.length === 1 && !this.decks[d].playing) return playing[0].index;
    return this.decks.find((deck) => deck.index !== d).index;
  }

  /** Master shown on screen: the one of the active sync, else the one a SYNC would take, if known. */
  get shownMaster() {
    if (this.follower !== null) return this.master;
    if (this.leader !== null) return this.leader;
    const playing = this.decks.filter((deck) => deck.playing);
    return playing.length === 1 ? playing[0].index : null;
  }

  /** SYNC on deck d: starts or stops its sync. Returns a message when the sync is impossible. */
  toggle(d) {
    if (this.follower === d) {
      this.release();
      return null;
    }
    if (this.leader === d) return `Deck ${name(d)} est le maître : SYNC sur l'autre deck`;
    const master = this.masterFor(d);
    const missing = [master, d].filter((i) => !this.decks[i].bpm).map(name);
    if (missing.length) return `Sync impossible : BPM inconnu sur le deck ${missing.join(' et ')}`;
    this.release();
    this.follower = d;
    this.master = master;
    this.decks[d].setSyncMaster(master);
    this.follow();
    return null;
  }

  /** SHIFT + SYNC on deck d: d becomes the master (again: no explicit master). */
  toggleLeader(d) {
    this.leader = this.leader === d ? null : d;
    if (this.leader === d && this.follower === d) this.release();
  }

  release() {
    if (this.follower === null) return;
    this.decks[this.follower].setSyncMaster(null);
    this.follower = null;
    this.master = null;
  }

  /** Follower speed = master tempo / follower BPM. */
  follow() {
    const f = this.decks[this.follower];
    const m = this.decks[this.master];
    if (!f.bpm || !m.bpm) return this.release();
    f.rate = (m.bpm * m.rate) / f.bpm;
    f.applySpeed();
    f.fx.retime();
  }

  /** Tempo or BPM of `deck` changed: the follower follows. */
  tempoChanged(deck) {
    if (this.follower !== null && (deck.index === this.master || deck.index === this.follower)) this.follow();
  }

  /**
   * Pitch fader of `deck` moved to v: true while it must be ignored, i.e. on the follower until it
   * reaches or crosses the synced value. Reaching it releases the sync: the fader takes over.
   */
  holdsFader(deck, v) {
    if (deck.index !== this.follower) return false;
    const synced = (deck.rate - 1) / deck.rateRange;
    if (Math.abs(v - synced) > PICKUP_TOLERANCE && (deck.pitch - synced) * (v - synced) > 0) return true;
    this.release();
    return false;
  }
}
