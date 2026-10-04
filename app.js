(function () {
  "use strict";

  // ---------------------------------------------------------------------------
  // Look. Dot color and radius come from the kepler.gl config the original RJ
  // map was made with (color [139,87,79], radius 3). kepler scales its radius
  // before drawing; 1/3 matches its rendered dot size, measured against the
  // reference screenshots. Radius is in CSS pixels.
  // The palette lives in app.css (:root); the dots and the histogram read it
  // from there, so one place sets every color. The stylesheet comes before
  // this script, so it is applied by now.
  var palette = getComputedStyle(document.documentElement);
  function token(name, fallback) { return palette.getPropertyValue(name).trim() || fallback; }
  var DOT_COLOR = token("--ember-raw", "139, 87, 79").split(",").map(Number);
  var LIT_BAR = token("--ember", "#d9a99f");
  // Unlit bars are the dot color itself, dimmed: a light switched off, not a gray.
  var DIM_BAR = "rgb(" + DOT_COLOR.join(",") + ")";
  var BASE_RADIUS = 3 / 3;
  var TILT = 50;
  var TILT_ZOOM_OUT = 0.45;
  var MAX_ZOOM = 15;

  // Linha do tempo: the slider runs over the year an establishment opened.
  // Files store it as years since 1900 (older openings are floored there); the
  // newest in the Receita snapshot is 2025, which is where the slider rests.
  // Zooming into the Brasil sample (a fraction of the points) opens the state
  // under the centre of the screen at its full density, as if its tile had been
  // clicked, and panning on into a neighbour opens that one.
  var DETAIL_ZOOM = 7;
  var PREFETCH_ZOOM = 5.5;

  var TL_MIN = 1900;
  var TL_MAX = 2025;

  // Zoom-driven light. A dot keeps its screen size while the points spread 2x
  // per zoom level, so how many dots pile onto one pixel, and therefore how
  // fast additive light burns to white, depends on the ABSOLUTE zoom, the same
  // over any city in any state. Keyframes tuned by eye on RJ (dense metro plus
  // sparse interior):
  //
  //   zoom   light   tamanho   what it should look like
  //   <= 3   0.08    0.60      the whole country (only BR zooms out this far):
  //                            bright coast, the interior a sprinkle of towns
  //      6   0.25    0.60      whole state: cities white, the interior a warm
  //                            sprinkle (lower light loses the small towns)
  //      8   0.06    0.50      from an airplane: hot cores, warm halos; any
  //                            more light and the metro burns into a blob
  //     10   0.20    0.40      the street grid shows through the glow
  //     13   2.00    0.35      each establishment a sharp street-lamp pinpoint
  //     15   2.50    0.35      same, isolated lamps
  //
  // light sets opacidade (capped at 1); the per-dot alpha before additive
  // blending is opacidade * brilho, and brilho has its own curve (BRIGHT_KEYS).
  // Light is not monotonic: past the state view it dips so dense metros keep
  // their gradient, then climbs back as the dots separate. It is interpolated
  // geometrically (light is read as ratios, and density falls 4x per zoom
  // level); tamanho linearly, shrinking as you descend so
  // dots stay crisp instead of merging.
  var ZOOM_KEYS = [
    { z: 3, light: 0.08, size: 0.6 },
    { z: 6, light: 0.25, size: 0.6 },
    { z: 8, light: 0.06, size: 0.5 },
    { z: 10, light: 0.2, size: 0.4 },
    { z: 13, light: 2.0, size: 0.35 },
    { z: 15, light: 2.5, size: 0.35 },
  ];

  // brilho has its own curve, independent of light: nearly off from afar
  // (<= 4), waking through the state view (7) and at least 1.4 from 8 down.
  // opacidade still follows light (capped at 1).
  var BRIGHT_KEYS = [
    { z: 4, v: 0.03 },
    { z: 7, v: 0.42 },
    { z: 8, v: 1.4 },
    { z: 15, v: 1.75 },
  ];

  var NAMES = {
    BR: "Brasil", AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia",
    CE: "Ceará", DF: "Distrito Federal", ES: "Espírito Santo", GO: "Goiás",
    MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul", MG: "Minas Gerais",
    PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí",
    RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul",
    RO: "Rondônia", RR: "Roraima", SC: "Santa Catarina", SP: "São Paulo",
    SE: "Sergipe", TO: "Tocantins",
  };

  // [column, row, rows tall] in a 7x8 grid, roughly where each state sits on
  // the map. BA takes two rows so SE (north of its coast) and ES (south of it)
  // can both touch it without touching each other.
  var TILE_GRID = {
    RR: [1, 0], AP: [3, 0],
    AM: [1, 1], PA: [2, 1], MA: [3, 1], CE: [4, 1], RN: [5, 1],
    AC: [0, 2], RO: [1, 2], MT: [2, 2], TO: [3, 2], PI: [4, 2], PE: [5, 2], PB: [6, 2],
    MS: [2, 3], GO: [3, 3], BA: [4, 3, 2], AL: [5, 3],
    DF: [3, 4], SE: [5, 4],
    SP: [2, 5], MG: [3, 5], ES: [4, 5],
    PR: [2, 6], RJ: [3, 6],
    RS: [1, 7], SC: [2, 7],
  };

  // [lng, lat] of each state capital, where a first visit lands when the
  // visitor's IP places them in that state.
  var CAPITALS = {
    AC: [-67.8243, -9.9747], AL: [-35.735, -9.6658], AP: [-51.0694, 0.0349],
    AM: [-60.0217, -3.119], BA: [-38.5014, -12.9718], CE: [-38.5267, -3.7319],
    DF: [-47.8825, -15.7942], ES: [-40.3377, -20.3155], GO: [-49.2643, -16.6869],
    MA: [-44.3028, -2.5297], MT: [-56.0974, -15.6014], MS: [-54.6295, -20.4697],
    MG: [-43.9378, -19.9208], PA: [-48.4902, -1.4558], PB: [-34.8631, -7.1195],
    PR: [-49.2733, -25.4284], PE: [-34.877, -8.0476], PI: [-42.8034, -5.092],
    RJ: [-43.1729, -22.9068], RN: [-35.2094, -5.7945], RS: [-51.2177, -30.0346],
    RO: [-63.9004, -8.7612], RR: [-60.6758, 2.8235], SC: [-48.5482, -27.5954],
    SP: [-46.6333, -23.5505], SE: [-37.0731, -10.9472], TO: [-48.3336, -10.1844],
  };
  // CNAE 2.0 sections, A..U, in the order of the masks the extractor writes
  // (scripts/repack.py, write_setores). Short names for a ~220 px select.
  var SECTORS = [
    "Agropecuária", "Indústria extrativa", "Indústria", "Eletricidade e gás",
    "Água, esgoto e resíduos", "Construção", "Comércio", "Transporte",
    "Alojamento e alimentação", "Informação e comunicação", "Finanças e seguros",
    "Imobiliário", "Profissionais e científicas", "Serviços administrativos",
    "Administração pública", "Educação", "Saúde e assistência", "Artes, cultura e esporte",
    "Outros serviços", "Serviços domésticos", "Organismos internacionais",
  ];
  var SECTOR_LETTERS = "ABCDEFGHIJKLMNOPQRSTU";

  // CNEFE address kinds (tipo_especie 1..8), in the order of the bits the
  // extractor writes.
  var KINDS = [
    "Domicílio particular", "Domicílio coletivo", "Agropecuário", "Ensino",
    "Saúde", "Outras finalidades", "Em construção", "Religioso",
  ];

  var CAPITAL_ZOOM = 11; // on the REF_SIDE reference screen, like the URL
  var GEO_TIMEOUT = 1500;

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Phones and tablets: less memory to keep decoded states in, and a fill
  // rate that a 3x screen would spend on pixels nobody can tell apart.
  var lowMemory = (navigator.deviceMemory || 8) <= 4 || window.matchMedia("(pointer: coarse)").matches;
  var MAX_PIXEL_RATIO = 2;
  var numberFormat = window.Intl ? new Intl.NumberFormat("pt-BR") : null;
  var fmt = function (n) { return numberFormat ? numberFormat.format(n) : String(n); };
  var $ = function (id) { return document.getElementById(id); };

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  // Light and dot size for an absolute zoom, from ZOOM_KEYS.
  function zoomCurve(z) {
    var k = ZOOM_KEYS;
    if (z <= k[0].z) return { light: k[0].light, size: k[0].size };
    for (var i = 1; i < k.length; i++) {
      if (z <= k[i].z) {
        var a = k[i - 1], b = k[i], t = (z - a.z) / (b.z - a.z);
        return {
          light: a.light * Math.pow(b.light / a.light, t),
          size: a.size + (b.size - a.size) * t,
        };
      }
    }
    var last = k[k.length - 1];
    return { light: last.light, size: last.size };
  }

  // brilho for an absolute zoom, from BRIGHT_KEYS, interpolated geometrically.
  function brightCurve(z) {
    var k = BRIGHT_KEYS;
    if (z <= k[0].z) return k[0].v;
    for (var i = 1; i < k.length; i++) {
      if (z <= k[i].z) {
        var a = k[i - 1], b = k[i];
        return a.v * Math.pow(b.v / a.v, (z - a.z) / (b.z - a.z));
      }
    }
    return k[k.length - 1].v;
  }

  // ---------------------------------------------------------------------------
  // State

  var meta = null;
  var map = null;
  var points = null;       // the map layer that draws the dots
  var current = null;      // uf whose points are on screen
  var requested = null;    // uf the user last asked for
  var tilted = true;
  var fade = 1;            // 0..1 ramp applied to the gain when points arrive
  var fadeFrom = null;     // uf whose points fade out as `current` fades in

  // Decoded point sets, so going back to a state is instant. Keeps the few
  // most recent; BR stays because it is the home view.
  var cache = new Map();
  var CACHE_MAX = lowMemory ? 2 : 4;

  function remember(uf, data) {
    cache.delete(uf);
    cache.set(uf, data);
    while (cache.size > CACHE_MAX) {
      var oldest = null;
      cache.forEach(function (_, k) { if (!oldest && k !== "BR" && k !== uf) oldest = k; });
      if (!oldest) break;
      cache.delete(oldest);
      if (points) points.forget(oldest);
    }
  }

  // ---------------------------------------------------------------------------
  // Loading

  // Versioned so a cached worker never pairs with a newer app.js (GitHub
  // Pages caches for 10 min). Bump together with the ?v= in index.html.
  var WORKER_URL = "worker.js?v=9";
  var worker = new Worker(WORKER_URL);
  var nextId = 0;
  var pending = {};

  var levelsFor = {};   // request id -> uf, for the levels that follow the points

  worker.onmessage = function (e) {
    var d = e.data;
    if (d.levels) {
      var target = cache.get(levelsFor[d.id]);
      delete levelsFor[d.id];
      if (target) {
        target.levels = d.levels;
        if (points) points.refresh();
      }
      return;
    }
    var p = pending[d.id];
    if (!p) return;
    if (d.progress !== undefined) { p.onProgress(d.progress); return; }
    delete pending[d.id];
    if (d.ok) p.resolve(d);
    else p.reject(new Error(d.error));
  };

  // The download in flight, so the boot can start it before the map exists and
  // select() picks it up instead of starting over.
  var inflight = null;

  function loadPoints(uf, onProgress) {
    if (cache.has(uf)) return Promise.resolve(cache.get(uf));
    if (inflight && inflight.uf === uf) {
      // Started earlier (a hover, the boot): pick the bar up where it is.
      inflight.onProgress = onProgress;
      if (onProgress && inflight.frac !== undefined) onProgress(inflight.frac);
      return inflight.promise;
    }
    // A new request supersedes any in flight (the worker aborts it).
    pending = {};
    var id = ++nextId;
    var url = new URL("data/" + uf.toLowerCase() + ".bin.gz", location.href).href;
    var job = { uf: uf, onProgress: onProgress };
    job.promise = new Promise(function (resolve, reject) {
      pending[id] = {
        resolve: resolve,
        reject: reject,
        onProgress: function (f) { job.frac = f; if (job.onProgress) job.onProgress(f); },
      };
      worker.postMessage({ id: id, url: url });
    }).then(function (pts) {
      if (inflight === job) inflight = null;
      var data = {
        uf: uf, n: pts.n, positions: pts.positions, origin: pts.origin, q: pts.q, levels: [],
        years: pts.years, hist: pts.hist, hasYears: pts.hasYears, boxes: pts.boxes, chunk: pts.chunk,
        firstYear: null,
        // The sector filter's view of it, see filterData(): all of it here.
        histAll: pts.hist, nView: pts.n, view: null, setores: null, especies: null,
      };
      remember(uf, data);
      levelsFor[pts.id] = uf;
      return data;
    }, function (err) {
      if (inflight === job) inflight = null;
      throw err;
    });
    inflight = job;
    return job.promise;
  }

  // The loader stays up for the whole change of place, flight included, and
  // fades out as the place's lights come on. The bar fills with the download
  // only; frac null (cached, decoding, still flying) sweeps instead, so it
  // never sits at 100% while there is still a wait.
  var progressTimer = 0;

  function showProgress(label, frac) {
    var el = $("progress");
    clearTimeout(progressTimer);
    el.hidden = false;
    el.classList.remove("out");
    el.classList.toggle("busy", frac === null);
    $("progress-fill").style.width = frac === null ? "" : Math.round(frac * 100) + "%";
    $("progress-text").textContent = frac === null ? label : label + " " + Math.round(frac * 100) + "%";
  }

  function hideProgress(now) {
    var el = $("progress");
    clearTimeout(progressTimer);
    if (now || reduceMotion) { el.hidden = true; return; }
    el.classList.add("out");
    progressTimer = setTimeout(function () { el.hidden = true; }, 700);
  }

  // ---------------------------------------------------------------------------
  // Layer

  // The dots are drawn by a small MapLibre custom layer: one GL point per
  // establishment, straight into the map's own canvas. deck.gl's
  // ScatterplotLayer drew the same picture but ran at ~3 fps on SP's 3.3M dots
  // (an M4, Chrome); plain GL points draw it >10x faster.
  //
  // It reproduces ScatterplotLayer's dot exactly:
  // - a camera-facing disc of radius R CSS pixels (kepler's look; flat discs
  //   would smear into ellipses under the tilt),
  // - antialiased by smoothstep(d - 0.5, d + 0.5, R) on the distance d from the
  //   centre, also in CSS pixels, over a sprite padded by 0.5 px,
  // - color [139,87,79] with alpha = opacidade (rounded to 8 bits, as a vertex
  //   color was) * brilho (a float gain that can exceed 1),
  // - additive blending, SRC_ALPHA + ONE, on black: N stacked dots sum their
  //   light until the channel clamps to white. brilho therefore sets how many
  //   stacked dots it takes to reach white.
  //
  // Positions arrive from the worker as Web Mercator offsets from a per-file
  // origin, so float32 keeps sub-pixel precision at max zoom; the origin is
  // folded into the matrix in float64 here.
  //
  // Far out, hundreds of dots land on one pixel and blending each of them is
  // what costs the frame. The worker therefore also sends merged levels: every
  // point in a grid cell becomes one dot carrying the count (see worker.js).
  // The layer picks the coarsest level whose cells stay under LOD_MAX_PX of a
  // device pixel, and draws a merged dot with count times the light: additive
  // blending is linear and clamps to white the same way, so the picture is
  // the same as drawing every dot. Hence the premultiplied form below,
  // rgb * min(1, light * coverage) * count with blend ONE + ONE, which equals
  // the old SRC_ALPHA + ONE with alpha = light * coverage for a single dot.
  var LOD_MAX_PX = 0.3;

  // Twinkle: the light drifts around its value, by up to TWINKLE of it, on a
  // phase and period (about 1 to 2.5 s) of its own, like city lights seen
  // from a plane. The phase belongs to the ground cell a dot falls in, about
  // TWINKLE_PX CSS pixels wide at the current zoom level, not to the dot:
  // dots stacked on one pixel would otherwise average their twinkles away.
  // Where the stack is far past white it still hides. It keeps the map
  // repainting every frame, so it is off under reduced motion. The cintilar
  // slider sets it.
  var TWINKLE_PX = 2;
  var twinkle = 0;
  // While the camera rests, the twinkle alone asks for a frame only every
  // TWINKLE_MS: it drifts over seconds, so about 30 fps reads the same and
  // halves the GPU (and battery) spent on a still map. A moving camera
  // repaints at full rate anyway.
  var TWINKLE_MS = 20;

  var VS = [
    "attribute vec2 a_pos;",
    "attribute float a_count;",
    "attribute float a_year;",   // opened, years since 1900
    "uniform float u_year;",     // the timeline, same unit; fractional while it eases
    "uniform mat4 u_matrix;",
    "uniform float u_size;",
    "uniform float u_time;",     // seconds
    "uniform float u_twinkle;",
    "uniform float u_cell;",     // twinkle cell, in Mercator units
    "varying float v_count;",
    "float hash(vec2 p) {",
    "  vec3 q = fract(vec3(p.xyx) * 0.1031);",
    "  q += dot(q, q.yzx + 33.33);",
    "  return fract((q.x + q.y) * q.z);",
    "}",
    "void main() {",
    // A dot fades in over the year after it opens; before that it is skipped
    // outright, off screen, so the hidden ones cost no fragments.
    "  float born = clamp(u_year - a_year + 1.0, 0.0, 1.0);",
    "  if (born <= 0.0) { v_count = 0.0; gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }",
    "  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);",
    "  gl_PointSize = u_size;",
    // Two unrelated numbers per cell: phase and pace. Skipped when off.
    "  float tw = 1.0;",
    "  if (u_twinkle > 0.0) {",
    "    vec2 cell = floor(a_pos / u_cell);",
    "    float h = hash(cell);",
    "    float g = hash(cell + 71.3);",
    "    float w = 2.5 + 4.0 * g;",
    "    tw += u_twinkle * sin(u_time * w + 6.2832 * h) * (0.7 + 0.3 * sin(u_time * w * 0.31 + 6.2832 * g));",
    "  }",
    "  v_count = min(a_count, 60000.0) * tw * born;",  // stays finite in mediump; white long before
    "}",
  ].join("\n");

  var FS = [
    "#ifdef GL_FRAGMENT_PRECISION_HIGH",
    "precision highp float;",
    "#else",
    "precision mediump float;",
    "#endif",
    "uniform vec3 u_rgb;",
    "uniform float u_light;",    // opacidade * brilho
    "uniform float u_radius;",   // R, CSS px
    "uniform float u_extent;",   // R + 0.5, the sprite's half-size in CSS px
    "varying float v_count;",
    "void main() {",
    "  float d = length(gl_PointCoord * 2.0 - 1.0) * u_extent;",
    "  float cover = smoothstep(d - 0.5, d + 0.5, u_radius);",
    "  gl_FragColor = vec4(u_rgb * min(1.0, u_light * cover) * v_count, 1.0);",
    "}",
  ].join("\n");

  function createPointsLayer() {
    var gl = null, prog = null, loc = {};
    var buffers = new Map();       // uf + level -> GL buffer
    var data = null, prev = null;  // prev fades out under data, see lightUp
    var mix = 1;                   // data's share of the light; prev gets 1 - mix
    var params = { alpha: 0.8, gain: 1, radius: BASE_RADIUS, year: TL_MAX - 1900, yearMax: TL_MAX - 1900 };
    var m = new Float32Array(16);  // the frame's matrix, shifted to a set's origin
    var twinkleTimer = 0;

    function setup() {
      prog = gl.createProgram();
      gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      ["a_pos", "a_count", "a_year"].forEach(function (k) { loc[k] = gl.getAttribLocation(prog, k); });
      ["u_matrix", "u_size", "u_rgb", "u_light", "u_radius", "u_extent", "u_time", "u_twinkle", "u_cell", "u_year"].forEach(function (k) {
        loc[k] = gl.getUniformLocation(prog, k);
      });
    }

    // Is any of chunk c's box on screen? Its four corners go through the
    // matrix; the box is off screen when all four fall outside one side of
    // the view (widened by mx, my in clip units for the dots' own size). The
    // test holds for corners behind the camera too, and never culls a box
    // that could show.
    function boxVisible(b, c, mx, my) {
      var o = c * 4, left = 0, right = 0, below = 0, above = 0;
      for (var k = 0; k < 4; k++) {
        var x = b[o + (k & 1 ? 2 : 0)], y = b[o + (k & 2 ? 3 : 1)];
        var cx = m[0] * x + m[4] * y + m[12];
        var cy = m[1] * x + m[5] * y + m[13];
        var cw = m[3] * x + m[7] * y + m[15];
        if (cx < -cw * mx) left++;
        else if (cx > cw * mx) right++;
        if (cy < -cw * my) below++;
        else if (cy > cw * my) above++;
      }
      return left < 4 && right < 4 && below < 4 && above < 4;
    }

    // Draws the runs of consecutive chunks that reach the screen.
    function drawVisible(boxes, chunk, n, mx, my) {
      if (!boxes) { gl.drawArrays(gl.POINTS, 0, n); return; }
      var count = boxes.length / 4, run = -1;
      for (var c = 0; c <= count; c++) {
        var vis = c < count && boxVisible(boxes, c, mx, my);
        if (vis && run < 0) run = c;
        else if (!vis && run >= 0) {
          var first = run * chunk;
          gl.drawArrays(gl.POINTS, first, Math.min(n, c * chunk) - first);
          run = -1;
        }
      }
    }

    function twinkleSoon() {
      if (twinkleTimer) return;
      if (map.isMoving()) { map.triggerRepaint(); return; }
      twinkleTimer = setTimeout(function () { twinkleTimer = 0; map.triggerRepaint(); }, TWINKLE_MS);
    }

    function compile(type, src) {
      var sh = gl.createShader(type);
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
      return sh;
    }

    function bufferFor(key, array) {
      var buf = buffers.get(key);
      if (!buf) {
        buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, array, gl.STATIC_DRAW);
        buffers.set(key, buf);
      }
      return buf;
    }

    // Coarsest level whose cells stay under LOD_MAX_PX device pixels where the
    // map is closest to the camera. A cell is 2^k grid steps of q degrees; one
    // degree of latitude is up to ~1.25x a degree of longitude in Mercator
    // over Brazil, and under the tilt the bottom of the screen is magnified
    // up to ~1 + pitch/45 against the centre.
    function pickLevel(d, zoom, dpr, pitch) {
      var pxWorld = 1 / (512 * Math.pow(2, zoom) * dpr);
      var limit = (LOD_MAX_PX * pxWorld) / (1.25 * (1 + pitch / 45));
      var best = null;
      for (var i = 0; i < d.levels.length; i++) {
        if ((Math.pow(2, d.levels[i].k) * d.q) / 360 <= limit) best = d.levels[i];
      }
      return best;
    }

    return {
      id: "pontos",
      type: "custom",
      renderingMode: "2d",

      onAdd: function (map, context) {
        gl = context;
        setup();
      },

      // The GL context came back after being lost (phones drop it in the
      // background): every program and buffer is gone, so build them again.
      // The buffers refill from the cached arrays on the next draw.
      restore: function () {
        if (!gl) return;
        buffers.clear();
        setup();
        map.triggerRepaint();
      },

      render: function (gl, matrix) {
        if (!data) return;
        var dpr = map.getPixelRatio ? map.getPixelRatio() : window.devicePixelRatio || 1;
        var R = params.radius, extent = R + 0.5;
        var light = (Math.round(255 * params.alpha) / 255) * params.gain;
        var size = 2 * extent * dpr;
        var mx = 1 + size / gl.drawingBufferWidth, my = 1 + size / gl.drawingBufferHeight;

        gl.useProgram(prog);
        gl.uniform1f(loc.u_size, size);
        gl.uniform1f(loc.u_radius, R);
        gl.uniform1f(loc.u_extent, extent);
        gl.uniform1f(loc.u_time, (performance.now() / 1000) % 3600);
        gl.uniform1f(loc.u_twinkle, twinkle);
        gl.uniform1f(loc.u_year, params.year);
        gl.uniform1f(loc.u_cell, TWINKLE_PX / (512 * Math.pow(2, Math.floor(map.getZoom()))));
        gl.uniform3f(loc.u_rgb, DOT_COLOR[0] / 255, DOT_COLOR[1] / 255, DOT_COLOR[2] / 255);
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_ADD);
        gl.blendFunc(gl.ONE, gl.ONE);
        // Additive light: the two sets of a crossfade simply sum.
        if (prev && prev !== data && mix < 1) draw(prev, light * (1 - mix));
        draw(data, light * mix);
        gl.disableVertexAttribArray(loc.a_pos);
        gl.disableVertexAttribArray(loc.a_count);
        gl.disableVertexAttribArray(loc.a_year);
        if (twinkle) twinkleSoon();

        function draw(d, l) {
          // matrix maps Mercator [0,1] to clip space; shift it to d's origin.
          var ox = d.origin[0], oy = d.origin[1];
          for (var i = 0; i < 16; i++) m[i] = matrix[i];
          for (var r = 0; r < 4; r++) m[12 + r] = matrix[r] * ox + matrix[4 + r] * oy + matrix[12 + r];
          // A merged dot cannot say how many of its points existed in a given
          // year, so while the timeline is cut short the points draw one by one.
          // Nor can it say which sectors it holds: filtered, too.
          var level = params.year >= params.yearMax && !d.view ? pickLevel(d, map.getZoom(), dpr, map.getPitch()) : null;

          gl.enableVertexAttribArray(loc.a_pos);
          if (level) {
            gl.bindBuffer(gl.ARRAY_BUFFER, bufferFor(d.uf + ":" + level.k, level.data));
            gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 12, 0);
            gl.enableVertexAttribArray(loc.a_count);
            gl.vertexAttribPointer(loc.a_count, 1, gl.FLOAT, false, 12, 8);
            gl.disableVertexAttribArray(loc.a_year);
            gl.vertexAttrib1f(loc.a_year, 0);
          } else {
            gl.bindBuffer(gl.ARRAY_BUFFER, bufferFor(d.uf, d.positions));
            gl.vertexAttribPointer(loc.a_pos, 2, gl.FLOAT, false, 0, 0);
            gl.disableVertexAttribArray(loc.a_count);
            gl.vertexAttrib1f(loc.a_count, 1);
            // Filtered, the years come from the view, where the points out of
            // the sector carry 255: a year the timeline never reaches.
            gl.bindBuffer(gl.ARRAY_BUFFER, d.view ? bufferFor(d.uf + ":yf", d.view) : bufferFor(d.uf + ":y", d.years));
            gl.enableVertexAttribArray(loc.a_year);
            gl.vertexAttribPointer(loc.a_year, 1, gl.UNSIGNED_BYTE, false, 0, 0);
          }
          gl.uniformMatrix4fv(loc.u_matrix, false, m);
          gl.uniform1f(loc.u_light, l);
          if (level) drawVisible(level.boxes, d.chunk, level.n, mx, my);
          else drawVisible(d.boxes, d.chunk, d.n, mx, my);
        }
      },

      show: function (d, from, k) { data = d; prev = from || null; mix = from ? k : 1; map.triggerRepaint(); },

      refresh: function () { map.triggerRepaint(); },

      // The filters changed d.view: drop its buffer, the next draw uploads
      // the new one (one per place, never one per filter).
      refilter: function (uf) {
        var buf = buffers.get(uf + ":yf");
        if (buf) {
          if (gl) gl.deleteBuffer(buf);
          buffers.delete(uf + ":yf");
        }
        map.triggerRepaint();
      },

      // year in years since 1900; at yearMax nothing is hidden.
      setYear: function (year, yearMax) {
        params.year = year;
        params.yearMax = yearMax;
        map.triggerRepaint();
      },

      set: function (alpha, gain, radius) {
        params.alpha = alpha;
        params.gain = gain;
        params.radius = radius;
        map.triggerRepaint();
      },

      forget: function (uf) {
        buffers.forEach(function (buf, key) {
          if (key === uf || key.indexOf(uf + ":") === 0) {
            if (gl) gl.deleteBuffer(buf);
            buffers.delete(key);
          }
        });
      },
    };
  }

  var knobs = ["opacity", "brightness", "dotsize"];

  function knobValue(name) { return parseFloat($(name).value); }

  function setKnob(name, v) {
    $(name).value = v;
    $(name + "-out").textContent = (+v).toFixed(2);
    paintKnob($(name));
  }

  // WebKit has no pseudo-element for the filled part of a range track: the
  // CSS paints it from --fill, the thumb's place along the track, 0..1.
  function paintKnob(el) {
    el.style.setProperty("--fill", ((el.value - el.min) / (el.max - el.min)).toFixed(4));
  }

  // The sliders are ABSOLUTE readouts-and-controls, not trims: auto (or, with
  // auto off, the zoom curve) writes the computed values straight into the
  // sliders, so the knobs slide on their own as the map moves and their
  // position *is* the current value.
  //
  // Dragging a slider overrides that value until the next move, which
  // re-asserts it — the cost of having the knobs track the map. The lock
  // holds a look set by hand.
  //
  // fromZoom: recompute from the curve and push the values into the sliders.
  // Otherwise the user just dragged one, so read the sliders as-is.
  var sharedKnobs = null;   // slider values from a shared link, see showView
  // The lock by the zoom readout: locked, the zoom leaves the sliders where
  // they are, so a look set by hand holds at every zoom.
  var knobsLocked = false;

  // auto, on from the start: unlocked, the sliders follow what the screen
  // holds (autoLook) instead of the zoom curve. Walking the points is too
  // slow for every frame of a zoom, so the look is taken at most every
  // AUTO_EVERY ms and the sliders ease to it. A playing timeline holds them:
  // re-exposing every year would cancel the growth it shows.
  var autoOn = true;
  var AUTO_EVERY = 200;
  var autoGoal = null, autoAt = null, autoTimer = 0, autoLast = 0, autoFrame = 0;

  function autoFollows() { return autoOn && !knobsLocked && !sharedKnobs; }

  function autoSoon() {
    if (!autoFollows() || autoTimer) return;
    autoTimer = setTimeout(autoNow, Math.max(0, AUTO_EVERY - (performance.now() - autoLast)));
  }

  function autoNow() {
    autoTimer = 0;
    if (!autoFollows() || tl.playing) return;
    var look = autoLook();
    autoLast = performance.now();
    if (!look) return;
    autoGoal = look;
    if (!autoFrame) {
      autoAt = {};
      knobs.forEach(function (name) { autoAt[name] = knobValue(name); });
      autoThen = performance.now();
      autoFrame = requestAnimationFrame(autoEase);
    }
  }

  // New points on screen (a filter, another place): the look is theirs from
  // the first frame, with no easing from the one before. Eased, a filter
  // taken off would flash white while the sliders came down.
  function autoSnap() {
    if (!autoFollows()) return;
    var look = autoLook();
    autoLast = performance.now();
    if (!look) return;
    autoStop();
    autoGoal = look;
    knobs.forEach(function (name) { setKnob(name, look[name]); });
    schedule(false);
    writeHashSoon();
  }

  // The sliders close the gap by AUTO_EASE ms of time constant, whatever the
  // frame rate, as ratios (light is read as ratios). autoAt keeps the exact
  // values: the sliders round to 0.01.
  var AUTO_EASE = 70, autoThen = 0;
  function autoEase(now) {
    autoFrame = 0;
    if (!autoFollows()) return;
    var k = 1 - Math.exp(-Math.min(100, now - autoThen) / AUTO_EASE), far = false;
    autoThen = now;
    knobs.forEach(function (name) {
      var v = autoAt[name], g = autoGoal[name];
      v = reduceMotion || Math.abs(g - v) < 0.004 ? g : v * Math.pow(g / v, k);
      if (v !== g) far = true;
      autoAt[name] = v;
      setKnob(name, v);
    });
    apply(false);
    if (far) autoFrame = requestAnimationFrame(autoEase);
    else writeHashSoon();
  }

  // A slider dragged by hand stops the easing under it.
  function autoStop() {
    cancelAnimationFrame(autoFrame);
    autoFrame = 0;
  }

  // cintilar is not on the zoom curve: it stays where the user (or a shared
  // link) left it.
  function setTwinkle(v) {
    setKnob("twinkle", v);
    twinkle = reduceMotion ? 0 : v;
    if (points) points.refresh();
  }

  function apply(fromZoom) {
    if (!map) return;
    var z = map.getZoom();
    if (fromZoom && sharedKnobs && Math.abs(z - sharedKnobs.zoom) > 0.01) sharedKnobs = null;
    if (fromZoom && knobsLocked) {
      // keep the sliders as they are
    } else if (fromZoom && sharedKnobs) {
      knobs.forEach(function (name) { setKnob(name, sharedKnobs[name]); });
    } else if (fromZoom) {
      // auto takes the sliders from here; the curve stands in until its
      // first look lands, and is the whole story with auto off.
      if (!autoOn || !autoGoal) {
        var c = zoomCurve(z);
        setKnob("opacity", clamp(c.light, 0.05, 1));
        setKnob("brightness", clamp(brightCurve(z), 0.02, 2.5));
        setKnob("dotsize", c.size);
      }
      autoSoon();
    }
    if (fromZoom) writeHashSoon();
    $("zoomval").textContent = z.toFixed(2);

    var data = current && cache.get(current);
    if (!data || !points) return;
    points.show(data, fadeFrom && cache.get(fadeFrom), fade);
    points.set(
      clamp(knobValue("opacity"), 0.05, 1),
      clamp(knobValue("brightness"), 0.02, 2.5),
      BASE_RADIUS * Math.max(knobValue("dotsize"), 0.1)
    );
    points.setYear(tl.shown - TL_MIN, TL_MAX - TL_MIN);
  }

  // "zoom" fires many times per second during a wheel/pinch — coalesce to at
  // most one rebuild per animation frame.
  var frame = 0;
  var pendingZoom = false;
  function schedule(fromZoom) {
    if (fromZoom === true) pendingZoom = true;
    if (frame) return;
    frame = requestAnimationFrame(function () {
      frame = 0;
      var wasZoom = pendingZoom;
      pendingZoom = false;
      apply(wasZoom);
    });
  }

  // The lights come on: ramp the gain from 0 when a new point set lands.
  // With from, that place's points fade out meanwhile: landing on a state
  // over the Brasil sample, the state stays lit and the rest of the country
  // goes dark.
  var lightRun = 0;
  function lightUp(from) {
    var run = ++lightRun;
    fadeFrom = from && from !== current ? from : null;
    if (reduceMotion) { fade = 1; fadeFrom = null; schedule(false); return; }
    var start = performance.now();
    var DURATION = 1400;
    fade = 0;
    (function step(now) {
      if (run !== lightRun) return;
      var k = clamp((now - start) / DURATION, 0, 1);
      fade = k * k * (3 - 2 * k);
      if (k === 1) fadeFrom = null;
      apply(false);
      if (k < 1) requestAnimationFrame(step);
    })(start);
  }

  // ---------------------------------------------------------------------------
  // Camera

  function padding() {
    var small = window.innerWidth <= 640;
    // Phones: clear of the intro and readout stacked at the top.
    if (small) return { top: document.querySelector(".readout").getBoundingClientRect().bottom + 16, bottom: 120, left: 16, right: 16 };
    // Keep the place clear of the panel column on the left and the sliders
    // on the right (0 wide while folded away on short screens).
    var rail = document.querySelector(".rail").getBoundingClientRect();
    var light = $("light-panel").getBoundingClientRect();
    return {
      top: 60,
      bottom: 120,
      left: Math.min(rail.width + 50, window.innerWidth * 0.35),
      right: Math.min(light.width + 50, window.innerWidth * 0.25),
    };
  }

  function cameraFor(uf) {
    var b = meta[uf].bbox;
    var cam = map.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding: padding() });
    if (!cam) return { center: map.getCenter(), zoom: map.getZoom() };
    // cameraForBounds fits a top-down view; under the tilt the near edge of
    // the place widens on screen, so back off a little to keep it in frame.
    if (tilted) cam.zoom -= TILT_ZOOM_OUT;
    return cam;
  }

  // minZoom caps how far the user can zoom OUT, and is the bottom (t=0) of the
  // zoom curve. Same rule as the per-state pages had: 8, unless the place needs
  // less to fit (BR fits at ~3.7). Lowered first so the flight is not clamped,
  // then settled once the camera arrives.
  var flight = 0;
  var traveling = 0;       // flights under way; the camera is not the user's then

  function easeInOutCubic(t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; }
  // Ends a touch past 1 and comes back: the camera lands, then seats.
  function easeOutSeat(t) { var u = t - 1; return 1 + 2.2 * u * u * u + 1.2 * u * u; }

  // Flies to the place and resolves when the camera has arrived, or when the
  // flight was cut short (by the user, or by another fly()). With a view (from
  // a shared link) it lands straight on that camera instead of framing the place.
  function fly(uf, view) {
    var cam = cameraFor(uf);
    var target = Math.min(8, cam.zoom);
    var id = ++flight;
    var end = view || { center: cam.center, zoom: cam.zoom, pitch: tilted ? TILT : 0, bearing: 0 };
    // The arc between two places climbs well above both; minZoom would clip
    // it into a fast low pan, so open it all the way for the flight.
    map.setMinZoom(Math.min(map.getMinZoom(), 2));

    traveling++;
    var trip = new Promise(function (resolve) {
      // Never clamp below where the camera is: a flight cut short mid-arc
      // would otherwise snap.
      function settle() {
        map.setMinZoom(Math.min(target, map.getZoom()));
        schedule(true);
        resolve();
      }
      function arrived() {
        var at = map.getCenter(), to = maplibregl.LngLat.convert(end.center);
        return Math.abs(at.lng - to.lng) < 0.01 && Math.abs(at.lat - to.lat) < 0.01;
      }

      if (reduceMotion || view) {
        map.jumpTo(end);
        settle();
        return;
      }

      // Arrive a little high, then sink into the frame.
      // flyTo stops any running flight, which fires that flight's moveend
      // synchronously: listen only after it has started.
      map.flyTo({
        center: end.center,
        zoom: cam.zoom - 0.3,
        pitch: end.pitch,
        bearing: 0,
        speed: 1.2,
        curve: 1.2,
        maxDuration: 2800,
        easing: easeInOutCubic,
        essential: true,
      });
      function flown() {
        if (id !== flight || !arrived()) { if (id === flight) settle(); else resolve(); return; }
        map.easeTo(Object.assign({}, end, { duration: 700, easing: easeOutSeat, essential: true }));
        map.once("moveend", function () {
          if (id === flight) settle(); else resolve();
        });
      }
      // A flight too long for maxDuration is a jump: it is over, moveend
      // fired, before flyTo returns.
      if (map.isMoving()) map.once("moveend", flown);
      else flown();
    });
    trip.then(function () { traveling--; });
    return trip;
  }

  // ---------------------------------------------------------------------------
  // Timeline

  // The slider hides every dot whose oldest establishment opened after the
  // chosen year, so the places light up as the country's business grew. The
  // dots are today's active CNPJs: what it shows is what is still alive and
  // already existed by then, not the city as it was.
  //
  // `target` is where the slider points, `shown` is what the shader gets: it
  // eases toward the target, so a jump of decades is a short fade instead of a
  // cut, and dots fade in over their opening year (see VS). While playing,
  // `shown` simply follows the clock.
  var tl = { target: TL_MAX, shown: TL_MAX, playing: false, last: 0, raf: 0, data: null };
  var PLAY_SECONDS = 14;   // a full run, from the first lit year to TL_MAX

  function tlFirstYear(d) {
    if (d.firstYear !== null) return d.firstYear;
    // First year holding at least 0.5% of the points: the empty decades
    // before it would be dead air in a playback.
    var total = 0, acc = 0, y;
    d.firstYear = TL_MIN;
    for (y = 0; y < 256; y++) total += d.hist[y];
    for (y = 0; y < 256; y++) {
      acc += d.hist[y];
      if (acc >= total * 0.005) { d.firstYear = clamp(y + TL_MIN, TL_MIN, TL_MAX - 1); break; }
    }
    return d.firstYear;
  }

  function tlDrawBars() {
    var d = tl.data, cv = $("tl-bars");
    if (!d || !cv.clientWidth) return;
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    var years = TL_MAX - TL_MIN + 1;
    var max = 0, i;
    for (i = 0; i < years; i++) max = Math.max(max, d.hist[i]);
    if (!max) return;
    var cut = Math.round(tl.shown);
    var step = w / years;
    for (i = 0; i < years; i++) {
      // Square root: the early decades stay visible next to the recent boom.
      var bh = d.hist[i] ? Math.max(1.5, Math.sqrt(d.hist[i] / max) * h) : 0;
      var lit = i + TL_MIN <= cut;
      ctx.fillStyle = lit ? LIT_BAR : DIM_BAR;
      ctx.globalAlpha = lit ? 0.85 : 0.45;
      ctx.fillRect(i * step + 0.5, h - bh, Math.max(1, step - 1), bh);
    }
    ctx.globalAlpha = 1;
  }

  function tlText() {
    var d = tl.data;
    var year = clamp(Math.round(tl.shown), TL_MIN, TL_MAX);
    $("tl-year").textContent = year;
    countSoon();
    if (!d) return;
    var upto = 0, y;
    for (y = 0; y <= year - TL_MIN; y++) upto += d.hist[y];
    var share = d.nView ? upto / d.nView : 1;
    $("tl-count").innerHTML = current === "BR"
      ? "<b>" + Math.round(share * 100) + "%</b> da amostra acesa"
      : "<b>" + fmt(upto) + "</b> de " + fmt(d.nView) + " endereços acesos";
  }

  function tlRender() {
    var year = clamp(tl.shown, TL_MIN, TL_MAX);
    var box = $("timeline");
    box.style.setProperty("--p", ((year - TL_MIN) / (TL_MAX - TL_MIN)).toFixed(4));
    var atEnd = tl.target >= TL_MAX && tl.shown >= TL_MAX - 0.005;
    box.classList.toggle("is-now", atEnd);
    $("tl-now").disabled = atEnd;
    $("tl-slider").value = Math.round(tl.target);
    $("tl-slider").setAttribute("aria-valuetext", "abertos até " + Math.round(tl.shown));
    tlText();
    tlDrawBars();
    if (points) points.setYear(tl.shown - TL_MIN, TL_MAX - TL_MIN);
  }

  function tlStep(now) {
    var dt = Math.min(0.05, (now - tl.last) / 1000);
    tl.last = now;
    if (tl.playing) {
      var from = tl.data ? tlFirstYear(tl.data) : TL_MIN;
      tl.target += dt * (TL_MAX - from) / PLAY_SECONDS;
      if (tl.target >= TL_MAX) { tl.target = TL_MAX; tlPlaying(false); }
      tl.shown = tl.target;
    } else if (reduceMotion) {
      tl.shown = tl.target;
    } else {
      tl.shown += (tl.target - tl.shown) * Math.min(1, dt * 12);
      if (Math.abs(tl.target - tl.shown) < 0.005) tl.shown = tl.target;
    }
    tlRender();
    tl.raf = tl.playing || tl.shown !== tl.target ? requestAnimationFrame(tlStep) : 0;
    if (!tl.raf) { writeHashSoon(); autoSoon(); }
  }

  function tlKick() {
    if (tl.raf) return;
    tl.last = performance.now();
    tl.raf = requestAnimationFrame(tlStep);
  }

  function tlPlaying(on) {
    tl.playing = on;
    var b = $("tl-play");
    b.classList.toggle("on", on);
    b.setAttribute("aria-label", on ? "Pausar" : "Reproduzir do começo");
    b.setAttribute("aria-pressed", on ? "true" : "false");
  }

  function tlSet(year) {
    tlPlaying(false);
    tl.target = clamp(year, TL_MIN, TL_MAX);
    tlKick();
  }

  // A new place brings its own histogram and its own first year.
  function refreshTimeline() {
    var d = current && cache.get(current);
    tl.data = d && d.hasYears ? d : null;
    $("timeline").hidden = $("tl-toggle").hidden = !tl.data;
    if (!tl.data && sheet === "timeline") setSheet(null);
    if (!tl.data) {
      // No years in this file: nothing to filter by, show it all.
      tl.target = tl.shown = TL_MAX;
      if (points) points.setYear(TL_MAX - TL_MIN, TL_MAX - TL_MIN);
      return;
    }
    tlRender();
  }

  function buildTimeline() {
    var axis = $("tl-axis");
    [1900, 1925, 1950, 1975, 2000, TL_MAX].forEach(function (y) {
      var t = document.createElement("span");
      t.textContent = y;
      t.style.setProperty("--at", ((y - TL_MIN) / (TL_MAX - TL_MIN)).toFixed(4));
      axis.appendChild(t);
    });
    $("tl-slider").min = TL_MIN;
    $("tl-slider").max = TL_MAX;
    $("tl-slider").value = TL_MAX;

    $("tl-slider").addEventListener("input", function () { tlSet(+this.value); });
    $("tl-now").addEventListener("click", function () { tlSet(TL_MAX); });
    $("tl-play").addEventListener("click", function () {
      if (tl.playing) { tlPlaying(false); return; }
      if (!tl.data) return;
      // Always from the dawn of the place: replay is the point.
      tl.target = tl.shown = tlFirstYear(tl.data) - 1;
      tlPlaying(true);
      tlKick();
    });
    // Resizing fires many events a frame: redraw the bars once per frame.
    var barsFrame = 0;
    window.addEventListener("resize", function () {
      if (!barsFrame) barsFrame = requestAnimationFrame(function () { barsFrame = 0; tlDrawBars(); });
    });
  }

  // ---------------------------------------------------------------------------
  // Which state is under the camera

  // data/ufgrid.json (scripts/ufgrid.py) labels each 0.2 degree cell with the
  // state that has most points in it. An empty cell borrows the nearest labelled
  // one, within a few cells.
  var ufGrid = null;

  function loadUfGrid() {
    fetch("data/ufgrid.json")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (g) {
        if (!g) return;
        var cells = new Uint8Array(g.w * g.h), at = 0;
        for (var i = 0; i < g.rle.length; i += 2) {
          cells.fill(g.rle[i], at, at + g.rle[i + 1]);
          at += g.rle[i + 1];
        }
        ufGrid = { g: g, cells: cells };
      })
      .catch(function () { /* no grid: the map just never opens a state by itself */ });
  }

  function ufAt(lng, lat) {
    if (!ufGrid) return null;
    var g = ufGrid.g;
    var cx = Math.floor((lng - g.x0) / g.step), cy = Math.floor((lat - g.y0) / g.step);
    for (var r = 0; r <= 6; r++) {
      var best = 0, bestD = 1e9;
      for (var dy = -r; dy <= r; dy++) {
        for (var dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          var x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= g.w || y >= g.h) continue;
          var c = ufGrid.cells[y * g.w + x];
          if (c && dx * dx + dy * dy < bestD) { best = c; bestD = dx * dx + dy * dy; }
        }
      }
      if (best) return g.ufs[best - 1];
    }
    return null;
  }

  // After the camera rests: warm up the state ahead (zoom is nearly there), and
  // once deep enough open it, keeping the camera exactly where it is.
  function followCamera() {
    if (!map || !requested || traveling) return;
    var z = map.getZoom();
    if (z < PREFETCH_ZOOM) return;
    var c = map.getCenter();
    var uf = ufAt(c.lng, c.lat);
    if (!uf || !meta[uf] || uf === requested) return;
    if (z < DETAIL_ZOOM) { if (requested === "BR") prefetchSoon(uf); return; }
    // The filter set over Brasil holds: the state opens already filtered.
    select(uf, {
      center: [c.lng, c.lat],
      zoom: z,
      pitch: map.getPitch(),
      bearing: map.getBearing(),
    });
  }

  // ---------------------------------------------------------------------------
  // Filters

  // Two filters, one at a time (picking one clears the other). sector: null, or 0..20
  // for the addresses holding at least one establishment in that CNAE
  // section. kind: null, or 0..7 for the addresses whose ~11 m around holds a
  // CNEFE address of kind k+1 (what the census saw there: home, school,
  // health, ...). Each comes in a file of its own per place
  // (<uf>.setores.bin.gz, <uf>.especies.bin.gz), fetched the first time the
  // place is filtered by it, from a second worker so it never aborts a point
  // download.
  var sector = null, kind = null;
  var filtroWorker = null, filtroNext = 0, filtroPending = {};

  function fetchFiltro(uf, file) {
    if (!filtroWorker) {
      filtroWorker = new Worker(WORKER_URL);
      filtroWorker.onmessage = function (e) {
        var p = filtroPending[e.data.id];
        if (!p) return;
        delete filtroPending[e.data.id];
        if (e.data.ok) p.resolve(e.data);
        else p.reject(new Error(e.data.error));
      };
    }
    var id = ++filtroNext;
    var url = new URL("data/" + uf.toLowerCase() + "." + file + ".bin.gz", location.href).href;
    return new Promise(function (resolve, reject) {
      filtroPending[id] = { resolve: resolve, reject: reject };
      filtroWorker.postMessage({ id: id, url: url, kind: "filtro" });
    });
  }

  function hasSectors(uf) { return !!(meta[uf] && meta[uf].setores); }
  function hasKinds(uf) { return !!(meta[uf] && meta[uf].especies); }

  // d.view: d's years with 255 for every point the filters leave out (the
  // layer draws from it, and 255 is a year the timeline never reaches); d.hist
  // and d.nView: the timeline's histogram and point count, filtered.
  function filterData(d) {
    var was = d.view;
    var bySector = sector !== null && d.setores, byKind = kind !== null && d.especies;
    d.firstYear = null;
    if (!bySector && !byKind) {
      d.view = null;
      d.hist = d.histAll;
      d.nView = d.n;
    } else {
      var code = bySector ? d.setores.code : null, multi = bySector ? d.setores.multi : null;
      var kinds = byKind ? d.especies.mask : null;
      var bit = 1 << sector, kbit = 1 << kind;
      var view = new Uint8Array(d.n), hist = new Uint32Array(256), shown = 0, j = 0;
      for (var i = 0; i < d.n; i++) {
        var on = true;
        if (code) {
          var c = code[i];
          on = c === 255 ? (multi[j++] & bit) !== 0 : c === sector;
        }
        if (on && kinds) on = (kinds[i] & kbit) !== 0;
        if (on) { view[i] = d.years[i]; hist[d.years[i]]++; shown++; } else view[i] = 255;
      }
      d.view = view;
      d.hist = hist;
      d.nView = shown;
    }
    if ((was || d.view) && points) points.refilter(d.uf);
    if (d.uf === requested && $("addresses")) $("addresses").textContent = fmt(d.nView);
    if (d.uf === current) autoSnap();
  }

  // What d still has to fetch for the filters set now.
  function missing(d) {
    var need = [];
    if (sector !== null && !d.setores && hasSectors(d.uf)) need.push("setores");
    if (kind !== null && !d.especies && hasKinds(d.uf)) need.push("especies");
    return need;
  }

  // Resolves once d is filtered, its filter files fetched if need be. A place
  // without them (an older deploy) just shows everything.
  function ensureFilter(d) {
    d.filtroLoading = d.filtroLoading || {};
    return Promise.all(missing(d).map(function (file) {
      if (!d.filtroLoading[file]) {
        d.filtroLoading[file] = fetchFiltro(d.uf, file).then(function (r) {
          if (r.n !== d.n) throw new Error(file + " de " + d.uf + " não batem com os pontos");
          d[file] = r;
        }).catch(function (err) { console.error(err); });
      }
      return d.filtroLoading[file];
    })).then(function () { filterData(d); });
  }

  // Picking another place on a tile starts it unfiltered. The camera
  // crossing into a state keeps the filter (followCamera), and a link's
  // filter still applies: the hash sets it.
  function leavePlace(uf) {
    if (uf !== requested && (sector !== null || kind !== null)) setFilter(null, null);
  }

  function filterLabel() {
    return "separando " + (sector !== null ? SECTORS[sector] : KINDS[kind]).toLowerCase();
  }

  function setFilter(nextSector, nextKind) {
    sector = nextSector;
    kind = nextKind;
    $("sector").value = sector === null ? "" : String(sector);
    $("kind").value = kind === null ? "" : String(kind);
    $("sector").parentNode.classList.toggle("on", sector !== null);
    $("kind").parentNode.classList.toggle("on", kind !== null);
    var filtered = sector !== null || kind !== null;
    $("filter-toggle").classList.toggle("on", filtered);
    $("filters").classList.toggle("on", filtered);
    $("filters-now").textContent = sector !== null ? SECTORS[sector] : kind !== null ? KINDS[kind] : "todos";
    if (requested) setReadout(requested);
    var d = current && cache.get(current);
    if (!d) return;
    var fetching = missing(d).length > 0;
    if (fetching) showProgress(filterLabel(), null);
    ensureFilter(d).then(function () {
      if (fetching) hideProgress();
      // The other places kept in memory follow with what they have: a place
      // filtered later fetches its own files then.
      cache.forEach(function (other) { if (other !== d) filterData(other); });
      refreshTimeline();
      countSoon();
      writeHashSoon();
    });
  }

  // ---------------------------------------------------------------------------
  // Points on screen

  // How many of the place's points the screen frames right now, past the
  // timeline's cut. The chunks' boxes skip whole chunks off screen and take
  // whole chunks inside it; only the ones on the edge are walked point by
  // point. The frame is the bounding box of the visible ground, so under the
  // tilt it runs a little generous toward the horizon.
  function countOnScreen() {
    var d = current && cache.get(current);
    var el = $("onscreen");
    if (!el) return;
    if (!d || !map) { el.textContent = "–"; return; }
    var b = map.getBounds();
    var sw = maplibregl.MercatorCoordinate.fromLngLat(b.getSouthWest());
    var ne = maplibregl.MercatorCoordinate.fromLngLat(b.getNorthEast());
    var x0 = sw.x - d.origin[0], x1 = ne.x - d.origin[0];
    var y0 = ne.y - d.origin[1], y1 = sw.y - d.origin[1];
    var cut = Math.min(Math.round(tl.shown), TL_MAX) - TL_MIN;
    // The filtered view hides its outsiders with year 255, past any cut.
    var years = d.view || (d.hasYears && cut < TL_MAX - TL_MIN ? d.years : null);
    var P = d.positions, B = d.boxes, C = d.chunk, n = d.n, total = 0;
    for (var c = 0; c * C < n; c++) {
      var bx0 = B[c * 4], by0 = B[c * 4 + 1], bx1 = B[c * 4 + 2], by1 = B[c * 4 + 3];
      if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
      var end = Math.min(n, (c + 1) * C);
      if (!years && bx0 >= x0 && bx1 <= x1 && by0 >= y0 && by1 <= y1) { total += end - c * C; continue; }
      for (var i = c * C; i < end; i++) {
        var x = P[i * 2], y = P[i * 2 + 1];
        if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && (!years || years[i] <= cut)) total++;
      }
    }
    el.textContent = fmt(total);
  }

  // auto's look: for what the screen holds right now, not for the zoom. The
  // curve assumes every point of the place, so a filter or a wound-back
  // timeline leaves it too dim. The points in frame (same walk as
  // countOnScreen) are binned into cells AUTO_CELL pixels wide, and from
  // how many points pile into each lit cell:
  //
  //   tamanho  grows with the gap between lit cells, so a sparse view gets
  //            dots that can be seen and a packed one keeps them apart;
  //            never past AUTO_SIZE_MAX, where they start to blur.
  //   light    the lower of two: the lit cells at AUTO_MEAN of white on
  //            average (what bounds a close view), and no more than
  //            AUTO_WHITE of them burnt to white (what bounds a far one,
  //            where a few metros hold most of the points).
  //
  // Against the hand-tuned curve: dimmer up close (a third to a half of its
  // light from zoom 10 down, so the centres keep their gradient instead of
  // burning white), either way from afar, and several times brighter where a
  // filter or the timeline leaves the curve nearly dark.
  var AUTO_CELL = 2;      // CSS px
  var AUTO_CELLS = 1 << 21;
  var AUTO_MEAN = 0.7;
  var AUTO_WHITE = 0.2;
  var AUTO_SIZE_MAX = 0.75;
  function autoLook() {
    var s = autoStats();
    if (!s) return null;
    var size = clamp(0.3 + 0.025 * s.gap, 0.35, AUTO_SIZE_MAX);
    // What one point adds to its pixel: a dot under a pixel wide covers part
    // of it, a wide one spills onto the cells around.
    var R = BASE_RADIUS * size, area = Math.PI * R * R;
    var cover = area <= 1 ? area : Math.max(1, area / (s.px * s.px));
    var cells = s.cells, points = s.points, B = cells.length;
    function mean(light) {
      var sum = 0;
      for (var i = 0; i < B; i++) if (cells[i]) sum += cells[i] * Math.min(1, (points[i] / cells[i]) * light * cover);
      return sum / s.lit;
    }
    var lo = 0.001, hi = 2.5;
    for (var step = 0; step < 24; step++) {
      var mid = Math.sqrt(lo * hi);
      if (mean(mid) < AUTO_MEAN) lo = mid; else hi = mid;
    }
    // The cell AUTO_WHITE from the top: the first bin to pass that rank.
    var rank = s.lit * (1 - AUTO_WHITE), seen = 0, burnt = 1;
    for (var k = 0; k < B; k++) {
      if (!cells[k]) continue;
      seen += cells[k];
      burnt = points[k] / cells[k];
      if (seen > rank) break;
    }
    var light = clamp(Math.min(lo, 1 / (burnt * cover)), 0.001, 2.5);
    var opacity = clamp(Math.sqrt(light), 0.05, 1);
    return { opacity: opacity, brightness: clamp(light / opacity, 0.02, 2.5), dotsize: size };
  }

  // The lit cells by how many points each holds, as a histogram: one bin per
  // count up to AUTO_EXACT, then AUTO_STEPS bins per doubling. It stands for
  // the sorted list of cells at a fraction of the cost, which matters because
  // this runs while the map moves. The grid is kept between calls.
  var AUTO_EXACT = 64, AUTO_STEPS = 8, AUTO_BINS = AUTO_EXACT + 28 * AUTO_STEPS;
  var autoGrid = new Uint32Array(0);
  var autoCells = new Float64Array(AUTO_BINS), autoPoints = new Float64Array(AUTO_BINS);
  function autoStats() {
    var d = current && cache.get(current);
    if (!d || !map) return null;
    var b = map.getBounds();
    var sw = maplibregl.MercatorCoordinate.fromLngLat(b.getSouthWest());
    var ne = maplibregl.MercatorCoordinate.fromLngLat(b.getNorthEast());
    var x0 = sw.x - d.origin[0], x1 = ne.x - d.origin[0];
    var y0 = ne.y - d.origin[1], y1 = sw.y - d.origin[1];
    var world = 512 * Math.pow(2, map.getZoom());
    // Under the tilt the frame's box outgrows the screen: wider cells then.
    var cell = Math.max(AUTO_CELL / world, Math.sqrt(((x1 - x0) * (y1 - y0)) / AUTO_CELLS));
    var w = Math.ceil((x1 - x0) / cell), h = Math.ceil((y1 - y0) / cell), size = w * h;
    if (!(w > 0 && h > 0)) return null;
    if (autoGrid.length < size) autoGrid = new Uint32Array(size);
    else autoGrid.fill(0, 0, size);
    var grid = autoGrid, per = 1 / cell;
    var cut = Math.min(Math.round(tl.shown), TL_MAX) - TL_MIN;
    var years = d.view || (d.hasYears && cut < TL_MAX - TL_MIN ? d.years : null);
    var P = d.positions, B = d.boxes, C = d.chunk, n = d.n;
    for (var c = 0; c * C < n; c++) {
      var bx0 = B[c * 4], by0 = B[c * 4 + 1], bx1 = B[c * 4 + 2], by1 = B[c * 4 + 3];
      if (bx1 < x0 || bx0 > x1 || by1 < y0 || by0 > y1) continue;
      var i = c * C, end = Math.min(n, i + C), x, y;
      if (bx0 >= x0 && bx1 < x1 && by0 >= y0 && by1 < y1) {
        // A chunk wholly in frame: no point of it needs the test.
        if (years) {
          for (; i < end; i++) {
            if (years[i] <= cut) grid[(((P[i * 2 + 1] - y0) * per) | 0) * w + (((P[i * 2] - x0) * per) | 0)]++;
          }
        } else {
          for (; i < end; i++) grid[(((P[i * 2 + 1] - y0) * per) | 0) * w + (((P[i * 2] - x0) * per) | 0)]++;
        }
        continue;
      }
      for (; i < end; i++) {
        x = P[i * 2];
        y = P[i * 2 + 1];
        if (x < x0 || x >= x1 || y < y0 || y >= y1 || (years && years[i] > cut)) continue;
        grid[(((y - y0) * per) | 0) * w + (((x - x0) * per) | 0)]++;
      }
    }
    var cells = autoCells, points = autoPoints, lit = 0;
    cells.fill(0);
    points.fill(0);
    for (var k = 0; k < size; k++) {
      var v = grid[k];
      if (!v) continue;
      var bin = v < AUTO_EXACT ? v : Math.min(AUTO_BINS - 1, AUTO_EXACT + ((Math.log2(v / AUTO_EXACT) * AUTO_STEPS) | 0));
      cells[bin]++;
      points[bin] += v;
      lit++;
    }
    if (!lit) return null;
    // gap: the usual distance between lit cells, in pixels.
    return { cells: cells, points: points, lit: lit, px: cell * world, gap: (cell * world) / Math.sqrt(lit / size) };
  }

  var countTimer = 0;
  function countSoon() {
    clearTimeout(countTimer);
    countTimer = setTimeout(countOnScreen, 120);
  }

  // ---------------------------------------------------------------------------
  // Selecting a place

  function setReadout(uf) {
    var info = meta[uf];
    $("place").textContent = NAMES[uf] || uf;
    fitPlace();
    $("filters").hidden = $("filter-toggle").hidden = !hasSectors(uf) && !hasKinds(uf);
    $("sector").parentNode.hidden = !hasSectors(uf);
    $("kind").parentNode.hidden = !hasKinds(uf);
    // Filtered, the figures are the filter's own. By sector they set against
    // the sector's active establishments; by address kind there are no
    // active ones to set against (only mapped ones have a place), so the note
    // gives the share of the mapped ones instead.
    var bySector = sector !== null && hasSectors(uf), byKind = kind !== null && hasKinds(uf);
    var all = { geo: info.n_estab_geolocalizados, ativos: info.n_estab_ativos };
    var sec = bySector ? info.setores[SECTOR_LETTERS[sector]] : all;
    var geo = byKind ? info.especies[kind] : sec.geo;
    // A share under 1% says so, not 0%.
    function pct(part, whole) {
      var p = whole ? (part / whole) * 100 : 0;
      return (p > 0 && p < 1 ? "<1" : Math.round(p)) + "%";
    }
    var note = byKind
      ? pct(geo, sec.geo) + " dos " + fmt(sec.geo) + " no mapa"
      : pct(sec.geo, sec.ativos) + " dos " + fmt(sec.ativos) + " ativos mapeados";
    // The place's addresses: its points, past the filter. Filtered, the count
    // comes with the place's data (filterData fills it in).
    var d = cache.get(uf);
    var addresses = !bySector && !byKind ? fmt(info.n_points)
      : d && !missing(d).length ? fmt(d.nView) : "–";
    function row(label, value, cls, id) {
      return '<div class="fact' + (cls ? " " + cls : "") + '"><span>' + label + "</span><b" +
        (id ? ' id="' + id + '"' : "") + ">" + value + "</b></div>";
    }
    // Label left, figure right, one fact a row, with the share as a plain
    // note under the count, rules between them. The same rows for every
    // place, so the panels under this one stay put. What the screen frames
    // comes last and is filled in by countOnScreen().
    $("count").innerHTML =
      row("estabelecimentos", fmt(geo), "main") + "<hr>" +
      '<div class="note">' + note + "</div>" +
      "<hr>" + row(uf === "BR" ? "endereços na amostra" : "endereços no mapa", addresses, "", "addresses") + "<hr>" +
      // A point is an address: establishments sharing one are a single dot,
      // so this counts addresses, not establishments.
      row("visíveis na tela", "–", "now", "onscreen");
    document.title = (uf === "BR" ? "brasilumen" : (NAMES[uf] + " · brasilumen"));
  }

  // The place's name stays on one line: the long ones shrink to fit.
  function fitPlace() {
    var el = $("place");
    el.style.fontSize = "";
    var size = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > el.clientWidth && size > 12) el.style.fontSize = (size -= 1) + "px";
  }

  // The room and the face both change the fit: the window's width, and the
  // font arriving after the first paint.
  window.addEventListener("resize", fitPlace);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitPlace);

  function markTiles(uf) {
    document.querySelectorAll(".tile[data-uf]").forEach(function (el) {
      el.setAttribute("aria-pressed", el.dataset.uf === uf ? "true" : "false");
    });
  }

  function select(uf, view) {
    if (!meta[uf]) uf = "BR";
    if (uf === requested) {
      if (view) fly(uf, view);
      return;
    }
    requested = uf;
    markTiles(uf);
    setReadout(uf);
    // Going back to Brasil, the country lights up as the camera pulls away.
    // Between two states it does not: the one left behind stays lit for the
    // flight and fades out as the new one lights up on arrival.
    if (uf === "BR" && current && current !== "BR" && cache.has("BR")) {
      var left = current;
      current = "BR";
      refreshTimeline();
      lightUp(left);
    }
    var landing = fly(uf, view);

    // Each step says what it is waiting on: the download fills the bar, the
    // rest (decoding millions of points, the end of the flight) sweeps it.
    var place = uf === "BR" ? "o Brasil" : uf;
    var landed = false;
    landing.then(function () { landed = true; });
    function step(label, frac) { if (requested === uf) showProgress(label, frac); }
    var cached = cache.has(uf);
    step(cached ? "iluminando " + place : "baixando " + place, cached ? null : 0);
    var loading = loadPoints(uf, function (f) {
      if (f < 1) step("baixando " + place, f);
      else step("preparando os pontos", null);
    }).then(function (data) {
      if (!landed) step("quase lá", null);
      return data;
    });
    var sorting = loading.then(function (data) {
      if (missing(data).length) step(filterLabel(), null);
      return ensureFilter(data);
    });
    Promise.all([sorting, landing])
      .then(function () {
        if (requested !== uf) return;
        var changed = current !== uf, from = current;
        current = uf;
        refreshTimeline();
        if (changed) autoSnap();
        apply(true);
        countSoon();
        hideProgress();
        if (changed) lightUp(from);
      })
      .catch(function (err) {
        if (requested !== uf) return;
        hideProgress(true);
        showError("Não foi possível carregar " + (NAMES[uf] || uf) + ": " + err.message + ". Recarregue a página para tentar de novo.");
      });
  }

  // The URL carries the place and the camera, so a link opens on the same
  // angle: #sp/12.40/-23.55012/-46.63331/15/50 is
  // place/zoom/lat/lng/bearing/pitch, optionally followed by the three
  // sliders, /opacidade/brilho/tamanho, and then /cintilar, so the link
  // carries the look too, and /ano once the timeline is wound back.
  // A bare #sp still frames the whole place.
  //
  // The zoom in the URL is for a reference screen whose short side is
  // REF_SIDE px, so a link frames the same patch of ground on any screen: a
  // phone opens it a little further out, a big monitor a little closer in.
  var REF_SIDE = 1000;
  function screenShift() {
    var c = map.getContainer();
    return Math.log2(Math.min(c.clientWidth, c.clientHeight) / REF_SIDE);
  }
  // The place may carry a filter: #sp~g/... is São Paulo, commerce only (CNAE
  // section G); #sp~5/... its addresses the census saw as health (CNEFE kind
  // 5). It rides on the first field so the numbers after it keep their places.
  function hashUf() {
    var uf = location.hash.replace("#", "").split("/")[0].split("~")[0].toUpperCase();
    return meta[uf] ? uf : "BR";
  }
  function hashFilters() {
    var out = { sector: null, kind: null };
    location.hash.replace("#", "").split("/")[0].split("~").slice(1).forEach(function (t) {
      t = t.toUpperCase();
      if (/^[1-8]$/.test(t)) out.kind = +t - 1;
      else if (t.length === 1 && SECTOR_LETTERS.indexOf(t) >= 0) out.sector = SECTOR_LETTERS.indexOf(t);
    });
    // One at a time: a link carrying both keeps the sector.
    if (out.sector !== null) out.kind = null;
    return out;
  }

  function fromHash() {
    var parts = location.hash.replace("#", "").split("/");
    var uf = hashUf();
    var n = parts.slice(1).map(Number);
    if (n.length < 3 || n.slice(0, 3).some(isNaN)) return { uf: uf, view: null, knobs: null, twinkle: null, year: null };
    var knobs = n.length >= 8 && !n.slice(5, 8).some(isNaN) ? {
      opacity: clamp(n[5], 0.05, 1),
      brightness: clamp(n[6], 0.02, 2.5),
      dotsize: clamp(n[7], 0.1, 2.5),
    } : null;
    return {
      uf: uf,
      knobs: knobs,
      twinkle: knobs && n.length >= 9 && !isNaN(n[8]) ? clamp(n[8], 0, 1) : null,
      year: knobs && n.length >= 10 && !isNaN(n[9]) ? clamp(Math.round(n[9]), TL_MIN, TL_MAX) : null,
      view: {
        zoom: clamp(n[0] + screenShift(), 2, MAX_ZOOM),
        center: [clamp(n[2], -180, 180), clamp(n[1], -85, 85)],
        bearing: isNaN(n[3]) ? 0 : n[3],
        pitch: isNaN(n[4]) ? (tilted ? TILT : 0) : clamp(n[4], 0, 85),
      },
    };
  }

  function writeHash() {
    if (!requested) return;
    var c = map.getCenter();
    var hash = "#" + requested.toLowerCase() + (sector !== null ? "~" + SECTOR_LETTERS[sector].toLowerCase() : "") +
      (kind !== null ? "~" + (kind + 1) : "") +
      "/" + (map.getZoom() - screenShift()).toFixed(2) + "/" +
      c.lat.toFixed(5) + "/" + c.lng.toFixed(5) + "/" +
      Math.round(map.getBearing()) + "/" + Math.round(map.getPitch()) + "/" +
      knobs.concat("twinkle").map(function (name) { return knobValue(name).toFixed(2); }).join("/") +
      // The year only rides along once the timeline is wound back.
      (tl.target < TL_MAX ? "/" + Math.round(tl.target) : "");
    if (location.hash !== hash) history.replaceState(null, "", hash);
  }

  // Safari throttles replaceState, so the URL is written once the camera or a
  // slider has rested, after the sliders have taken their new values.
  var hashTimer = 0;
  function writeHashSoon() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(writeHash, 300);
  }

  function setTilted(on) {
    tilted = on;
    $("tilt").setAttribute("aria-pressed", on ? "true" : "false");
    $("tilt").textContent = on ? "inclinado" : "de cima";
  }

  // Takes fromHash()'s result and hands back the camera for select(). Shared
  // slider values hold while the camera stays at the shared zoom; the first
  // zoom away hands the sliders back to the zoom curve.
  function showView(h) {
    var f = hashFilters();
    if (f.sector !== sector || f.kind !== kind) setFilter(f.sector, f.kind);
    if (h.view) setTilted(h.view.pitch > 0);
    sharedKnobs = h.view && h.knobs ? Object.assign({ zoom: h.view.zoom }, h.knobs) : null;
    if (h.twinkle !== null) setTwinkle(h.twinkle);
    if (h.year !== null) { tl.target = tl.shown = h.year; tlRender(); }
    return h.view;
  }

  function showError(msg) {
    $("error").textContent = msg;
    $("error").hidden = false;
  }

  // ---------------------------------------------------------------------------
  // UI

  function buildTiles() {
    var counts = Object.keys(meta).filter(function (k) { return k !== "BR"; })
      .map(function (k) { return meta[k].n_estab_geolocalizados; });
    var lo = Math.log(Math.min.apply(null, counts));
    var hi = Math.log(Math.max.apply(null, counts));
    var box = $("tiles");

    Object.keys(TILE_GRID).forEach(function (uf) {
      var pos = TILE_GRID[uf];
      var b = document.createElement("button");
      b.type = "button";
      b.className = "tile";
      b.textContent = uf;
      b.dataset.uf = uf;
      b.style.gridColumn = pos[0] + 1;
      b.style.gridRow = (pos[1] + 1) + (pos[2] ? " / span " + pos[2] : "");
      var info = meta[uf];
      if (info) {
        var g = (Math.log(info.n_estab_geolocalizados) - lo) / (hi - lo || 1);
        b.style.setProperty("--glow", g.toFixed(3));
        b.setAttribute("aria-label", NAMES[uf] + ", " + fmt(info.n_estab_geolocalizados) + " estabelecimentos");
      } else {
        b.disabled = true;
        b.title = NAMES[uf] + ": sem dados ainda";
        b.setAttribute("aria-label", NAMES[uf] + ", sem dados ainda");
      }
      box.appendChild(b);
    });

    $("picker").addEventListener("click", function (e) {
      var t = e.target.closest(".tile[data-uf]");
      if (!t || t.disabled) return;
      leavePlace(t.dataset.uf);
      select(t.dataset.uf);
      closePicker();
    });

    // Hover preview: the state's still render plus its numbers.
    var peek = $("peek");
    function showPeek(t) {
      var uf = t && t.dataset.uf;
      if (!uf || !meta[uf]) { peek.hidden = true; return; }
      $("peek-img").src = "thumbs/" + uf.toLowerCase() + ".webp";
      $("peek-name").textContent = NAMES[uf];
      $("peek-stats").textContent = fmt(meta[uf].n_estab_geolocalizados) + " estabelecimentos";
      peek.hidden = false;
    }
    $("picker").addEventListener("pointerover", function (e) {
      var t = e.target.closest(".tile[data-uf]");
      showPeek(t);
      prefetchSoon(t && t.dataset.uf);
    });
    $("picker").addEventListener("pointerleave", function () { peek.hidden = true; });
    $("picker").addEventListener("focusin", function (e) { showPeek(e.target.closest(".tile[data-uf]")); });
    $("picker").addEventListener("focusout", function () { peek.hidden = true; });
  }

  // Hovering a tile for a moment starts its download into the HTTP cache, so
  // the click usually finds the file already there. The delay keeps a mouse
  // sweeping across the grid from pulling every state.
  var prefetched = {};
  var prefetchTimer = 0;
  function prefetchSoon(uf) {
    clearTimeout(prefetchTimer);
    if (!uf || !meta[uf] || prefetched[uf] || cache.has(uf)) return;
    prefetchTimer = setTimeout(function () {
      prefetched[uf] = true;
      // Read the body through, or the browser may not keep it in the cache.
      fetch("data/" + uf.toLowerCase() + ".bin.gz", { priority: "low" })
        .then(function (r) { return r.arrayBuffer(); })
        .catch(function () { prefetched[uf] = false; });
    }, 250);
  }

  // Phones show the picker, the sliders and the timeline as sheets over the
  // dock, one at a time; on wider screens only luz folds (short ones).
  var SHEETS = { picker: "picker", filtros: "sector-box", light: "light-panel", timeline: "timeline" };
  var sheet = null;

  function setSheet(name) {
    sheet = name;
    Object.keys(SHEETS).forEach(function (k) {
      $(SHEETS[k]).classList.toggle("open", k === name);
    });
    document.querySelectorAll("[data-sheet]").forEach(function (b) {
      b.setAttribute("aria-expanded", b.dataset.sheet === name ? "true" : "false");
    });
  }

  // A sheet closes when dragged down by its handle (the strip at its top);
  // lower down, a drag belongs to the sliders and the tiles.
  var HANDLE = 36, CLOSE_AT = 56;
  function dragToClose(el) {
    var y0 = null, dy = 0;
    el.addEventListener("touchstart", function (e) {
      if (!el.classList.contains("open") || e.touches.length !== 1) return;
      var y = e.touches[0].clientY;
      if (y - el.getBoundingClientRect().top > HANDLE) return;
      y0 = y;
      dy = 0;
      el.style.transition = "none";
    }, { passive: true });
    el.addEventListener("touchmove", function (e) {
      if (y0 === null) return;
      dy = Math.max(0, e.touches[0].clientY - y0);
      el.style.transform = "translateY(" + dy + "px)";
    }, { passive: true });
    function end() {
      if (y0 === null) return;
      y0 = null;
      el.style.transition = el.style.transform = "";
      if (dy > CLOSE_AT) setSheet(null);
    }
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
  }

  function closePicker() {
    if (sheet === "picker") setSheet(null);
  }

  function wireUi() {
    SECTORS.forEach(function (name, k) {
      var o = document.createElement("option");
      o.value = String(k);
      o.textContent = name;
      $("sector").appendChild(o);
    });
    KINDS.forEach(function (name, k) {
      var o = document.createElement("option");
      o.value = String(k);
      o.textContent = name;
      $("kind").appendChild(o);
    });
    // One filter at a time: picking one clears the other.
    // On phones the filters are a sheet: once one is picked it gets out of
    // the map's way.
    $("sector").addEventListener("change", function () {
      setFilter(this.value === "" ? null : +this.value, null);
      if (sheet === "filtros") setSheet(null);
    });
    $("kind").addEventListener("change", function () {
      setFilter(null, this.value === "" ? null : +this.value);
      if (sheet === "filtros") setSheet(null);
    });

    // Phones show the readout as the place and its count; a tap opens the
    // rest.
    document.querySelector(".readout").addEventListener("click", function () {
      this.classList.toggle("open");
    });

    // Wider screens fold the filters under their header, and the sliders
    // under theirs: the filters start folded, the sliders open.
    $("filters-head").addEventListener("click", function () {
      var open = $("filters").classList.toggle("unfolded");
      this.setAttribute("aria-expanded", open ? "true" : "false");
    });
    $("light-head").addEventListener("click", function () {
      var open = !$("light-panel").classList.toggle("folded");
      this.setAttribute("aria-expanded", open ? "true" : "false");
    });

    Object.keys(SHEETS).forEach(function (name) { dragToClose($(SHEETS[name])); });

    buildTimeline();

    document.querySelectorAll("[data-sheet]").forEach(function (b) {
      b.addEventListener("click", function () {
        setSheet(sheet === b.dataset.sheet ? null : b.dataset.sheet);
      });
    });

    knobs.forEach(function (name) {
      $(name).addEventListener("input", function () {
        $(name + "-out").textContent = (+this.value).toFixed(2);
        paintKnob(this);
        autoStop();
        schedule(false);
        writeHashSoon();
      });
    });

    function setLocked(on) {
      knobsLocked = on;
      $("knob-lock").setAttribute("aria-pressed", on ? "true" : "false");
      $("knob-lock").title = on
        ? "Destravar: os controles voltam a acompanhar o mapa"
        : "Travar: o mapa deixa de mexer nos controles";
    }

    $("knob-lock").addEventListener("click", function () {
      setLocked(!knobsLocked);
      // Unlocked, the sliders go back to auto (or the zoom curve) right away.
      if (!knobsLocked) { sharedKnobs = null; schedule(true); }
    });

    function setAuto(on) {
      autoOn = on;
      $("knob-auto").setAttribute("aria-pressed", on ? "true" : "false");
      $("knob-auto").title = on
        ? "Auto ligado: a luz acompanha o que está na tela. Clique para seguir só o zoom"
        : "Auto desligado: a luz segue o zoom. Clique para acompanhar o que está na tela";
    }

    // Turning auto on takes the sliders back from the lock, or it would
    // change nothing.
    $("knob-auto").addEventListener("click", function () {
      setAuto(!autoOn);
      if (autoOn) { setLocked(false); sharedKnobs = null; }
      else autoStop();
      schedule(true);
    });

    $("twinkle").disabled = reduceMotion;
    setTwinkle(knobValue("twinkle"));
    $("twinkle").addEventListener("input", function () {
      setTwinkle(+this.value);
      writeHashSoon();
    });

    $("tilt").addEventListener("click", function () {
      setTilted(!tilted);
      map.easeTo({ pitch: tilted ? TILT : 0, bearing: tilted ? map.getBearing() : 0, duration: reduceMotion ? 0 : 900 });
    });

    $("about-open").addEventListener("click", function () {
      var about = $("about");
      // <dialog> came late to Safari (15.4): there, just show it.
      if (about.showModal) about.showModal();
      else about.setAttribute("open", "");
    });
    if (!$("about").showModal) {
      $("about").querySelector("form").addEventListener("submit", function (e) {
        e.preventDefault();
        $("about").removeAttribute("open");
      });
    }

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        setSheet(null);
      }
    });

    window.addEventListener("hashchange", function () {
      var h = fromHash();
      select(h.uf, showView(h));
    });
  }

  // ---------------------------------------------------------------------------
  // Boot

  // A first visit with no place in the URL asks ipwho.is which state the
  // visitor's IP is in. Anything else (abroad, a state with no file, a slow or
  // failed lookup) settles on Brasil.
  // The lookup leaves at boot, alongside meta.json rather than after it, and
  // the GEO_TIMEOUT clock starts there too.
  function geoLookup() {
    var timeout = new Promise(function (resolve) { setTimeout(resolve, GEO_TIMEOUT, null); });
    var lookup = fetch("https://ipwho.is/?fields=success,country_code,region_code")
      // Over the free quota (1k a day) or down: an error status, or
      // success: false in the body. Both settle on Brasil like any failure.
      .then(function (r) { if (!r.ok) throw new Error("ipwho.is " + r.status); return r.json(); })
      .catch(function () { return null; });
    return Promise.race([lookup, timeout]);
  }

  function guessUf(geo) {
    return geo.then(function (g) {
      var uf = g && g.success && g.country_code === "BR" ? String(g.region_code).toUpperCase() : "";
      return meta[uf] && CAPITALS[uf] ? uf : "BR";
    });
  }

  function capitalView(uf) {
    if (uf === "BR") return null;
    return {
      center: CAPITALS[uf],
      zoom: CAPITAL_ZOOM + screenShift(),
      bearing: 0,
      pitch: tilted ? TILT : 0,
    };
  }

  function boot() {
    var shared = location.hash.length > 1;
    var geo = shared ? null : geoLookup();
    fetch("data/meta.json")
      .then(function (r) {
        if (!r.ok) throw new Error("meta.json " + r.status);
        return r.json();
      })
      .then(function (m) {
        meta = m;
        var sum = Object.keys(m).filter(function (k) { return k !== "BR"; })
          .reduce(function (a, k) { return a + m[k].n_points; }, 0);
        $("sum-points").textContent = fmt(sum);

        // Start the first place's download now, while the map sets up;
        // select() picks it up when the map is ready.
        var first = shared ? Promise.resolve(hashUf()) : guessUf(geo);
        first.then(function (uf) {
          loadPoints(uf).catch(function () { /* select() reports it */ });
        });

        buildTiles();
        wireUi();
        loadUfGrid();

        var b = m.BR.bbox;
        map = new maplibregl.Map({
          container: "map",
          // No basemap: a black background, so only the dot cloud reads as signal.
          style: { version: 8, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#000" } }] },
          bounds: [[b[0], b[1]], [b[2], b[3]]],
          fitBoundsOptions: { padding: padding() },
          minZoom: 2,
          maxZoom: MAX_ZOOM,
          pitch: TILT,
          antialias: false, // the dots antialias themselves; MSAA only costs fill
          attributionControl: false,
          // No labels to fade in. With a fade, MapLibre keeps repainting at
          // full rate while anything (the twinkle) renders every < 300 ms.
          fadeDuration: 0,
          pixelRatio: Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO),
        });

        map.on("webglcontextrestored", function () { if (points) points.restore(); });

        map.on("load", function () {
          points = createPointsLayer();
          map.addLayer(points);
          map.on("zoom", function () { schedule(true); });
          // A pan changes what is in frame as much as a zoom does.
          map.on("move", autoSoon);
          map.on("resize", autoSoon);
          map.on("moveend", writeHashSoon);
          map.on("moveend", followCamera);
          map.on("moveend", countSoon);
          // A tap on the map puts the phone's panels away.
          map.on("click", function () {
            setSheet(null);
            document.querySelector(".readout").classList.remove("open");
          });
          if (shared) {
            var h = fromHash();
            select(h.uf, showView(h));
          } else {
            first.then(function (uf) { select(uf, capitalView(uf)); });
          }
        });
      })
      .catch(function (err) {
        console.error(err);
        showError("Não foi possível carregar os dados (" + err.message + "). Recarregue a página para tentar de novo.");
      });
  }

  boot();
})();
