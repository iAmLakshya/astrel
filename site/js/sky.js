(function () {
  "use strict";

  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  var playIntro = document.documentElement.classList.contains("intro");
  var clockLabel = document.getElementById("clock");

  // Intro timing in seconds.
  var INTRO_SECONDS = 3.2;

  // The golden ratio and the golden angle (137.508 degrees).
  var PHI = (1 + Math.sqrt(5)) / 2;
  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  // Star colours: cream, blue white, amber, salmon, pink, teal, and green.
  var STAR_COLOURS = [0xe8dcc2, 0xa9c4ff, 0xffc46b, 0xff8a7a, 0xff8fd0, 0x6fe3cf, 0x8fdc86];
  // The chance of each star colour. The values add up to 1.
  var STAR_WEIGHTS = [0.42, 0.2, 0.12, 0.08, 0.07, 0.06, 0.05];

  // Pick a star colour index from the weights.
  function pickTone(roll) {
    var sum = 0;
    for (var i = 0; i < STAR_WEIGHTS.length; i++) {
      sum += STAR_WEIGHTS[i];
      if (roll < sum) return i;
    }
    return 0;
  }

  // Make a small seeded random generator, so the star layout is stable.
  function seeded(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Get a normal random number (Box-Muller).
  function gauss() {
    var u = 1 - Math.random();
    var v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // Show text as random glyphs that lock into place from left to right.
  function decode(el, delay, duration) {
    var nodes = [];
    var walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      nodes.push({ node: walker.currentNode, text: walker.currentNode.nodeValue });
    }
    var total = nodes.reduce(function (n, x) { return n + x.text.length; }, 0);
    var noise = ".:+*#%@/<>=";

    setTimeout(function () {
      var start = performance.now();
      el.classList.add("is-shown");

      function step(now) {
        var p = Math.min(1, (now - start) / duration);
        var locked = Math.floor(p * total);
        var k = 0;
        nodes.forEach(function (x) {
          var out = "";
          for (var i = 0; i < x.text.length; i++, k++) {
            var ch = x.text.charAt(i);
            out += (k < locked || ch === " ") ? ch : noise.charAt(Math.floor(Math.random() * noise.length));
          }
          x.node.nodeValue = out;
        });
        if (p < 1) requestAnimationFrame(step);
      }

      requestAnimationFrame(step);
    }, delay);
  }

  // Start the three.js scene.
  // Pass 1 renders the galaxy to a small target. Dust darkens the light after the stars.
  // Pass 2 draws the sky as a sunflower: one dot at each point of a Vogel spiral,
  //   n * 137.508 degrees round and c * sqrt(n) out from the core of the galaxy.
  //   The dot area follows the brightness of the galaxy at that point.
  // Passes 3 to 7 blur the dots into a soft glow and add it back.
  function startSky() {
    if (!window.THREE) throw new Error("three.js did not load.");

    var canvas = document.getElementById("sky");
    var renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: false });
    var pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(pixelRatio);
    renderer.setClearColor(0x000000, 0);

    var scene = new THREE.Scene();
    var camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    var fovTan = Math.tan(25 * Math.PI / 180);
    var cameraZ = 12;

    // Density wave model (after Ingo Berg): each star moves on an ellipse.
    // The major axes of the ellipses turn along a golden logarithmic spiral,
    // r = a * phi^(2 theta / pi), which has a pitch of 17.03 degrees.
    // Where the ellipses crowd, two arms appear. The stars flow through them.
    var R = 4.6;
    var CORE = 1.25;
    var COT_PITCH = Math.PI / (2 * Math.log(PHI));
    var EX_CORE = 0.62;
    var EX_EDGE = 0.84;
    var FAR = R * 1.4;

    // Get the axis ratio (minor over major) of the orbit at radius a.
    function axisRatio(a) {
      if (a < CORE) return 1 + (a / CORE) * (EX_CORE - 1);
      if (a < R) return EX_CORE + (a - CORE) / (R - CORE) * (EX_EDGE - EX_CORE);
      return EX_EDGE + Math.min(1, (a - R) / (FAR - R)) * (1 - EX_EDGE);
    }

    // Get the turn of the orbit at radius a: a golden logarithmic spiral.
    function orbitTurn(a) {
      return COT_PITCH * Math.log(Math.max(a, 0.35) / CORE);
    }

    // Get the angular speed at radius a. The inner disc turns faster.
    function orbitSpeed(a) {
      return 0.3 / (a + 0.75);
    }

    var armStops = [
      [0.0, new THREE.Color(0xffc178)],
      [0.25, new THREE.Color(0xff8fb8)],
      [0.55, new THREE.Color(0x6f86ff)],
      [1.0, new THREE.Color(0x9a6cff)]
    ];

    // Get the disc colour at a point from the centre (0) to the edge (1).
    function discColour(t, out) {
      for (var s = 1; s < armStops.length; s++) {
        if (t <= armStops[s][0] || s === armStops.length - 1) {
          var a = armStops[s - 1];
          var b = armStops[s];
          var f = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
          return out.copy(a[1]).lerp(b[1], f);
        }
      }
      return out;
    }

    // Particle kinds: 0 is a star, 1 is an H II region, 2 is dust.
    function makeLayer(count, fill) {
      var orbit = new Float32Array(count * 4);
      var extra = new Float32Array(count * 4);
      var start = new Float32Array(count * 3);
      var colour = new Float32Array(count * 3);
      var n = 0;

      function put(a, theta, height, rgb, gain, delay, kind) {
        orbit[n * 4] = a;
        orbit[n * 4 + 1] = axisRatio(a);
        orbit[n * 4 + 2] = orbitTurn(a);
        orbit[n * 4 + 3] = theta;
        extra[n * 4] = orbitSpeed(a);
        extra[n * 4 + 1] = height;
        extra[n * 4 + 2] = delay;
        extra[n * 4 + 3] = kind;
        var sr = 6 + Math.random() * 8;
        var st = Math.random() * Math.PI * 2;
        start[n * 3] = Math.cos(st) * sr;
        start[n * 3 + 1] = gauss() * 1.5;
        start[n * 3 + 2] = Math.sin(st) * sr;
        colour[n * 3] = rgb.r * gain;
        colour[n * 3 + 1] = rgb.g * gain;
        colour[n * 3 + 2] = rgb.b * gain;
        n++;
      }

      fill(put);

      var geometry = new THREE.BufferGeometry();
      // A position is required by three.js. The shader computes the real one.
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geometry.setAttribute("aOrbit", new THREE.BufferAttribute(orbit, 4));
      geometry.setAttribute("aExtra", new THREE.BufferAttribute(extra, 4));
      geometry.setAttribute("aStart", new THREE.BufferAttribute(start, 3));
      geometry.setAttribute("aColor", new THREE.BufferAttribute(colour, 3));
      return geometry;
    }

    var galaxyUniforms = {
      uTime: { value: 0 },
      uIntro: { value: playIntro ? 0 : 1 },
      uPattern: { value: 0 },
      uAlpha: { value: 0.11 }
    };

    var galaxyVertex = [
      "attribute vec4 aOrbit;",
      "attribute vec4 aExtra;",
      "attribute vec3 aStart;",
      "attribute vec3 aColor;",
      "uniform float uTime;",
      "uniform float uIntro;",
      "uniform float uPattern;",
      "varying vec3 vColor;",
      "void main() {",
      "  float a = aOrbit.x;",
      "  float th = aOrbit.w + uTime * aExtra.x;",
      "  float tilt = aOrbit.z + uPattern;",
      "  vec2 e = vec2(a * cos(th), a * aOrbit.y * sin(th));",
      "  float ct = cos(tilt);",
      "  float st = sin(tilt);",
      "  vec3 orbitPos = vec3(e.x * ct - e.y * st, aExtra.y, e.x * st + e.y * ct);",
      // Intro: fly in from far away on a swirl.
      "  float t = clamp((uIntro - aExtra.z * 0.55) / 0.45, 0.0, 1.0);",
      "  t = 1.0 - pow(1.0 - t, 3.0);",
      "  float ang = (1.0 - t) * 3.0;",
      "  float cs = cos(ang);",
      "  float sn = sin(ang);",
      "  vec3 s = vec3(cs * aStart.x - sn * aStart.z, aStart.y, sn * aStart.x + cs * aStart.z);",
      "  vec3 p = mix(s, orbitPos, t);",
      // The arm sits where the orbit is near the ends of its major axis.
      "  float arm = abs(cos(th));",
      "  float glow = 1.0;",
      "  if (aExtra.w < 0.5) {",
      "    float disc = smoothstep(0.7, 1.6, a);",
      "    glow = mix(1.0, 0.3 + 1.5 * pow(arm, 5.0), disc);",
      "  } else if (aExtra.w < 1.5) {",
      "    glow = pow(arm, 14.0) * 1.8;",
      "  } else {",
      "    glow = pow(abs(cos(th + 0.22)), 10.0);",
      "  }",
      "  vColor = aColor * glow * mix(0.4, 1.0, t);",
      "  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);",
      "  gl_PointSize = 1.0;",
      "}"
    ].join("\n");

    var lightMaterial = new THREE.ShaderMaterial({
      uniforms: galaxyUniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: galaxyVertex,
      fragmentShader: [
        "uniform float uAlpha;",
        "varying vec3 vColor;",
        "void main() {",
        "  gl_FragColor = vec4(vColor, uAlpha);",
        "}"
      ].join("\n")
    });

    // Dust multiplies the light that is already there by (1 - dust).
    var dustMaterial = new THREE.ShaderMaterial({
      uniforms: galaxyUniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.CustomBlending,
      blendEquation: THREE.AddEquation,
      blendSrc: THREE.ZeroFactor,
      blendDst: THREE.OneMinusSrcColorFactor,
      vertexShader: galaxyVertex,
      fragmentShader: [
        "varying vec3 vColor;",
        "void main() {",
        "  gl_FragColor = vec4(clamp(vColor, 0.0, 1.0), 1.0);",
        "}"
      ].join("\n")
    });

    var c = new THREE.Color();
    var bulgeColour = new THREE.Color(0xffc98a);
    var hazeColour = new THREE.Color(0x7a6cd8);
    var dustColour = new THREE.Color(0xffffff);
    var hiiColours = [0xff4f9a, 0xff4f9a, 0xff6ea8, 0x5ef2d6, 0xffb347].map(function (h) { return new THREE.Color(h); });

    var lights = makeLayer(52000 + 6000 + 8000 + 130 * 36, function (put) {
      var i;
      // Disc stars follow an exponential surface brightness.
      for (i = 0; i < 52000; i++) {
        var a = -2.1 * Math.log(1 - Math.random() * (1 - Math.exp(-R * 1.04 / 2.1)));
        discColour(Math.min(1, a / R), c);
        put(a, Math.random() * Math.PI * 2, gauss() * (0.05 + a * 0.02), c, 1, (a / R) * 0.6 + Math.random() * 0.4, 0);
      }
      // The bulge is round and warm.
      for (i = 0; i < 6000; i++) {
        var ab = Math.abs(gauss()) * 0.5;
        put(ab, Math.random() * Math.PI * 2, gauss() * 0.3 * Math.max(0.2, 1 - ab), bulgeColour, 1.15, Math.random() * 0.3, 0);
      }
      // A faint haze fills the disc between the arms.
      for (i = 0; i < 8000; i++) {
        var ah = Math.sqrt(Math.random()) * R * 1.05;
        put(ah, Math.random() * Math.PI * 2, gauss() * 0.08, hazeColour, 0.45, 0.3 + Math.random() * 0.7, 0);
      }
      // H II regions: clusters that glow only while they pass through an arm.
      // Their radii follow the golden-ratio sequence and their angles the golden angle,
      // so they spread evenly with no clumps.
      for (var q = 0; q < 130; q++) {
        var a0 = 1.2 + ((q / PHI) % 1) * (R * 0.95 - 1.2);
        var t0 = q * GOLDEN_ANGLE;
        var hc = hiiColours[q % hiiColours.length];
        for (var m = 0; m < 36; m++) {
          put(a0 + gauss() * 0.05, t0 + gauss() * 0.05, gauss() * 0.03, hc, 2.2, (a0 / R) * 0.6 + 0.3, 1);
        }
      }
    });

    var dust = makeLayer(30000, function (put) {
      for (var i = 0; i < 30000; i++) {
        var a = 0.9 + Math.pow(Math.random(), 0.8) * (R * 1.05 - 0.9);
        put(a, Math.random() * Math.PI * 2, gauss() * 0.03, dustColour, 0.045 + Math.random() * 0.035, 0.4 + (a / R) * 0.5, 2);
      }
    });

    var lightPoints = new THREE.Points(lights, lightMaterial);
    var dustPoints = new THREE.Points(dust, dustMaterial);
    lightPoints.frustumCulled = false;
    dustPoints.frustumCulled = false;
    lightPoints.renderOrder = 0;
    dustPoints.renderOrder = 1;

    // Tilt the disc so that it rises to the right.
    var tilt = new THREE.Group();
    var plane = new THREE.Group();
    tilt.scale.setScalar(0.92);
    tilt.add(plane);
    plane.add(lightPoints);
    plane.add(dustPoints);
    scene.add(tilt);

    var halfFloat = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, type: THREE.HalfFloatType, depthBuffer: false };
    var sceneTarget = new THREE.WebGLRenderTarget(2, 2, halfFloat);
    var dotTarget = new THREE.WebGLRenderTarget(2, 2, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false });
    var bloomA = new THREE.WebGLRenderTarget(2, 2, halfFloat);
    var bloomB = new THREE.WebGLRenderTarget(2, 2, halfFloat);

    var dotUniforms = {
      uScene: { value: sceneTarget.texture },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uSpacing: { value: 20 },
      uMinDim: { value: 900 },
      uGain: { value: 1.0 },
      uTime: { value: 0 },
      uReveal: { value: playIntro ? 0 : 1 },
      uLine: { value: 1 },
      uPixel: { value: 1 },
      uMeteor: { value: new THREE.Vector4(0, 0, 1, 0) },
      uMeteorFx: { value: new THREE.Vector2(200, 0) },
      uPalette: { value: STAR_COLOURS.map(function (hex) { return new THREE.Color(hex); }) }
    };

    var dotMaterial = new THREE.ShaderMaterial({
      uniforms: dotUniforms,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      vertexShader: [
        "attribute vec2 aPos;",
        "attribute vec4 aStar;",
        "attribute vec3 aInfo;",
        "uniform sampler2D uScene;",
        "uniform vec2 uResolution;",
        "uniform float uSpacing;",
        "uniform float uMinDim;",
        "uniform float uGain;",
        "uniform float uTime;",
        "uniform float uReveal;",
        "uniform float uPixel;",
        "uniform vec4 uMeteor;",
        "uniform vec2 uMeteorFx;",
        "uniform vec3 uPalette[7];",
        "varying vec3 vColor;",
        "varying float vRadius;",
        "varying float vSparkle;",
        "varying float vSize;",
        "const float PHI = 1.6180339887;",
        "void main() {",
        "  gl_Position = vec4(aPos.x / uResolution.x * 2.0 - 1.0, 1.0 - aPos.y / uResolution.y * 2.0, 0.0, 1.0);",
        "  float maxR = uSpacing * 0.46;",
        "  vColor = vec3(0.0);",
        "  vRadius = 0.0;",
        "  vSparkle = 0.0;",
        "  vSize = 2.0 * maxR + 2.0;",
        "  gl_PointSize = vSize;",
        "  if (aInfo.y > 0.5) {",
        "    gl_PointSize = 0.0;",
        "    return;",
        "  }",
        "  float h = aStar.z;",
        // The sunflower grows out from the core during the intro.
        "  float grown = smoothstep(aInfo.z - 0.04, aInfo.z, uReveal);",
        // The galaxy: dot area follows brightness, with a slow glitter.
        "  vec2 uv = vec2(aPos.x / uResolution.x, 1.0 - aPos.y / uResolution.y);",
        "  vec3 c = max(texture2D(uScene, uv).rgb, vec3(0.0));",
        "  float v = max(c.r, max(c.g, c.b));",
        "  float lum = clamp(pow(v * uGain, 0.85), 0.0, 1.0);",
        "  lum *= 0.86 + 0.14 * sin(uTime * (0.9 + h * PHI) + h * 60.0);",
        "  if (lum > 0.03) {",
        "    vRadius = max(0.6 * uPixel, maxR * sqrt(lum));",
        "    vColor = (c / max(v, 0.0001)) * mix(0.55, 1.0, lum) * smoothstep(0.03, 0.12, lum);",
        "  }",
        // The background stars sit on points of the same spiral.
        "  float kind = aStar.x;",
        "  if (vRadius < 0.6 * uPixel && kind > 0.5) {",
        "    int tone = int(aStar.w + 0.5);",
        "    vec3 tint = uPalette[0];",
        "    for (int i = 1; i < 7; i++) {",
        "      if (i == tone) tint = uPalette[i];",
        "    }",
        "    float speed = 0.5 + h * PHI;",
        "    if (kind > 2.5) {",
        "      vSparkle = 1.0;",
        "      vSize = uSpacing * 1.7;",
        "      gl_PointSize = vSize;",
        "      vRadius = uSpacing * 0.12;",
        "      vColor = tint * aStar.y * (0.65 + 0.35 * sin(uTime * speed + h * 40.0)) * grown;",
        "    } else {",
        "      vRadius = max(0.6 * uPixel, uSpacing * (kind > 1.5 ? 0.19 : 0.11));",
        "      vColor = tint * aStar.y * (0.82 + 0.18 * sin(uTime * speed + h * 40.0)) * grown;",
        "    }",
        "  }",
        // Every other point is a faint dot, so the spiral families of the sunflower show.
        // A slow circular wave runs out from the core through them.
        "  if (vRadius < 0.6 * uPixel) {",
        "    float rn = aInfo.x / uMinDim;",
        "    float wave = pow(0.5 + 0.5 * sin(6.2831853 * (rn * 2.2 - uTime * 0.09)), 10.0);",
        "    float level = 0.07 * exp(-rn * 1.6) + 0.03 + wave * 0.08 * exp(-rn * 0.9);",
        "    vRadius = 0.55 * uPixel + wave * 0.5 * uPixel;",
        "    vColor = vec3(0.62, 0.66, 1.0) * level * grown;",
        "  }",
        // A shooting star: a short trail of dots behind a moving head.
        "  if (uMeteorFx.y > 0.0) {",
        "    vec2 rel = uMeteor.xy - aPos;",
        "    float along = dot(rel, uMeteor.zw);",
        "    float across = abs(rel.x * uMeteor.w - rel.y * uMeteor.z);",
        "    if (along > -uSpacing && along < uMeteorFx.x && across < uSpacing * 0.9) {",
        "      float k = (1.0 - along / uMeteorFx.x) * uMeteorFx.y * (1.0 - across / (uSpacing * 0.9));",
        "      float mr = maxR * sqrt(k);",
        "      if (mr > vRadius) {",
        "        vRadius = mr;",
        "        vSparkle = 0.0;",
        "        vColor = vec3(1.0, 0.95, 0.86) * mix(0.5, 1.0, k);",
        "      }",
        "    }",
        "  }",
        "}"
      ].join("\n"),
      fragmentShader: [
        "uniform float uLine;",
        "varying vec3 vColor;",
        "varying float vRadius;",
        "varying float vSparkle;",
        "varying float vSize;",
        "void main() {",
        "  vec2 local = (gl_PointCoord - 0.5) * vSize;",
        "  float d = length(local);",
        "  float cover = clamp(vRadius - d + 0.5, 0.0, 1.0);",
        "  if (vSparkle > 0.5) {",
        "    float arm = vSize * 0.5;",
        "    float lx = clamp(uLine * 0.5 + 0.5 - abs(local.y), 0.0, 1.0) * max(0.0, 1.0 - abs(local.x) / arm);",
        "    float ly = clamp(uLine * 0.5 + 0.5 - abs(local.x), 0.0, 1.0) * max(0.0, 1.0 - abs(local.y) / arm);",
        "    cover = max(cover, max(lx, ly));",
        "  }",
        "  if (cover <= 0.001) discard;",
        "  gl_FragColor = vec4(vColor * cover, 1.0);",
        "}"
      ].join("\n")
    });

    var dotScene = new THREE.Scene();
    var dotPoints = null;

    var fullscreenVertex = [
      "varying vec2 vUv;",
      "void main() {",
      "  vUv = position.xy * 0.5 + 0.5;",
      "  gl_Position = vec4(position.xy, 0.0, 1.0);",
      "}"
    ].join("\n");

    // Make the glow: keep the bright parts at a quarter size.
    var downMaterial = new THREE.ShaderMaterial({
      uniforms: { tInput: { value: dotTarget.texture }, uTexel: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
      vertexShader: fullscreenVertex,
      fragmentShader: [
        "uniform sampler2D tInput;",
        "uniform vec2 uTexel;",
        "varying vec2 vUv;",
        "void main() {",
        "  vec3 c = texture2D(tInput, vUv + uTexel * vec2(-1.0, -1.0)).rgb;",
        "  c += texture2D(tInput, vUv + uTexel * vec2(1.0, -1.0)).rgb;",
        "  c += texture2D(tInput, vUv + uTexel * vec2(-1.0, 1.0)).rgb;",
        "  c += texture2D(tInput, vUv + uTexel * vec2(1.0, 1.0)).rgb;",
        "  c *= 0.25;",
        "  float b = max(c.r, max(c.g, c.b));",
        "  gl_FragColor = vec4(c * smoothstep(0.04, 0.3, b), 1.0);",
        "}"
      ].join("\n")
    });

    var blurMaterial = new THREE.ShaderMaterial({
      uniforms: { tInput: { value: null }, uDir: { value: new THREE.Vector2() } },
      depthTest: false,
      depthWrite: false,
      vertexShader: fullscreenVertex,
      fragmentShader: [
        "uniform sampler2D tInput;",
        "uniform vec2 uDir;",
        "varying vec2 vUv;",
        "void main() {",
        "  vec3 c = texture2D(tInput, vUv).rgb * 0.227027;",
        "  c += texture2D(tInput, vUv + uDir * 1.384615).rgb * 0.316216;",
        "  c += texture2D(tInput, vUv - uDir * 1.384615).rgb * 0.316216;",
        "  c += texture2D(tInput, vUv + uDir * 3.230769).rgb * 0.070270;",
        "  c += texture2D(tInput, vUv - uDir * 3.230769).rgb * 0.070270;",
        "  gl_FragColor = vec4(c, 1.0);",
        "}"
      ].join("\n")
    });

    var compositeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tBase: { value: dotTarget.texture },
        tBloom: { value: bloomA.texture },
        uStrength: { value: 1.1 }
      },
      depthTest: false,
      depthWrite: false,
      vertexShader: fullscreenVertex,
      fragmentShader: [
        "uniform sampler2D tBase;",
        "uniform sampler2D tBloom;",
        "uniform float uStrength;",
        "varying vec2 vUv;",
        "void main() {",
        "  vec3 c = texture2D(tBase, vUv).rgb + texture2D(tBloom, vUv).rgb * uStrength;",
        "  gl_FragColor = vec4(c, 1.0);",
        "}"
      ].join("\n")
    });

    var screenScene = new THREE.Scene();
    var screenCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    var quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), compositeMaterial);
    quad.frustumCulled = false;
    screenScene.add(quad);

    // Render one full-screen pass into a target, or to the screen when target is null.
    function pass(material, target) {
      quad.material = material;
      renderer.setRenderTarget(target);
      renderer.render(screenScene, screenCamera);
    }

    var bufferSize = new THREE.Vector2();
    var centre = new THREE.Vector2();
    var spacing = 20;
    var bloomW = 1;
    var bloomH = 1;

    // Build the sunflower: point n sits at angle n * golden angle and radius c * sqrt(n).
    // Each point covers the same area, so the dots spread evenly over the whole sky.
    function buildSunflower() {
      var W = bufferSize.x;
      var H = bufferSize.y;
      var cx = centre.x;
      var cy = centre.y;
      var c0 = spacing / Math.sqrt(Math.PI);
      var rMax = Math.max(
        Math.hypot(cx, cy), Math.hypot(W - cx, cy),
        Math.hypot(cx, H - cy), Math.hypot(W - cx, H - cy)
      ) + spacing;
      var total = Math.ceil(Math.pow(rMax / c0, 2));

      // Keep the points under text empty.
      var rects = [];
      document.querySelectorAll("[data-mask]").forEach(function (el) {
        var b = el.getBoundingClientRect();
        if (!b.width || !b.height) return;
        var pad = spacing * 0.7;
        rects.push([b.left * pixelRatio - pad, b.top * pixelRatio - pad, b.right * pixelRatio + pad, b.bottom * pixelRatio + pad]);
      });

      var pos = new Float32Array(total * 2);
      var star = new Float32Array(total * 4);
      var info = new Float32Array(total * 3);
      var random = seeded(1618);
      var count = 0;

      for (var n = 0; n < total; n++) {
        var r = c0 * Math.sqrt(n + 0.5);
        var th = n * GOLDEN_ANGLE;
        var x = cx + r * Math.cos(th);
        var y = cy + r * Math.sin(th);
        var roll = random();
        var light = random();
        var seed = random();
        var tone = pickTone(random());
        if (x < -spacing || y < -spacing || x > W + spacing || y > H + spacing) continue;

        var masked = 0;
        for (var k = 0; k < rects.length; k++) {
          var q = rects[k];
          if (x > q[0] && x < q[2] && y > q[1] && y < q[3]) { masked = 1; break; }
        }

        // Keep the core of the galaxy free of background stars.
        var kind = 0;
        var away = r > spacing * 6;
        if (away && roll < 0.024) {
          kind = 1;
          light = 0.4 + light * 0.35;
        } else if (away && roll < 0.036) {
          kind = 2;
          light = 0.55 + light * 0.35;
        } else if (away && roll < 0.0375) {
          kind = 3;
          light = 1;
        }

        pos[count * 2] = x;
        pos[count * 2 + 1] = y;
        star[count * 4] = kind;
        star[count * 4 + 1] = light;
        star[count * 4 + 2] = seed;
        star[count * 4 + 3] = tone;
        info[count * 3] = r;
        info[count * 3 + 1] = masked;
        info[count * 3 + 2] = r / rMax;
        count++;
      }

      var geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
      geometry.setAttribute("aPos", new THREE.BufferAttribute(pos.slice(0, count * 2), 2));
      geometry.setAttribute("aStar", new THREE.BufferAttribute(star.slice(0, count * 4), 4));
      geometry.setAttribute("aInfo", new THREE.BufferAttribute(info.slice(0, count * 3), 3));

      if (dotPoints) {
        dotScene.remove(dotPoints);
        dotPoints.geometry.dispose();
      }
      dotPoints = new THREE.Points(geometry, dotMaterial);
      dotPoints.frustumCulled = false;
      dotScene.add(dotPoints);
    }

    // Fit the sunflower, the glow, and the galaxy to the window.
    function resize() {
      var w = window.innerWidth;
      var h = window.innerHeight;
      renderer.setSize(w, h, false);
      renderer.getDrawingBufferSize(bufferSize);

      var small = w < 640;
      spacing = (small ? 8.5 : 10) * pixelRatio;
      var portrait = w / h < 0.85;
      var sx = portrait ? 0.5 : 0.6;
      var sy = portrait ? 0.38 : 0.42;
      centre.set(sx * bufferSize.x, sy * bufferSize.y);

      dotUniforms.uResolution.value.copy(bufferSize);
      dotUniforms.uSpacing.value = spacing;
      dotUniforms.uMinDim.value = Math.min(bufferSize.x, bufferSize.y);
      dotUniforms.uLine.value = Math.max(1, Math.round(pixelRatio));
      dotUniforms.uPixel.value = pixelRatio;
      sceneTarget.setSize(Math.ceil(bufferSize.x / spacing) * 2, Math.ceil(bufferSize.y / spacing) * 2);
      dotTarget.setSize(bufferSize.x, bufferSize.y);
      bloomW = Math.max(1, Math.ceil(bufferSize.x / 4));
      bloomH = Math.max(1, Math.ceil(bufferSize.y / 4));
      bloomA.setSize(bloomW, bloomH);
      bloomB.setSize(bloomW, bloomH);
      downMaterial.uniforms.uTexel.value.set(1 / bufferSize.x, 1 / bufferSize.y);

      var aspect = bufferSize.x / bufferSize.y;
      camera.aspect = aspect;
      cameraZ = Math.max(12, 11.5 / aspect);
      camera.updateProjectionMatrix();
      camera.position.set(0, 0, cameraZ);
      camera.lookAt(0, 0, 0);

      // Put the core of the galaxy exactly on the centre of the sunflower.
      var halfH = cameraZ * fovTan;
      var halfW = halfH * aspect;
      tilt.position.set((sx * 2 - 1) * halfW, (1 - sy * 2) * halfH, 0);

      buildSunflower();
    }

    // Shooting stars cross the sky now and then, after the intro.
    var meteor = { on: false, t: 0, life: 1, x: 0, y: 0, dx: 0, dy: 0, speed: 0 };
    var nextMeteor = INTRO_SECONDS + 4 + Math.random() * 5;

    function launchMeteor() {
      var left = Math.random() < 0.5;
      var angle = (left ? 205 : 335) * Math.PI / 180 + (Math.random() - 0.5) * 0.35;
      meteor.dx = Math.cos(angle);
      meteor.dy = -Math.sin(angle);
      meteor.x = (left ? 0.45 + Math.random() * 0.5 : 0.05 + Math.random() * 0.5) * bufferSize.x;
      meteor.y = (0.04 + Math.random() * 0.3) * bufferSize.y;
      meteor.speed = bufferSize.y * (0.9 + Math.random() * 0.5);
      meteor.life = 0.8 + Math.random() * 0.4;
      meteor.t = 0;
      meteor.on = true;
    }

    var clock = new THREE.Clock();
    var time = 0;
    var introTime = playIntro ? 0 : INTRO_SECONDS;

    function frame() {
      var dt = Math.min(clock.getDelta(), 0.05);
      var still = reduceMotion.matches;

      introTime = Math.min(INTRO_SECONDS, introTime + dt);
      galaxyUniforms.uIntro.value = introTime / INTRO_SECONDS;
      dotUniforms.uReveal.value = Math.min(1.05, Math.max(0, (introTime - 0.2) / 2.2) * 1.05);

      if (!still) {
        time += dt;
        // A slow drift in tilt gives the disc depth. The two periods differ by phi,
        // so the motion never repeats exactly.
        plane.rotation.x = 0.82 + 0.04 * Math.sin(time * 0.06);
        tilt.rotation.z = 0.5 + 0.02 * Math.sin(time * 0.06 / PHI + 1.3);

        if (time > nextMeteor && !meteor.on) {
          launchMeteor();
          nextMeteor = time + 7 + Math.random() * 9;
        }
      } else {
        plane.rotation.x = 0.82;
        tilt.rotation.z = 0.5;
      }

      galaxyUniforms.uTime.value = time + 40;
      galaxyUniforms.uPattern.value = -(time + 40) * 0.012;
      dotUniforms.uTime.value = time;

      if (meteor.on) {
        meteor.t += dt;
        meteor.x += meteor.dx * meteor.speed * dt;
        meteor.y += meteor.dy * meteor.speed * dt;
        var life = meteor.t / meteor.life;
        var fade = Math.min(1, life * 6) * Math.max(0, 1 - Math.pow(life, 3));
        dotUniforms.uMeteor.value.set(meteor.x, meteor.y, meteor.dx, meteor.dy);
        dotUniforms.uMeteorFx.value.set(spacing * (14 + 8 * fade), fade);
        if (life >= 1) {
          meteor.on = false;
          dotUniforms.uMeteorFx.value.y = 0;
        }
      }

      // The glow breathes slowly.
      compositeMaterial.uniforms.uStrength.value = 1.05 + 0.12 * Math.sin(time * 0.8);

      renderer.setRenderTarget(sceneTarget);
      renderer.render(scene, camera);
      renderer.setRenderTarget(dotTarget);
      renderer.render(dotScene, screenCamera);

      pass(downMaterial, bloomA);
      blurMaterial.uniforms.tInput.value = bloomA.texture;
      blurMaterial.uniforms.uDir.value.set(1 / bloomW, 0);
      pass(blurMaterial, bloomB);
      blurMaterial.uniforms.tInput.value = bloomB.texture;
      blurMaterial.uniforms.uDir.value.set(0, 1 / bloomH);
      pass(blurMaterial, bloomA);
      blurMaterial.uniforms.tInput.value = bloomA.texture;
      blurMaterial.uniforms.uDir.value.set(2 / bloomW, 0);
      pass(blurMaterial, bloomB);
      blurMaterial.uniforms.tInput.value = bloomB.texture;
      blurMaterial.uniforms.uDir.value.set(0, 2 / bloomH);
      pass(blurMaterial, bloomA);
      pass(compositeMaterial, null);

      requestAnimationFrame(frame);
    }

    resize();
    window.addEventListener("resize", resize);

    // Build the sunflower again after the web font changes the text size.
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(buildSunflower, function () {});
    }

    requestAnimationFrame(frame);
  }

  try {
    startSky();
  } catch (err) {
    // The text still shows if WebGL is not available.
  }

  // Run the text part of the intro.
  if (playIntro) {
    decode(document.querySelector(".hud .host"), 1700, 600);
    decode(document.querySelector(".def"), 2300, 900);
    decode(document.querySelector(".math"), 2700, 900);
  }

  // Show the UTC time in the top corner.
  function tick() {
    clockLabel.textContent = new Date().toISOString().slice(11, 19) + " utc";
  }
  tick();
  setInterval(tick, 1000);
})();
