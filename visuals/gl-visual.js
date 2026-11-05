// gl-visual.js — shared WebGL 1 runtime for the 3D visuals (ES5: TV browser).
// Depends on audio-client.js (AudioFeed).
//
//   GLVisual.start({
//     canvas: el,                 // the <canvas>
//     scale: 1,                   // 0.5 = half the pixels, CSS size unchanged (weak TV GPU)
//     vertex: src,                // optional GLSL ES 1.0 vertex shader; default = fullscreen quad
//     fragment: src,              // GLSL ES 1.0 fragment shader
//     depth: false,               // request a depth buffer
//     period: 64,                 // uDist wraps at this value (uHitDist follows); shaders must be periodic in it
//     setup: function (gl, prog) {},             // buffers of the visual, called after each (re)link
//     frame: function (gl, prog, audio, dt) {}   // draw; default = drawArrays of the quad
//   });
//
// Uniforms set every frame when the shader declares them:
//   uTime (s), uRes (px), uLevel, uLow, uMid, uHigh, uPunch, uHit, uTone (0-1, from AudioFeed),
//   uDist   distance travelled, integrated in JS from level + punch (speed changes never jump),
//           wrapped at period so that mediump GPUs (TV) keep their precision,
//   uHitDist value of uDist at the last kick (for shock waves travelling away from the camera).
//
// GLVisual.THERMO is a GLSL snippet defining vec3 thermo(float t): the 7-colour palette of
// corridor.html / sunburst.html (0 = cold blue, 1 = warm white). Prepend it to a fragment shader.
(function (global) {
  var QUAD_VS = 'attribute vec2 aPos; void main() { gl_Position = vec4(aPos, 0.0, 1.0); }';
  var UNIFORMS = ['uTime', 'uRes', 'uLevel', 'uLow', 'uMid', 'uHigh', 'uPunch', 'uHit', 'uTone', 'uDist', 'uHitDist'];

  var THERMO =
    'vec3 thermo(float t) {\n' +
    '  t = clamp(t, 0.0, 1.0) * 6.0;\n' +
    '  vec3 c0 = vec3(0.078, 0.157, 0.863);\n' +
    '  vec3 c1 = vec3(0.235, 0.039, 0.784);\n' +
    '  vec3 c2 = vec3(0.627, 0.039, 1.000);\n' +
    '  vec3 c3 = vec3(1.000, 0.118, 0.314);\n' +
    '  vec3 c4 = vec3(1.000, 0.431, 0.039);\n' +
    '  vec3 c5 = vec3(1.000, 0.784, 0.078);\n' +
    '  vec3 c6 = vec3(1.000, 0.961, 0.706);\n' +
    '  if (t < 1.0) return mix(c0, c1, t);\n' +
    '  if (t < 2.0) return mix(c1, c2, t - 1.0);\n' +
    '  if (t < 3.0) return mix(c2, c3, t - 2.0);\n' +
    '  if (t < 4.0) return mix(c3, c4, t - 3.0);\n' +
    '  if (t < 5.0) return mix(c4, c5, t - 4.0);\n' +
    '  return mix(c5, c6, t - 5.0);\n' +
    '}\n';

  // Shader errors and missing WebGL are shown on the page: there is no console on the TV.
  function showMessage(text) {
    var d = document.createElement('pre');
    d.style.cssText = 'position:absolute;left:0;top:0;max-width:100%;padding:24px;color:#aaa;' +
                      'font:16px/1.4 ui-monospace,monospace;white-space:pre-wrap;background:rgba(0,0,0,.7)';
    d.textContent = text;
    document.body.appendChild(d);
  }

  function getContext(canvas, depth) {
    var names = ['webgl', 'experimental-webgl'], gl = null, i;
    for (i = 0; i < names.length && !gl; i++) {
      try {
        gl = canvas.getContext(names[i], { alpha: false, antialias: false, depth: !!depth, preserveDrawingBuffer: false });
      } catch (e) { gl = null; }
    }
    return gl;
  }

  function compile(gl, type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error((type === gl.VERTEX_SHADER ? 'vertex' : 'fragment') + ' shader:\n' + gl.getShaderInfoLog(sh));
    }
    return sh;
  }

  function link(gl, vsSrc, fsSrc) {
    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('link: ' + gl.getProgramInfoLog(prog));
    return prog;
  }

  function start(opts) {
    var canvas = opts.canvas, scale = opts.scale || 1, period = opts.period || 0;
    var gl = getContext(canvas, opts.depth);
    if (!gl) { showMessage('WebGL indisponible sur ce navigateur.'); return null; }

    var prog = null, loc = {}, quad = null, lost = false;
    var time = 0, dist = 0, hitDist = -1000, last = Date.now();

    function build() {
      prog = link(gl, opts.vertex || QUAD_VS, opts.fragment);
      gl.useProgram(prog);
      loc = {};
      for (var i = 0; i < UNIFORMS.length; i++) loc[UNIFORMS[i]] = gl.getUniformLocation(prog, UNIFORMS[i]);
      if (!opts.vertex) {
        quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        var aPos = gl.getAttribLocation(prog, 'aPos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
      }
      if (opts.setup) opts.setup(gl, prog);
    }

    function resize() {
      canvas.width  = Math.max(1, Math.round(innerWidth  * scale));
      canvas.height = Math.max(1, Math.round(innerHeight * scale));
      gl.viewport(0, 0, canvas.width, canvas.height);
    }

    try { build(); } catch (e) { showMessage('Shader refusé.\n' + e.message); return null; }
    resize();
    window.addEventListener('resize', resize, { passive: true });

    canvas.addEventListener('webglcontextlost', function (e) { e.preventDefault(); lost = true; }, false);
    canvas.addEventListener('webglcontextrestored', function () {
      try { build(); resize(); lost = false; } catch (e) { showMessage('Shader refusé après restauration.\n' + e.message); }
    }, false);

    function set1(name, v) { if (loc[name]) gl.uniform1f(loc[name], v); }

    function frame() {
      requestAnimationFrame(frame);
      if (lost) return;
      var now = Date.now(), dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      time += dt;

      var a = global.AudioFeed.update(dt);
      dist += dt * (0.6 + a.level + a.punch);
      if (a.hit > 0) hitDist = dist;
      if (period && dist >= period) { dist -= period; hitDist -= period; }

      set1('uTime', time);
      if (loc.uRes) gl.uniform2f(loc.uRes, canvas.width, canvas.height);
      set1('uLevel', a.level); set1('uLow', a.low); set1('uMid', a.mid); set1('uHigh', a.high);
      set1('uPunch', a.punch); set1('uHit', a.hit); set1('uTone', a.tone);
      set1('uDist', dist); set1('uHitDist', hitDist);

      if (opts.frame) opts.frame(gl, prog, a, dt);
      else gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    requestAnimationFrame(frame);

    return { gl: gl, canvas: canvas };
  }

  global.GLVisual = { start: start, THERMO: THERMO };
}(window));
