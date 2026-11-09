// deck.js — the "DJ software" view shared by the session page (start.html) and the control page.
// Vertical band meters with peak hold, kick LED, BPM estimated from the kicks, a scrolling strip of
// the levels drawn like a waveform overview, the scene on air, and the session statistics.
//
//   var deck = Deck.mount(container);
//   deck.update(dt, { level, low, mid, high, hit, live })   once per frame ; hit > 0 on the frame of a kick
//   deck.setScene(name) ; deck.setStats({ since, screens, switches, rate, source })
(function (global) {
  var BANDS = ['level', 'low', 'mid', 'high'];
  var LABELS = { level: 'niveau', low: 'grave', mid: 'médium', high: 'aigu' };
  var STRIP_SECONDS = 8;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function duration(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return (h ? h + ':' + pad2(m) : m) + ':' + pad2(s % 60);
  }

  function mount(container) {
    var root = el('div', 'deck');
    container.appendChild(root);

    // Meters
    var meters = el('div', 'deck-meters'), fill = {}, peak = {}, peakVal = {}, peakAt = {};
    BANDS.forEach(function (b) {
      var m = el('div', 'vmeter');
      var track = el('div', 'track');
      fill[b] = el('i', 'fill'); peak[b] = el('i', 'peak');
      track.appendChild(fill[b]); track.appendChild(peak[b]);
      m.appendChild(track); m.appendChild(el('span', null, LABELS[b]));
      meters.appendChild(m);
      peakVal[b] = 0; peakAt[b] = 0;
    });

    // Tempo, LED, scene
    var mid = el('div', 'deck-mid');
    var bpmBox = el('div', 'bpm'), bpmNum = el('b', null, '—'), bpmLabel = el('small', null, 'BPM');
    bpmBox.appendChild(bpmNum); bpmBox.appendChild(bpmLabel);
    var led = el('div', 'led'); led.title = 'kick';
    var sceneBox = el('div', 'onair'), sceneName = el('b', null, '—'), sceneLabel = el('small', null, 'à l\'écran');
    sceneBox.appendChild(sceneLabel); sceneBox.appendChild(sceneName);
    mid.appendChild(bpmBox); mid.appendChild(led); mid.appendChild(sceneBox);

    // Strip
    var strip = el('canvas', 'deck-strip');
    var ctx = strip.getContext('2d');
    var hist = [], histT = 0;

    // Stats
    var stats = el('dl', 'deck-stats');
    var statEl = {};
    [['since', 'durée'], ['screens', 'écrans'], ['kicks', 'kicks'], ['switches', 'scènes'], ['rate', 'mesures/s']].forEach(function (p) {
      var box = el('div', 'stat'), dt = el('dt', null, p[1]), dd = el('dd', null, '—');
      box.appendChild(dt); box.appendChild(dd); stats.appendChild(box);
      statEl[p[0]] = dd;
    });

    root.appendChild(meters); root.appendChild(mid); root.appendChild(strip); root.appendChild(stats);

    var kicks = 0, kickTimes = [], ledUntil = 0, since = null, state = { live: false };

    function bpm() {
      var iv = [], i;
      for (i = 1; i < kickTimes.length; i++) {
        var d = kickTimes[i] - kickTimes[i - 1];
        if (d >= 0.3 && d <= 0.86) iv.push(d);   // 70-200 BPM; longer gaps are breaks, not beats
      }
      if (iv.length < 4) return null;
      iv.sort(function (a, b) { return a - b; });
      return Math.round(60 / iv[Math.floor(iv.length / 2)]);
    }

    var now = 0;
    function update(dt, s) {
      now += dt;
      state = s;
      BANDS.forEach(function (b) {
        var v = Math.max(0, Math.min(1, s[b] || 0));
        fill[b].style.height = (v * 100).toFixed(1) + '%';
        if (v >= peakVal[b]) { peakVal[b] = v; peakAt[b] = now; }
        else if (now - peakAt[b] > 0.8) peakVal[b] = Math.max(v, peakVal[b] - dt * 0.6);
        peak[b].style.bottom = (peakVal[b] * 100).toFixed(1) + '%';
      });
      if (s.hit > 0) {
        kicks++;
        kickTimes.push(now);
        if (kickTimes.length > 16) kickTimes.shift();
        ledUntil = now + 0.12;
      }
      led.className = 'led' + (now < ledUntil ? ' on' : '') + (s.live ? '' : ' off');
      var tempo = s.live ? bpm() : null;
      bpmNum.textContent = tempo ? String(tempo) : '—';
      statEl.kicks.textContent = String(kicks);
      if (since !== null) statEl.since.textContent = duration(Date.now() - since);

      // History at ~30 points per second
      histT += dt;
      if (histT >= 1 / 30) {
        histT = 0;
        hist.push({ level: s.level || 0, low: s.low || 0, mid: s.mid || 0, high: s.high || 0, kick: s.hit > 0 || (now - ledUntil < 0 && now - ledUntil > -0.12) });
        if (hist.length > STRIP_SECONDS * 30) hist.shift();
        draw();
      }
    }

    function draw() {
      var w = strip.width = strip.clientWidth, h = strip.height = strip.clientHeight;
      if (!w || !h) return;
      ctx.clearRect(0, 0, w, h);
      var n = STRIP_SECONDS * 30, step = w / n, mid = h / 2, i, p, x;
      // Three layers, mirrored around the middle like a waveform overview: low (amber), mid, high.
      var layers = [['low', 'rgba(255,180,84,.85)'], ['mid', 'rgba(127,216,234,.7)'], ['high', 'rgba(201,160,255,.6)']];
      layers.forEach(function (L) {
        ctx.fillStyle = L[1];
        ctx.beginPath();
        for (i = 0; i < hist.length; i++) {
          x = w - (hist.length - i) * step; p = hist[i][L[0]] * (mid - 2);
          if (i === 0) ctx.moveTo(x, mid - p); else ctx.lineTo(x, mid - p);
        }
        for (i = hist.length - 1; i >= 0; i--) {
          x = w - (hist.length - i) * step; p = hist[i][L[0]] * (mid - 2);
          ctx.lineTo(x, mid + p);
        }
        ctx.closePath(); ctx.fill();
      });
      ctx.fillStyle = 'rgba(255,210,138,.9)';
      for (i = 0; i < hist.length; i++) if (hist[i].kick) ctx.fillRect(w - (hist.length - i) * step, 0, 1.5, h);
      ctx.fillStyle = 'rgba(242,237,228,.25)';
      ctx.fillRect(0, mid, w, 1);
    }

    function setScene(name) { sceneName.textContent = name || '—'; }

    function setStats(o) {
      if (o.since !== undefined) since = o.since;
      if (o.screens !== undefined) statEl.screens.textContent = String(o.screens);
      if (o.switches !== undefined) statEl.switches.textContent = String(o.switches);
      if (o.rate !== undefined) statEl.rate.textContent = o.rate === null ? '—' : String(o.rate);
    }

    return { update: update, setScene: setScene, setStats: setStats, root: root, kicks: function () { return kicks; } };
  }

  global.Deck = { mount: mount };
}(window));
