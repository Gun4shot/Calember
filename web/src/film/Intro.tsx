// The opening of the story: one ember in the dark catches into a flame, flares, and the camera pulls back until the
// flame is a single point of light on the night Earth (Punjab, where the story begins). Four lines are spoken over it
// (the first two after Sandesh's intro), then the frame burns away and the story's title ignites letter by letter.
// One WebGL2 fragment shader (no extra libraries) and a synthesized score (introSound.ts).
// Plays on every load of the story; skipped only for `?t=` review links and under reduced motion.
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { IntroSound } from "./introSound";

const VS = `#version 300 es
in vec2 aPos; out vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 outColor;
uniform vec2 uRes; uniform float uT; uniform float uBurn; uniform sampler2D uEarth; uniform float uHasEarth; uniform mat3 uRot;
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(h21(i), h21(i+vec2(1,0)), u.x), mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float s = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ s += a * vn(p); p = p * 2.02 + 17.3; a *= 0.5; } return s; }
float sstep(float a, float b, float x){ return smoothstep(a, b, x); }

// fire colour: deep red -> orange -> yellow -> white core
vec3 fireCol(float i){
  vec3 c = mix(vec3(0.35, 0.03, 0.01), vec3(1.0, 0.36, 0.04), sstep(0.05, 0.45, i));
  c = mix(c, vec3(1.0, 0.78, 0.32), sstep(0.45, 0.8, i));
  return mix(c, vec3(1.0, 0.97, 0.88), sstep(0.8, 1.05, i));
}

void main(){
  vec2 q = (vUv - 0.5) * vec2(uRes.x / uRes.y, 1.0);   // centred, units = screen height
  float t = uT;
  vec3 col = vec3(0.0);
  // ---- stars (fade in with the Earth)
  float earthIn = sstep(3.7, 5.6, t);
  vec2 sg = floor(q * 260.0);
  float st = step(0.9965, h21(sg)) * (0.4 + 0.6 * h21(sg + 7.0));
  col += vec3(0.75, 0.82, 1.0) * st * earthIn * 0.8;

  // ---- the Earth, pulling back from the fire (Punjab stays at the centre of the frame)
  float zoomK = sstep(3.5, 6.6, t);
  float r = mix(3.2, 0.40, 1.0 - pow(clamp(1.0 - zoomK, 0.0, 1.0), 3.0));       // sphere radius in screen heights
  vec3 n0 = normalize(vec3(0.0, 0.33, 0.944));                   // where Punjab faces after uRot
  vec2 c = -r * n0.xy;                                            // so Punjab lands on (0,0)
  vec2 d = (q - c) / r;
  float dd = dot(d, d);
  if (dd < 1.0) {
    vec3 n = vec3(d, sqrt(1.0 - dd));
    vec3 w = transpose(uRot) * n;                                // view -> world
    float lat = asin(clamp(w.y, -1.0, 1.0)), lon = atan(w.x, w.z);
    vec2 uv = vec2(lon / 6.2831853 + 0.5, lat / 3.1415927 + 0.5);
    vec3 tx = uHasEarth > 0.5 ? texture(uEarth, uv).rgb : vec3(0.02);
    float lum = dot(tx, vec3(0.299, 0.587, 0.114));
    vec3 e = vec3(0.012, 0.018, 0.035) + tx * vec3(0.30, 0.42, 0.75) * 0.5 + vec3(0.62, 0.72, 0.95) * sstep(0.28, 0.9, lum) * 0.5;
    float fres = pow(clamp(1.0 - n.z, 0.0, 1.0), 3.0);
    e += vec3(0.08, 0.18, 0.45) * fres;
    col = mix(col, e, earthIn);
  }
  // atmosphere rim
  float rim = exp(-pow(abs((sqrt(dd) - 1.0) * r / 0.018), 2.0)) * earthIn;
  col += vec3(0.25, 0.5, 1.0) * rim * 0.55;

  // ---- the ember, the flame and the sparks
  float emb = sstep(0.05, 1.1, t);
  float flick = 0.85 + 0.15 * sin(t * 13.0) * sin(t * 7.3 + 1.0);
  float grow = sstep(1.2, 3.1, t) * (1.0 - sstep(3.45, 4.1, t));             // flame height
  float flash = exp(-pow(abs((t - 3.45) / 0.18), 2.0));                             // the flare
  float shrink = mix(1.0, 0.25, sstep(3.6, 6.4, t));                           // the ember becomes a hotspot
  vec2 p = q / shrink;
  // flame body: domain-warped noise scrolling upward, narrowing to the tips
  float h = 0.42 * grow + 1e-3, w = 0.095 * (0.5 + 0.5 * grow);
  float n1 = fbm(vec2(p.x * 6.0, p.y * 4.0 - t * 3.8));
  float n2 = fbm(vec2(p.x * 15.0 + 3.1, p.y * 9.0 - t * 6.0));
  float yy = (p.y + 0.012) / h;
  float xx = (p.x + (n1 - 0.5) * 0.17 * clamp(yy, 0.0, 1.2) + (n2 - 0.5) * 0.035 * clamp(yy + 0.3, 0.0, 1.0)) / w;
  float taper = 1.0 - 0.9 * clamp(yy, 0.0, 1.0);
  float tongues = 0.75 + 0.5 * sin(xx * 5.0 + n1 * 6.0 - t * 2.0); // forked tips
  float body = (1.0 - sstep(0.12 * taper, taper, abs(xx))) * sstep(-0.25, 0.02, yy) * (1.0 - sstep(0.35, 1.0, yy * (1.15 - 0.3 * tongues) + (n2 - 0.5) * 0.7));
  float I = body * (0.7 + 0.55 * n2) * grow;
  // core ember: a breathing hot point with a halo
  float rr = length(p);
  float core = exp(-rr * rr / 0.00012) * emb * flick;
  float halo = exp(-rr * rr / mix(0.0025, 0.006, grow)) * emb * (0.45 + 0.4 * grow) * flick;
  float glow = exp(-rr / mix(0.08, 0.2, grow)) * emb * 0.28;
  // sparks drifting up
  float sp = 0.0;
  for (int i = 0; i < 26; i++) {
    float fi = float(i);
    float hs = h21(vec2(fi, 3.7)), hs2 = h21(vec2(fi, 9.1));
    float per = 1.2 + hs * 1.6;
    float life = fract(t / per + hs2);
    vec2 sp0 = vec2((hs - 0.5) * 0.05 + sin(life * 6.0 + fi) * 0.02 * life, life * (0.12 + 0.35 * grow + 0.05));
    sp0.x += (hs2 - 0.5) * 0.18 * life;
    float a = (1.0 - life) * sstep(0.0, 0.1, life) * sstep(0.6, 1.6, t);
    sp += exp(-dot(p - sp0, p - sp0) / 0.000012) * a;
  }
  float fireI = clamp(I + core * 1.2 + halo * 0.7 + flash * 0.9 * exp(-rr / 0.06), 0.0, 1.4);
  vec3 fc = fireCol(fireI) * (fireI > 0.0 ? 1.0 : 0.0);
  col = col * (1.0 - clamp(fireI, 0.0, 1.0) * 0.9) + fc * fireI * 1.25;
  col += vec3(1.0, 0.42, 0.08) * glow * (1.0 - 0.6 * earthIn);
  col += vec3(1.0, 0.7, 0.3) * sp * 1.4;
  col += vec3(1.0, 0.85, 0.6) * flash * exp(-rr * rr / 0.09) * 0.6;          // the frame lights up
  // the hotspot on the planet keeps pulsing
  float hot = exp(-rr * rr / 0.00004) * earthIn * (0.7 + 0.3 * sin(t * 4.0));
  col += vec3(1.0, 0.55, 0.15) * hot * 1.3;
  // vignette
  col *= 1.0 - 0.45 * dot(q, q);

  // ---- burn-away: the frame burns off, with glowing edges, to reveal the story
  float a = 1.0;
  if (uBurn > 0.0) {
    float nb = fbm(q * 2.6 + 4.0) * 0.75 + fbm(q * 9.0) * 0.25;
    float thr = uBurn * 1.25 - 0.1 + length(q) * 0.25 * uBurn;
    float edge = sstep(thr - 0.06, thr, nb) - sstep(thr, thr + 0.012, nb);
    a = sstep(thr - 0.005, thr + 0.005, nb);
    col += fireCol(0.85) * edge * 2.2;
    a = max(a, edge);
  }
  outColor = vec4(col, a);
}`;

