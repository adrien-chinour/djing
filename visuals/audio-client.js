// audio-client.js — shared by the visuals.
// Connects to audio-server.js (session taken from ?s=<id>, from /s/<id> or /c/<id>/..., else local)
// and exposes smoothed, ready-to-use values.
// Falls back to a 160 BPM simulation when no audio arrives.
//
//   AudioFeed.update(dt)  call once per frame, returns the state below
//   state.live            true when real audio is flowing
//   state.level / low / mid / high   smoothed 0-1 (fast attack, slow release)
//   state.tone            smoothed 0-1 spectral balance (slow, for colour)
//   state.punch           0-1, jumps on each attack, decays in ≈0.3 s
//   state.hit             0.7-1 on the frame an attack arrives, 0 otherwise (to trigger one-off effects)
//   state.raw             last raw message (debug)
//   AudioFeed.session     session id
//   AudioFeed.onHello(msg) / onActive(visual) / onSource(on)   optional callbacks for the screen and control pages
(function (global) {
  var SIM_BPS = 160 / 60;

  var raw = null, lastMsgAt = 0, pendingOnset = 0;
  var state = { live: false, level: 0, low: 0, mid: 0, high: 0, tone: 0.5, punch: 0, hit: 0, raw: null };
  var simT = 0, simLastBeat = -1;

  function sessionId() {
    var m = /[?&]s=([0-9a-z]+)/.exec(location.search);
    if (m) return m[1];
    m = /^\/(s|c)\/([0-9a-z]+)/.exec(location.pathname);
    return m ? m[2] : 'local';
  }
  var session = sessionId();

  function connect() {
    var ws;
    // Served by audio-server.js itself: same host and port. Fallback for a file:// open.
    var host = location.protocol === 'file:' || !location.host ? 'localhost:8765' : location.host;
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    try { ws = new WebSocket(proto + host + '/ws?s=' + session + '&r=screen'); }
    catch (e) { setTimeout(connect, 3000); return; }
    ws.onmessage = function (e) {
      var msg = JSON.parse(e.data);
      if (msg.t === 'audio' || (msg.t === undefined && typeof msg.level === 'number')) {
        raw = msg;
        lastMsgAt = Date.now();
        // Latch onsets: the source sends ≈47 msg/s, a frame may see several or none
        if (raw.onset > pendingOnset) pendingOnset = raw.onset;
      } else if (msg.t === 'active') {
        if (feed.onActive) feed.onActive(msg.visual);
      } else if (msg.t === 'hello') {
        if (feed.onHello) feed.onHello(msg);
      } else if (msg.t === 'source') {
        if (feed.onSource) feed.onSource(msg.on);
      }
    };
    ws.onclose = function () { setTimeout(connect, 3000); };
  }

  // Frame-rate independent exponential smoothing toward target
  function follow(cur, target, dt, tauUp, tauDown) {
    var tau = target > cur ? tauUp : tauDown;
    return cur + (target - cur) * (1 - Math.exp(-dt / tau));
  }

  function simulate(dt) {
    simT += dt;
    var beat = simT * SIM_BPS, phase = beat % 1, bi = Math.floor(beat);
    var onset = 0;
    if (bi !== simLastBeat) { simLastBeat = bi; onset = bi % 4 === 0 ? 1 : 0.7; }
    var kick = Math.exp(-phase * 6);
    return {
      level: 0.45 + 0.3 * kick, low: 0.3 + 0.6 * kick,
      mid: 0.45 + 0.15 * Math.sin(beat * 0.7), high: 0.35 + 0.2 * Math.sin(beat * 1.9),
      tone: 0.5 + 0.35 * Math.sin(simT * 0.08), onset: onset
    };
  }

  function update(dt) {
    state.live = raw !== null && Date.now() - lastMsgAt < 1000;
    var src, onset;
    if (state.live) {
      src = raw;
      onset = pendingOnset;
      pendingOnset = 0;
    } else {
      src = simulate(dt);
      onset = src.onset;
    }

    state.level = follow(state.level, src.level, dt, 0.04, 0.35);
    state.low   = follow(state.low,   src.low,   dt, 0.03, 0.30);
    state.mid   = follow(state.mid,   src.mid,   dt, 0.05, 0.40);
    state.high  = follow(state.high,  src.high,  dt, 0.03, 0.25);
    state.tone  = follow(state.tone,  src.tone,  dt, 2.5,  2.5);   // colour drifts, never jumps

    // Punch only on detected attacks (not on a sustained level).
    // Every detected kick is at least 0.7 : a compressed mix gives weak raw
    // strengths, and the TV's Ambilight smooths out short or faint flashes.
    state.hit = onset > 0 ? 0.7 + 0.3 * onset : 0;
    if (state.hit > state.punch) state.punch = state.hit;
    state.punch *= Math.exp(-dt / 0.28);

    state.raw = state.live ? raw : null;
    return state;
  }

  var feed = { update: update, state: state, session: session, onHello: null, onActive: null, onSource: null };
  global.AudioFeed = feed;
  connect();
}(window));