/** Rotation that turns Punjab (30.6°N, 75.6°E) to face the viewer, a little above centre. */
function rotForPunjab(): Float32Array {
  const la = (30.6 * Math.PI) / 180, lo = (75.6 * Math.PI) / 180;
  const w = [Math.cos(la) * Math.sin(lo), Math.sin(la), Math.cos(la) * Math.cos(lo)];
  const n0 = [0, 0.33, 0.944];
  const len = Math.hypot(...n0);
  const v = n0.map((x) => x / len);
  // Rodrigues rotation from w to v
  const ax = [w[1] * v[2] - w[2] * v[1], w[2] * v[0] - w[0] * v[2], w[0] * v[1] - w[1] * v[0]];
  const s = Math.hypot(...ax), cth = w[0] * v[0] + w[1] * v[1] + w[2] * v[2];
  const k = ax.map((x) => x / (s || 1));
  const K = [0, -k[2], k[1], k[2], 0, -k[0], -k[1], k[0], 0];
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const K2 = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let m = 0; m < 3; m++) K2[i * 3 + j] += K[i * 3 + m] * K[m * 3 + j];
  const Rm = I.map((x, i) => x + s * K[i] + (1 - cth) * K2[i]);
  // column-major for GLSL
  return new Float32Array([Rm[0], Rm[3], Rm[6], Rm[1], Rm[4], Rm[7], Rm[2], Rm[5], Rm[8]]);
}

// ---- timeline (real seconds). The shader's own clock runs slower through the ember and the flame, so the lines can
// be read, then 1:1 from the flare on.
const FLASH = 4.9; // the flare (shader t = 3.45)
const SHOW = 11.0; // the burn-away starts
const BURN = 1.4;
const SKIP_BURN = 0.8;
function shaderT(r: number): number {
  if (r < 2.2) return r * (1.2 / 2.2);
  if (r < FLASH) return 1.2 + ((r - 2.2) * 2.25) / (FLASH - 2.2);
  return 3.45 + (r - FLASH);
}

// The claims are checked against our data: the world has about 290,000 MODIS-equivalent hotspots a month (thousands
// a day), the record starts in November 2000, Terra and Aqua end science operations in 2027, and S-NPP fire
// production stopped in November 2026.
const LINES = [
  { t0: 0.5, t1: 2.2, text: "It starts small." },
  { t0: 2.7, t1: 4.95, text: "Every day, thousands of fires start somewhere on Earth." },
  { t0: 5.9, t1: 8.1, text: "Satellites have watched them from orbit since 2000." },
  { t0: 8.65, t1: SHOW + 0.1, text: "Now the oldest of them are going dark." },
];

type LinePhase = "wait" | "in" | "out";

export function shouldPlayIntro(): boolean {
  if (typeof window === "undefined") return false;
  const q = new URLSearchParams(location.search);
  if (q.has("intro")) return true;
  if (q.has("t")) return false; // review links open the film at a given moment
  return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** One line of the intro: each letter catches like an ember, cools to white, then drifts up as ash. */
function IntroLine({ text, phase }: { text: string; phase: LinePhase }) {
  const words = useMemo(() => {
    let k = 0;
    return text.split(" ").map((w) =>
      [...w].map((ch) => {
        const i = k++;
        const h = Math.sin(i * 12.9898 + text.length * 78.233) * 43758.5453;
        return { ch, i, dx: (h - Math.floor(h)) * 2 - 1 };
      }),
    );
  }, [text]);
  return (
    <p className={`il il-${phase}`}>
      {words.map((w, wi) => (
        // the space sits between the word boxes (inside an inline-block it would collapse)
        <Fragment key={wi}>
          <span className="il-w">
            {w.map(({ ch, i, dx }) => (
              <span className="il-c" key={i} style={{ ["--i" as string]: i, ["--dx" as string]: dx.toFixed(2) }}>
                {ch}
              </span>
            ))}
          </span>
          {wi < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </p>
  );
}

export function Intro({ onDone }: { onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [phase, setPhase] = useState<"play" | "burn">("play");
  const [lines, setLines] = useState<LinePhase[]>(() => LINES.map(() => "wait"));
  const [sound, setSound] = useState<"on" | "off" | "blocked">("blocked");
  const skipAt = useRef<number | null>(null);
  const skipRef = useRef<() => void>(() => undefined);
  const soundRef = useRef<IntroSound | null>(null);
  const userOff = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone; // the parent re-renders while the story loads; never restart the intro for that

  const toggleSound = () => {
    const snd = soundRef.current;
    if (!snd) return;
    if (snd.running) {
      snd.mute();
      userOff.current = true;
      setSound("off");
    } else {
      userOff.current = false;
      void snd.unlock().then((ok) => setSound(ok ? "on" : "blocked"));
    }
  };

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const gl = cv.getContext("webgl2", { premultipliedAlpha: false, alpha: true });
    if (!gl) {
      doneRef.current();
      return;
    }
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.warn(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      console.warn(gl.getProgramInfoLog(prog));
      doneRef.current();
      return;
    }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const U = (n: string) => gl.getUniformLocation(prog, n);
    gl.uniformMatrix3fv(U("uRot"), false, rotForPunjab());
    gl.uniform1i(U("uEarth"), 0);
    gl.uniform1f(U("uHasEarth"), 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // NASA Black Marble 2016 (public domain; the same texture the story uses)
    const img = new Image();
    img.onload = () => {
      const tex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // north at the top, as three.js loads it for the story
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, img);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.uniform1f(U("uHasEarth"), 1);
    };
    img.src = `${import.meta.env.BASE_URL}static/textures/black_marble_2016_3600.jpg`;

    const t0 = performance.now();
    const clock = () => (performance.now() - t0) / 1000;
    // the score; browsers only allow audio after a click or key press, so it usually waits for one
    const snd = new IntroSound({ flash: FLASH, show: SHOW, burn: BURN, lines: LINES.map((l) => l.t0) }, clock);
    soundRef.current = snd;
    snd.onStart = () => setSound("on");
    let autoT = 0;
    if (snd.init()) {
      autoT = window.setTimeout(() => {
        if (snd.tryAutostart()) setSound("on");
      }, 120);
    }

    let raf = 0;
    let lineKey = "";
    const frame = () => {
      const dpr = Math.min(1.5, window.devicePixelRatio || 1);
      const w = Math.floor(cv.clientWidth * dpr), h = Math.floor(cv.clientHeight * dpr);
      if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
      }
      gl.viewport(0, 0, w, h);
      const now = clock();
      const skipped = skipAt.current;
      const burnStart = skipped !== null ? skipped : SHOW;
      const t = shaderT(Math.min(now, burnStart + 0.2));
      const burn = Math.max(0, (now - burnStart) / (skipped !== null ? SKIP_BURN : BURN));
      gl.uniform2f(U("uRes"), w, h);
      gl.uniform1f(U("uT"), t);
      gl.uniform1f(U("uBurn"), Math.min(1, burn));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      // the lines: in while their time runs, out after it (or at a skip); never shown if skipped before they began
      const ph = LINES.map((l): LinePhase => {
        const end = Math.min(l.t1, skipped ?? Infinity);
        if (now < l.t0 || l.t0 >= end) return "wait";
        return now < end ? "in" : "out";
      });
      const key = ph.join();
      if (key !== lineKey) {
        lineKey = key;
        setLines(ph);
      }
      if (burn > 0 && burn < 1) {
        setPhase((p) => (p === "burn" ? p : "burn"));
        document.body.dataset.intro = "done"; // the story's title ignites underneath the burn
      }
      if (burn >= 1) {
        doneRef.current();
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    const skip = () => {
      if (skipAt.current !== null) return;
      const at = clock();
      if (at >= SHOW) return; // already burning away
      skipAt.current = at;
      snd.skip(SKIP_BURN);
    };
    skipRef.current = skip;
    // browsers only start audio after a click, tap or key press: the first one anywhere on the page (the fire,
    // the "Skip intro" button, a key) turns the sound on. The sound button handles its own clicks.
    const wake = (e?: Event) => {
      if ((e?.target as HTMLElement | null)?.closest?.(".intro-sound")) return;
      if (!snd.running && !userOff.current) void snd.unlock().then((ok) => ok && setSound("on"));
    };
    const onKey = (e: KeyboardEvent) => {
      wake();
      if (e.key === "Escape" || e.key === "Enter" || e.key === " ") skip();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", wake, true);
    window.addEventListener("touchend", wake, true);
    window.addEventListener("wheel", skip, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(autoT);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("wheel", skip);
      window.removeEventListener("pointerdown", wake, true);
      window.removeEventListener("touchend", wake, true);
      snd.dispose();
    };
  }, []);

  return (
    <div className={`intro intro-${phase}`}>
      <canvas ref={canvas} className="intro-canvas" aria-hidden="true" />
      <div className="intro-lines" aria-live="polite">
        {LINES.map((l, i) => (
          <IntroLine key={i} text={l.text} phase={lines[i]} />
        ))}
      </div>
      <div className="intro-ctl">
        <button
          type="button"
          className={`intro-sound ${sound}`}
          onClick={toggleSound}
          aria-pressed={sound === "on"}
          title={sound === "blocked" ? "Browsers wait for a click before they play sound" : undefined}
        >
          <span className="is-bars" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          {sound === "on" ? "Sound on" : sound === "blocked" ? "Tap for sound" : "Sound off"}
        </button>
        <button type="button" className="intro-skip" onClick={() => skipRef.current()}>
          Skip intro
        </button>
      </div>
    </div>
  );
}
