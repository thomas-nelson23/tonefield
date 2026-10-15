import type { ModelDefinition, MusicFrame, NoteEvent, ParamValues, PointerInput, SimulationModel, Viewport } from "./types";
import { noteHue } from "./lib/music";
import { Feedback, applyFeedback, colourParam, feedbackParams, hueToward, schemeHue } from "./lib/visual";
import { fade, hsla, type Colour, type Gfx } from "../gl/gfx";
import { gravityModeParam, isUniform, uniformDir } from "./lib/gravity";

// ---- Shapes ----------------------------------------------------------------

type V3 = [number, number, number];

const PHI = (1 + Math.sqrt(5)) / 2;

/** A polyhedron: corners at most 1 from the centre, and faces as corner lists wound anticlockwise seen from outside. */
interface Shape {
  verts: V3[];
  faces: number[][];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** Every sign flip of `base`, in every ordering (or only the cyclic ones). */
function signed(base: V3, cyclic = false): V3[] {
  const orders = cyclic ? [[0, 1, 2], [1, 2, 0], [2, 0, 1]] : [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const out = new Map<string, V3>();
  for (const o of orders) {
    for (let s = 0; s < 8; s++) {
      const v: V3 = [base[o[0]] * (s & 1 ? -1 : 1), base[o[1]] * (s & 2 ? -1 : 1), base[o[2]] * (s & 4 ? -1 : 1)];
      out.set(v.map((c) => c.toFixed(5)).join(), v);
    }
  }
  return [...out.values()];
}

/** The faces of the convex hull of `pts`: every plane that has all the points on one side. */
function hull(pts: V3[]): number[][] {
  const n = pts.length, faces: number[][] = [], seen = new Set<string>();
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let k = j + 1; k < n; k++) {
        let nrm = cross(sub(pts[j], pts[i]), sub(pts[k], pts[i]));
        if (Math.hypot(...nrm) < 1e-9) continue;
        nrm = unit(nrm);
        const d = dot(nrm, pts[i]);
        let above = 0, below = 0;
        const on: number[] = [];
        for (let m = 0; m < n; m++) {
          const s = dot(nrm, pts[m]) - d;
          if (s > 1e-6) above++;
          else if (s < -1e-6) below++;
          else on.push(m);
        }
        if (above && below) continue;
        const key = on.join();
        if (seen.has(key)) continue;
        seen.add(key);
        if (above) nrm = [-nrm[0], -nrm[1], -nrm[2]];
        // Order the corners round the face, anticlockwise about its outward normal.
        const c = centroid(pts, on);
        const u = unit(sub(pts[on[0]], c)), w = cross(nrm, u);
        const angle = (m: number) => { const r = sub(pts[m], c); return Math.atan2(dot(r, w), dot(r, u)); };
        faces.push(on.sort((a, b) => angle(a) - angle(b)));
      }
    }
  }
  return faces;
}

function centroid(pts: V3[], ids: number[]): V3 {
  const c: V3 = [0, 0, 0];
  for (const i of ids) { c[0] += pts[i][0]; c[1] += pts[i][1]; c[2] += pts[i][2]; }
  return [c[0] / ids.length, c[1] / ids.length, c[2] / ids.length];
}

/** Outward normal of a face from its winding (Newell's method). */
function faceNormal(pts: V3[], f: number[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < f.length; i++) {
    const a = pts[f[i]], b = pts[f[(i + 1) % f.length]];
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return unit(n);
}

/** Scale the corners so the farthest is 1 from the centre. */
function toUnit(pts: V3[]): V3[] {
  const r = Math.max(...pts.map((p) => Math.hypot(...p)));
  return pts.map((p) => [p[0] / r, p[1] / r, p[2] / r]);
}

function convex(pts: V3[]): Shape {
  const verts = toUnit(pts);
  return { verts, faces: hull(verts) };
}

const TETRA: V3[] = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];

const SHAPES: { value: string; label: string; build: () => Shape }[] = [
  { value: "tetra", label: "Tetrahedron", build: () => convex(TETRA) },
  { value: "cube", label: "Cube", build: () => convex(signed([1, 1, 1])) },
  { value: "octa", label: "Octahedron", build: () => convex(signed([1, 0, 0])) },
  { value: "dodeca", label: "Dodecahedron", build: () => convex([...signed([1, 1, 1]), ...signed([0, 1 / PHI, PHI], true)]) },
  { value: "icosa", label: "Icosahedron", build: () => convex(signed([0, 1, PHI], true)) },
  { value: "cubocta", label: "Cuboctahedron", build: () => convex(signed([1, 1, 0])) },
  { value: "icosidodeca", label: "Icosidodecahedron", build: () => convex([...signed([0, 0, PHI], true), ...signed([0.5, PHI / 2, (PHI * PHI) / 2], true)]) },
  { value: "prism", label: "Hexagonal prism", build: () => {
    const pts: V3[] = [];
    for (let i = 0; i < 6; i++) for (const y of [-0.8, 0.8]) pts.push([Math.cos((i * Math.PI) / 3), y, Math.sin((i * Math.PI) / 3)]);
    return convex(pts);
  } },
  { value: "stella", label: "Star: two tetrahedra", build: () => {
    const a = convex(TETRA);
    const verts: V3[] = [...a.verts, ...a.verts.map((v): V3 => [-v[0], -v[1], -v[2]])];
    return { verts, faces: [...a.faces, ...a.faces.map((f) => f.map((i) => i + 4))] };
  } },
  { value: "torus", label: "Torus", build: () => {
    const U = 12, W = 6, R = 0.68, r = 0.32, verts: V3[] = [], faces: number[][] = [];
    for (let i = 0; i < U; i++) {
      const u = (i * Math.PI * 2) / U;
      for (let j = 0; j < W; j++) {
        const v = (j * Math.PI * 2) / W;
        verts.push([(R + r * Math.cos(v)) * Math.cos(u), r * Math.sin(v), (R + r * Math.cos(v)) * Math.sin(u)]);
      }
    }
    for (let i = 0; i < U; i++) {
      for (let j = 0; j < W; j++) {
        const f = [i * W + j, ((i + 1) % U) * W + j, ((i + 1) % U) * W + ((j + 1) % W), i * W + ((j + 1) % W)];
        // Outward means away from the middle of the tube.
        const u = ((i + 0.5) * Math.PI * 2) / U;
        const tube: V3 = [R * Math.cos(u), 0, R * Math.sin(u)];
        if (dot(faceNormal(verts, f), sub(centroid(verts, f), tube)) < 0) f.reverse();
        faces.push(f);
      }
    }
    return { verts, faces };
  } },
];

// ---- Meshes ----------------------------------------------------------------

/**
 * A shape cut into small triangles. Each face is fanned into triangles round
 * its centre (so a spike can rise from the centre), and each of those split
 * into four `depth - 1` times (so the face can bend into a sphere). Every
 * small triangle keeps its corners as weights of its fan triangle's two face
 * corners and the face centre, and tags each of its sides with the depth it
 * appeared at: 0 the face's own outline, 1 the fan's spokes, 2 and 3 the
 * splits. Shared inner sides are drawn by one triangle only (-1 on the other).
 */
interface Mesh {
  name: string;
  verts: V3[];
  polys: number;
  /** Corners of each face, as `cVert[cStart[f] .. cStart[f + 1]]`. */
  cStart: Int32Array;
  cVert: Int32Array;
  /** Per face: centre, outward normal, a random tumble axis (3 each), height 0..1, and which way it folds open. */
  pc: Float32Array;
  pn: Float32Array;
  pAxis: Float32Array;
  pBin: Float32Array;
  pFold: Float32Array;
  tris: number;
  tPoly: Int32Array;
  tFan: Int32Array;
  tW: Float32Array;
  tEdge: Int8Array;
}

const meshes = new Map<string, Mesh>();

function buildMesh(id: string, depth: number): Mesh {
  const def = SHAPES.find((s) => s.value === id) ?? SHAPES[4];
  const shape = def.build();
  const V = shape.verts;
  // Lowest faces first, so low notes light the bottom and high ones the top.
  const order = shape.faces.map((f) => ({ f, c: centroid(V, f), n: faceNormal(V, f) }));
  order.sort((a, b) => Math.round(a.c[1] * 1000) - Math.round(b.c[1] * 1000) || Math.atan2(a.c[2], a.c[0]) - Math.atan2(b.c[2], b.c[0]));
  const polys = order.length;
  const cStart = new Int32Array(polys + 1);
  const cVert: number[] = [];
  const pc = new Float32Array(polys * 3), pn = new Float32Array(polys * 3), pAxis = new Float32Array(polys * 3);
  const pBin = new Float32Array(polys), pFold = new Float32Array(polys);
  const tPoly: number[] = [], tFan: number[] = [], tW: number[] = [], tEdge: number[] = [];
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  order.forEach(({ f, c, n }, p) => {
    cStart[p] = cVert.length;
    cVert.push(...f);
    pc.set(c, p * 3);
    pn.set(n, p * 3);
    const ax = unit([rand() - 0.5, rand() - 0.5, rand() - 0.5]);
    pAxis.set(ax, p * 3);
    pBin[p] = Math.min(1, Math.max(0, c[1] * 0.5 + 0.5));
    // Fold about the first side, whichever way swings the face outward.
    const h = V[f[0]], u = unit(sub(V[f[1]], h));
    const moved = rotate(sub(c, h), u, 0.1);
    pFold[p] = dot(sub([moved[0] + h[0], moved[1] + h[1], moved[2] + h[2]], c), n) >= 0 ? 1 : -1;

    const drawn = new Set<string>();
    for (let k = 0; k < f.length; k++) {
      const A = V[f[k]], B = V[f[(k + 1) % f.length]];
      const at = (w: number[]) => [0, 1, 2].map((i) => (w[0] * A[i] + w[1] * B[i] + w[2] * c[i]).toFixed(4)).join();
      const emit = (a: number[], b: number[], cc: number[], e: number[], level: number) => {
        if (level < depth) {
          const L = level + 1;
          const ab = a.map((x, i) => (x + b[i]) / 2), bc = b.map((x, i) => (x + cc[i]) / 2), ca = cc.map((x, i) => (x + a[i]) / 2);
          emit(a, ab, ca, [e[0], L, e[2]], L);
          emit(ab, b, bc, [e[0], e[1], L], L);
          emit(ca, bc, cc, [L, e[1], e[2]], L);
          emit(ab, bc, ca, [L, L, L], L);
          return;
        }
        const ws = [a, b, cc];
        tPoly.push(p);
        tFan.push(k);
        tW.push(...a, ...b, ...cc);
        for (let s = 0; s < 3; s++) {
          if (e[s] === 0) { tEdge.push(0); continue; }
          const k1 = at(ws[s]), k2 = at(ws[(s + 1) % 3]);
          const key = k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1;
          if (drawn.has(key)) tEdge.push(-1);
          else { drawn.add(key); tEdge.push(e[s]); }
        }
      };
      emit([1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 1, 1], 1);
    }
  });
  cStart[polys] = cVert.length;
  return {
    name: def.label, verts: V, polys, cStart, cVert: Int32Array.from(cVert), pc, pn, pAxis, pBin, pFold,
    tris: tPoly.length, tPoly: Int32Array.from(tPoly), tFan: Int32Array.from(tFan), tW: Float32Array.from(tW), tEdge: Int8Array.from(tEdge),
  };
}

/** The mesh for a shape, split finely enough to bend smoothly when `curved`. Big shapes split one level less. */
function meshFor(id: string, curved: boolean): Mesh {
  const coarse = meshCached(id, 1);
  const depth = curved ? (coarse.tris > 100 ? 2 : 3) : 1;
  return depth === 1 ? coarse : meshCached(id, depth);
}

function meshCached(id: string, depth: number): Mesh {
  const key = `${id}:${depth}`;
  let m = meshes.get(key);
  if (!m) meshes.set(key, (m = buildMesh(id, depth)));
  return m;
}

/** Rodrigues: `v` turned `angle` radians about the unit axis `u`. */
function rotate(v: V3, u: V3, angle: number): V3 {
  const c = Math.cos(angle), s = Math.sin(angle), d = dot(u, v) * (1 - c), x = cross(u, v);
  return [v[0] * c + x[0] * s + u[0] * d, v[1] * c + x[1] * s + u[1] * d, v[2] * c + x[2] * s + u[2] * d];
}

/** The 3x3 rotation of `angle` radians about the unit axis (x, y, z), row-major into `out` at `o`. */
function rotMatrix(out: Float32Array, o: number, x: number, y: number, z: number, angle: number): void {
  const c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  out[o] = t * x * x + c; out[o + 1] = t * x * y - s * z; out[o + 2] = t * x * z + s * y;
  out[o + 3] = t * x * y + s * z; out[o + 4] = t * y * y + c; out[o + 5] = t * y * z - s * x;
  out[o + 6] = t * x * z - s * y; out[o + 7] = t * y * z + s * x; out[o + 8] = t * z * z + c;
}

// ---- Model -----------------------------------------------------------------

/** The evolutions "Everything" takes turns with, one per cycle. */
const CYCLE = ["subdivide", "spikes", "shatter", "fold", "twist"] as const;
type Effect = (typeof CYCLE)[number];
const MAX_SHELLS = 4;
const MAX_GLOWS = 60;
const LIGHT = unit([-0.45, 0.65, 0.6]);

const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Facets: 3D polyhedra that turn in space and keep changing form with the
 * music. Each cycle of a few bars the shape evolves one way and back: its
 * faces subdivide and swell into a sphere, grow spikes, shatter apart, fold
 * open like petals or twist, and it morphs (through a sphere) into the next
 * shape. Kicks burst the faces outward, snares knock it spinning, melody
 * notes light faces by pitch, chords tint the nested shells and the spectrum
 * pushes spikes out of the faces.
 *
 * Geometry is worked out on the CPU (a few thousand small triangles at most)
 * and drawn as flat triangles and antialiased lines in one batch.
 */
class FacetsSim implements SimulationModel {
  private fb = new Feedback();
  private stepped = false;
  private time = 0;

  /** Orientation as a quaternion (w, x, y, z), turned in view space. */
  private q = [1, 0, 0, 0];
  /** Extra spin from snares and dragging, radians per second about a view-space axis. */
  private kick: V3 = [0, 0, 0];
  private punch = 0;
  private punchV = 0;
  private burst = 0;
  private burstV = 0;

  /** Evolution clock in cycles; the whole part counts cycles, the rest is how far through this one. */
  private phase = 0;
  private cycleNo = 0;
  private lastBeats = NaN;
  private turn = 0;
  private eff: Record<Effect, number> = { subdivide: 0, spikes: 0, shatter: 0, fold: 0, twist: 0 };
  private bend = 0;
  private bendTarget = 0;

  /** Morphing between shapes, through a sphere: 0..1 while under way, 1 when settled. */
  private from = "icosa";
  private to = "icosa";
  private morphT = 1;
  private paramShape = "";

  /** Faces lit by melody notes, and corners twinkling on hats (indexed as the current mesh's faces and corners). */
  private flash = new Float32Array(256);
  private flashHue = new Float32Array(256);
  private sparkle = new Float32Array(1024);
  private tintHue = new Float32Array(MAX_SHELLS);
  private tintAmt = new Float32Array(MAX_SHELLS);
  private drag: { x: number; y: number } | null = null;

  // Per-frame geometry and the draw list built from it.
  private mesh: Mesh = meshCached("icosa", 1);
  private polyM = new Float32Array(0);
  private polyT = new Float32Array(0);
  private obj = new Float32Array(0);
  private sx = new Float32Array(0);
  private sz = new Float32Array(0);
  private faceCol = new Uint32Array(0);
  private edgeCol = new Uint32Array(0);
  private edgeA = new Float32Array(0);
  private front = new Uint8Array(0);
  private order: number[] = [];
  private items = 0;
  private dotX = new Float32Array(0);
  private dotY = new Float32Array(0);
  private dotC = new Uint32Array(0);
  private dotS = new Float32Array(0);
  private dots = 0;
  private glows: { x: number; y: number; size: number; hue: number }[] = [];
  private edgeWidth = 1;
  private style = "glass";

  reset(_view: Viewport, p: ParamValues): void {
    this.from = this.to = this.paramShape = p.shape as string;
    this.morphT = 1;
    this.q = [Math.cos(0.3), Math.sin(0.3) * 0.6, 0, Math.sin(0.3) * 0.8];
    this.kick = [0, 0, 0];
    this.punch = this.punchV = this.burst = this.burstV = 0;
    this.phase = this.cycleNo = this.turn = 0;
    this.lastBeats = NaN;
    for (const k of CYCLE) this.eff[k] = 0;
    this.flash.fill(0);
    this.sparkle.fill(0);
    this.tintAmt.fill(0);
  }

  private shown(): string {
    return this.morphT < 0.5 ? this.from : this.to;
  }

  private morphTo(id: string): void {
    if (id === this.to) return;
    if (this.morphT < 0.5) { this.to = id; return; }
    this.from = this.shown();
    this.to = id;
    this.morphT = 0;
  }

  private onCycle(p: ParamValues): void {
    if (p.evolution === "all") this.turn++;
    if (p.autoShape) {
      const i = SHAPES.findIndex((s) => s.value === this.to);
      this.morphTo(SHAPES[(i + 1) % SHAPES.length].value);
    }
  }

  step(dt: number, p: ParamValues, m: MusicFrame): void {
    this.stepped = true;
    this.time += dt;
    if (p.shape !== this.paramShape) {
      this.paramShape = p.shape as string;
      this.morphTo(this.paramShape);
    }
    if (this.morphT < 1) {
      const before = this.morphT;
      this.morphT = Math.min(1, this.morphT + dt / (p.morphTime as number));
      if (before < 0.5 && this.morphT >= 0.5) this.flash.fill(0);
    }

    // The evolution clock runs with the music's beat, a cycle every few bars.
    let beats = m.beats - this.lastBeats;
    if (!(beats >= 0 && beats < 1)) beats = dt * 2;
    this.lastBeats = m.beats;
    this.phase += beats / ((p.cycleBars as number) * 4);
    const c = Math.floor(this.phase);
    if (c !== this.cycleNo) { this.cycleNo = c; this.onCycle(p); }
    const wave = 0.5 - 0.5 * Math.cos((this.phase - c) * Math.PI * 2);
    this.bend += (this.bendTarget - this.bend) * Math.min(1, dt * 3);
    const amount = clamp01((p.evolve as number) + (p.sweep as number) * wave + this.bend);
    const mode = p.evolution === "all" ? CYCLE[this.turn % CYCLE.length] : (p.evolution as string);
    const ease = Math.min(1, dt * 4);
    for (const k of CYCLE) this.eff[k] += ((k === mode ? amount : 0) - this.eff[k]) * ease;

    // Kick and snare springs, and the spin.
    const w = p.snap as number, k = w * w, damp = 2 * w * (1 - (p.bounce as number) * 0.9);
    this.punchV += (-this.punch * k - this.punchV * damp) * dt;
    this.punch += this.punchV * dt;
    this.burstV += (-this.burst * k - this.burstV * damp) * dt;
    this.burst += this.burstV * dt;
    const decay = Math.exp(-dt * 1.2);
    this.kick = [this.kick[0] * decay, this.kick[1] * decay, this.kick[2] * decay];
    const tumble = p.tumble as number, t = this.time;
    const axis = unit([tumble * Math.sin(t * 0.29), 1, tumble * Math.cos(t * 0.21 + 1)]);
    const spin = ((p.spin3d as number) * Math.PI) / 180 * (1 + Math.min(1.5, m.level) * (p.loudSpin as number));
    const wx = axis[0] * spin + this.kick[0], wy = axis[1] * spin + this.kick[1], wz = axis[2] * spin + this.kick[2];
    const om = Math.hypot(wx, wy, wz);
    if (om > 1e-6) {
      const h = (om * dt) / 2, s = Math.sin(h) / om;
      const a = [Math.cos(h), wx * s, wy * s, wz * s], b = this.q;
      const q = [
        a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
        a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
        a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
        a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
      ];
      const l = Math.hypot(q[0], q[1], q[2], q[3]);
      this.q = q.map((v) => v / l);
    }

    const f = Math.exp(-dt * 2.5);
    for (let i = 0; i < this.flash.length; i++) this.flash[i] *= f;
    const sp = Math.exp(-dt * 5);
    for (let i = 0; i < this.sparkle.length; i++) this.sparkle[i] *= sp;
    const tf = Math.exp(-dt * 0.6);
    for (let i = 0; i < MAX_SHELLS; i++) this.tintAmt[i] *= tf;
  }

  onPointer(input: PointerInput): void {
    if (input.type === "down" && (input.button === 2 || input.shift)) {
      this.burstV += 6;
      return;
    }
    if (input.type === "down") this.drag = { x: input.x, y: input.y };
    else if (input.type === "up" || !input.pressed) this.drag = null;
    else if (this.drag) {
      // Dragging flicks it round: sideways spins it about the vertical, up and down about the horizontal.
      const k = 0.02;
      this.kick = [this.kick[0] + (input.y - this.drag.y) * k, this.kick[1] + (input.x - this.drag.x) * k, this.kick[2]];
      this.drag = { x: input.x, y: input.y };
    }
  }

  onNote(ev: NoteEvent, p: ParamValues): void {
    const mesh = this.mesh;
    if (ev.role === "tone") {
      // The face at the note's height lights up in the note's colour: low notes at the bottom, high at the top.
      const i = Math.min(mesh.polys - 1, Math.floor(ev.x * mesh.polys));
      this.flash[i] = Math.max(this.flash[i], ev.velocity);
      this.flashHue[i] = noteHue(ev.note);
    } else if (ev.role === "kick") {
      this.punchV += (p.kickPunch as number) * ev.velocity * 6;
      this.burstV += (p.kickBurst as number) * ev.velocity * 8;
    } else if (ev.role === "snare") {
      const a = unit([Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5]);
      const s = (p.snareSpin as number) * ev.velocity;
      this.kick = [this.kick[0] + a[0] * s, this.kick[1] + a[1] * s, this.kick[2] + a[2] * s];
    } else if (ev.role === "bassline") {
      this.bendTarget = (ev.x - 0.5) * 2 * (p.bassBend as number);
    } else if (ev.role === "chord") {
      const notes = ev.notes ?? [ev.note];
      for (let s = 0; s < MAX_SHELLS; s++) {
        this.tintHue[s] = noteHue(notes[s % notes.length]);
        this.tintAmt[s] = ev.velocity;
      }
    } else {
      const corners = mesh.cVert.length;
      for (let k = 0; k < 3; k++) this.sparkle[Math.floor(Math.random() * corners)] = ev.velocity;
    }
  }

  // ---- Geometry --------------------------------------------------------------

  /** Work out every small triangle on screen this frame: where it is, its colour, and its sides. */
  private build(view: Viewport, p: ParamValues, m: MusicFrame): void {
    const morphInf = this.morphT < 1 ? Math.sin(Math.PI * this.morphT) : 0;
    const sub3 = clamp01(this.eff.subdivide);
    const inflate = Math.max(smooth(sub3), smooth(morphInf));
    const twist = this.eff.twist;
    const mesh = (this.mesh = meshFor(this.shown(), inflate > 0.002 || Math.abs(twist) > 0.002));
    const V = mesh.verts, P = mesh.polys, T = mesh.tris;
    const shells = Math.max(1, Math.min(MAX_SHELLS, Math.round(p.shells as number)));
    this.style = p.style as string;

    // Each face's own move: spike height, then a fold about its first side and a shatter about its centre.
    if (this.polyM.length < P * 9) { this.polyM = new Float32Array(P * 9); this.polyT = new Float32Array(P * 3); }
    const spikes = new Float32Array(P);
    const shatter = Math.max(0, this.eff.shatter + this.burst);
    const foldAng = this.eff.fold * Math.PI * 0.9;
    const spec = m.spectrum, specAmt = p.spectrumSpikes as number;
    const Rf = new Float32Array(9), Rs = new Float32Array(9);
    for (let f = 0; f < P; f++) {
      const bin = Math.min(spec.length - 1, Math.floor(mesh.pBin[f] * spec.length * 0.8));
      spikes[f] = this.eff.spikes * 0.9 + specAmt * spec[bin] * 0.6;
      const hx = V[mesh.cVert[mesh.cStart[f]]], h1 = V[mesh.cVert[mesh.cStart[f] + 1]];
      const u = unit(sub(h1, hx));
      rotMatrix(Rf, 0, u[0], u[1], u[2], foldAng * mesh.pFold[f]);
      rotMatrix(Rs, 0, mesh.pAxis[f * 3], mesh.pAxis[f * 3 + 1], mesh.pAxis[f * 3 + 2], shatter * 1.5);
      // p' = Rs·Rf·p + Rs·(h − Rf·h − c) + c + n·d
      const M = this.polyM, o = f * 9;
      for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) {
        M[o + r * 3 + col] = Rs[r * 3] * Rf[col] + Rs[r * 3 + 1] * Rf[3 + col] + Rs[r * 3 + 2] * Rf[6 + col];
      }
      const c0 = mesh.pc[f * 3], c1 = mesh.pc[f * 3 + 1], c2 = mesh.pc[f * 3 + 2];
      const rh = [0, 1, 2].map((r) => hx[r] - (Rf[r * 3] * hx[0] + Rf[r * 3 + 1] * hx[1] + Rf[r * 3 + 2] * hx[2]) - mesh.pc[f * 3 + r]);
      const d = shatter * 0.5;
      for (let r = 0; r < 3; r++) {
        this.polyT[f * 3 + r] = Rs[r * 3] * rh[0] + Rs[r * 3 + 1] * rh[1] + Rs[r * 3 + 2] * rh[2] + [c0, c1, c2][r] + mesh.pn[f * 3 + r] * d;
      }
    }

    // Every small triangle's corners in the shape's own space.
    if (this.obj.length < T * 9) this.obj = new Float32Array(T * 9);
    const obj = this.obj, W = mesh.tW, M = this.polyM, Tt = this.polyT;
    const twistK = twist * 2.6;
    for (let t = 0; t < T; t++) {
      const f = mesh.tPoly[t], start = mesh.cStart[f], n = mesh.cStart[f + 1] - start, k = mesh.tFan[t];
      const A = V[mesh.cVert[start + k]], B = V[mesh.cVert[start + ((k + 1) % n)]];
      const s = spikes[f];
      const C0 = mesh.pc[f * 3] + mesh.pn[f * 3] * s, C1 = mesh.pc[f * 3 + 1] + mesh.pn[f * 3 + 1] * s, C2 = mesh.pc[f * 3 + 2] + mesh.pn[f * 3 + 2] * s;
      for (let v = 0; v < 3; v++) {
        const w = t * 9 + v * 3, a = W[w], b = W[w + 1], c = W[w + 2];
        let x = a * A[0] + b * B[0] + c * C0, y = a * A[1] + b * B[1] + c * C1, z = a * A[2] + b * B[2] + c * C2;
        if (inflate > 0) {
          const k2 = 1 + inflate * (1 / (Math.hypot(x, y, z) || 1) - 1);
          x *= k2; y *= k2; z *= k2;
        }
        const o = f * 9;
        let X = M[o] * x + M[o + 1] * y + M[o + 2] * z + Tt[f * 3];
        const Y = M[o + 3] * x + M[o + 4] * y + M[o + 5] * z + Tt[f * 3 + 1];
        let Z = M[o + 6] * x + M[o + 7] * y + M[o + 8] * z + Tt[f * 3 + 2];
        if (twistK !== 0) {
          const ang = twistK * Y, cs = Math.cos(ang), sn = Math.sin(ang);
          const nx = X * cs - Z * sn;
          Z = X * sn + Z * cs;
          X = nx;
        }
        obj[t * 9 + v * 3] = X; obj[t * 9 + v * 3 + 1] = Y; obj[t * 9 + v * 3 + 2] = Z;
      }
    }

    // How strongly each kind of side shows: outlines fade as a morph swells into a sphere, splits as the face subdivides.
    const keep = 1 - morphInf;
    const vis = [1 - morphInf * 0.95, clamp01(sub3 * 3) * keep, clamp01(sub3 * 3 - 1) * keep, clamp01(sub3 * 3 - 2) * keep];

    // Projection.
    const { width, height } = view;
    const cx = width / 2, cy = height / 2;
    const S = Math.min(width, height) * 0.34 * (p.size as number);
    const cam = 2.4 + (1 - (p.perspective as number)) * 12;
    const gMode = p.gravityMode as string;
    const gDir = isUniform(gMode) ? uniformDir(gMode, this.time) : [0, 0];
    const gPull = ((p.fieldGravity as number) / 400) * shatter * shatter;
    const scheme = p.colours as string;
    const style = this.style;
    const glass = style === "glass", wire = style === "wire";
    const fill = p.faceFill as number, edgeBright = p.edgeBright as number;
    const level = Math.min(1, m.level);
    const n = T * shells;
    if (this.sx.length < n * 6) {
      this.sx = new Float32Array(n * 6); this.sz = new Float32Array(n);
      this.faceCol = new Uint32Array(n); this.edgeCol = new Uint32Array(n);
      this.edgeA = new Float32Array(n * 3); this.front = new Uint8Array(n);
    }
    const corners = mesh.cVert.length;
    if (this.dotX.length < corners * shells) {
      this.dotX = new Float32Array(corners * shells); this.dotY = new Float32Array(corners * shells);
      this.dotC = new Uint32Array(corners * shells); this.dotS = new Float32Array(corners * shells);
    }
    const sx = this.sx, sz = this.sz;
    const R = new Float32Array(9), Rk = new Float32Array(9), Q = new Float32Array(9);
    quatMatrix(this.q, Q);
    const polyHue = new Float32Array(P);
    this.glows = [];
    let item = 0, nDots = 0;
    const pulse = 1 + this.punch + m.pulse * (p.beatPulse as number);
    for (let s = 0; s < shells; s++) {
      // Each inner shell is smaller and turns on its own against the outer one.
      const ang = this.time * ((p.shellSpin as number) * Math.PI / 180) * (s + 1) * (s % 2 ? -1 : 1) * (s > 0 ? 1 : 0);
      if (s % 2) rotMatrix(Rk, 0, 1, 0, 0, ang); else rotMatrix(Rk, 0, 0, 1, 0, ang);
      // Solid faces would cut through each other where shells nearly touch, so they keep a wider gap.
      const scale = pulse * (1 - s * Math.max(p.shellGap as number, style === "solid" ? 0.3 : 0));
      for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) {
        R[r * 3 + col] = (Q[r * 3] * Rk[col] + Q[r * 3 + 1] * Rk[3 + col] + Q[r * 3 + 2] * Rk[6 + col]) * scale;
      }
      const shellHue = s * (p.shellHue as number);
      for (let f = 0; f < P; f++) {
        let h = (schemeHue(scheme, mesh.pBin[f], m.hue, m.beats) + shellHue) % 360;
        if (this.tintAmt[s] > 0.01) h = hueToward(h, this.tintHue[s], Math.min(1, this.tintAmt[s]));
        if (this.flash[f] > 0.01) h = hueToward(h, this.flashHue[f], Math.min(1, this.flash[f] * 1.5));
        polyHue[f] = h;
      }
      const gx = gDir[0] * gPull, gy = -gDir[1] * gPull;
      for (let t = 0; t < T; t++, item++) {
        const f = mesh.tPoly[t];
        let zSum = 0, ok = true;
        const vx = [0, 0, 0], vy = [0, 0, 0], vz = [0, 0, 0];
        for (let v = 0; v < 3; v++) {
          const o = t * 9 + v * 3, X = obj[o], Y = obj[o + 1], Z = obj[o + 2];
          const x = R[0] * X + R[1] * Y + R[2] * Z + gx, y = R[3] * X + R[4] * Y + R[5] * Z + gy, z = R[6] * X + R[7] * Y + R[8] * Z;
          vx[v] = x; vy[v] = y; vz[v] = z;
          const den = cam - z;
          if (den < 0.3) ok = false;
          const k = (S * cam) / Math.max(0.3, den);
          sx[item * 6 + v * 2] = cx + x * k;
          sx[item * 6 + v * 2 + 1] = cy - y * k;
          zSum += z;
        }
        sz[item] = zSum / 3;
        if (!ok) { this.faceCol[item] = 0; this.edgeCol[item] = 0; this.front[item] = 0; continue; }
        // Lighting from the triangle's normal, turned to face the viewer when it's a back face.
        const ax = vx[1] - vx[0], ay = vy[1] - vy[0], az = vz[1] - vz[0];
        const bx = vx[2] - vx[0], by = vy[2] - vy[0], bz = vz[2] - vz[0];
        let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
        const nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
        const facing = nx * -vx[0] + ny * -vy[0] + nz * (cam - vz[0]) > 0;
        if (!facing) { nx = -nx; ny = -ny; nz = -nz; }
        const diffuse = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
        const fl = Math.min(1, this.flash[f]);
        const fog = 0.55 + 0.45 * clamp01((zSum / 3 + 1.2) / 2.4);
        const h = polyHue[f];
        this.front[item] = facing ? 1 : 0;
        if (glass) {
          this.faceCol[item] = hsla(h, 0.8, 0.35 + 0.3 * diffuse + fl * 0.25, clamp01(fill * (0.05 + 0.22 * diffuse + fl * 0.35) * fog * (facing ? 1 : 0.6)));
        } else if (!wire) {
          const l = (0.07 + 0.5 * diffuse + fl * 0.3) * (facing ? 1 : 0.45) * fog;
          this.faceCol[item] = hsla(h, 0.75, Math.min(0.9, l), 1);
        } else this.faceCol[item] = 0;
        const back = glass ? 0.45 : wire ? 0.3 : 1;
        this.edgeCol[item] = hsla(h, 0.85, Math.min(0.92, 0.58 + fl * 0.3 + level * 0.1), clamp01(edgeBright * fog * (facing ? 1 : back) * (0.8 + level * 0.4)));
        const spoke = clamp01(spikes[f] * 5);
        for (let e = 0; e < 3; e++) {
          const d = mesh.tEdge[t * 3 + e];
          this.edgeA[item * 3 + e] = d < 0 ? 0 : d === 1 ? Math.max(vis[1], spoke * keep) : vis[d];
        }
      }
      // Corner dots, and glows where they twinkle.
      const dotSize = p.dotSize as number;
      if (dotSize > 0.05 || s === 0) {
        for (let f = 0; f < P; f++) {
          const o = f * 9;
          if (style === "solid") {
            // Solid faces hide the corners behind them: only faces turned toward the viewer get dots.
            const n0 = mesh.pn[f * 3], n1 = mesh.pn[f * 3 + 1], n2 = mesh.pn[f * 3 + 2];
            const nz = R[6] * (M[o] * n0 + M[o + 1] * n1 + M[o + 2] * n2) + R[7] * (M[o + 3] * n0 + M[o + 4] * n1 + M[o + 5] * n2) + R[8] * (M[o + 6] * n0 + M[o + 7] * n1 + M[o + 8] * n2);
            if (nz <= 0) continue;
          }
          for (let c = mesh.cStart[f]; c < mesh.cStart[f + 1]; c++) {
            const A = V[mesh.cVert[c]];
            let k2 = 1;
            if (inflate > 0) k2 = 1 + inflate * (1 / (Math.hypot(A[0], A[1], A[2]) || 1) - 1);
            const x0 = A[0] * k2, y0 = A[1] * k2, z0 = A[2] * k2;
            let X = M[o] * x0 + M[o + 1] * y0 + M[o + 2] * z0 + Tt[f * 3];
            const Y = M[o + 3] * x0 + M[o + 4] * y0 + M[o + 5] * z0 + Tt[f * 3 + 1];
            let Z = M[o + 6] * x0 + M[o + 7] * y0 + M[o + 8] * z0 + Tt[f * 3 + 2];
            if (twistK !== 0) {
              const ang2 = twistK * Y, cs = Math.cos(ang2), sn = Math.sin(ang2);
              const nx = X * cs - Z * sn;
              Z = X * sn + Z * cs;
              X = nx;
            }
            const x = R[0] * X + R[1] * Y + R[2] * Z + gx, y = R[3] * X + R[4] * Y + R[5] * Z + gy, z = R[6] * X + R[7] * Y + R[8] * Z;
            if (cam - z < 0.3) continue;
            const k = (S * cam) / (cam - z);
            const px = cx + x * k, py = cy - y * k;
            const spark = this.sparkle[c] ?? 0;
            if (s === 0 && spark > 0.3 && this.glows.length < MAX_GLOWS) this.glows.push({ x: px, y: py, size: 22 * spark * (1 + Math.min(1, m.treble) * 0.6), hue: polyHue[f] });
            if (dotSize <= 0.05) continue;
            this.dotX[nDots] = px; this.dotY[nDots] = py;
            this.dotS[nDots] = dotSize * (1 + spark * 1.5) * (0.6 + 0.4 * k / S / 1.2);
            this.dotC[nDots] = hsla(polyHue[f], 0.7, 0.8, clamp01(0.5 + 0.5 * clamp01((z + 1) / 2)));
            nDots++;
          }
        }
      }
      // A glow on each face a melody note lit.
      if (s === 0) {
        for (let f = 0; f < P && this.glows.length < MAX_GLOWS; f++) {
          if (this.flash[f] < 0.15) continue;
          const o = f * 9;
          const X = Tt[f * 3] + M[o] * mesh.pc[f * 3] + M[o + 1] * mesh.pc[f * 3 + 1] + M[o + 2] * mesh.pc[f * 3 + 2];
          const Y = Tt[f * 3 + 1] + M[o + 3] * mesh.pc[f * 3] + M[o + 4] * mesh.pc[f * 3 + 1] + M[o + 5] * mesh.pc[f * 3 + 2];
          const Z = Tt[f * 3 + 2] + M[o + 6] * mesh.pc[f * 3] + M[o + 7] * mesh.pc[f * 3 + 1] + M[o + 8] * mesh.pc[f * 3 + 2];
          const x = R[0] * X + R[1] * Y + R[2] * Z + gx, y = R[3] * X + R[4] * Y + R[5] * Z + gy, z = R[6] * X + R[7] * Y + R[8] * Z;
          if (cam - z < 0.3) continue;
          const k = (S * cam) / (cam - z);
          this.glows.push({ x: cx + x * k, y: cy - y * k, size: S * 0.5 * this.flash[f] * (p.noteGlow as number), hue: this.flashHue[f] });
        }
      }
    }
    this.items = item;
    this.dots = nDots;
    this.edgeWidth = (p.edgeWidth as number) * (1 + Math.min(1.5, m.bass) * 0.5);

    // Solid faces hide what's behind them, so they're drawn back to front.
    const order = this.order;
    order.length = item;
    for (let i = 0; i < item; i++) order[i] = i;
    if (!glass && !wire) order.sort((a, b) => sz[a] - sz[b]);
  }

  // ---- Drawing -------------------------------------------------------------

  renderGL(gfx: Gfx, view: Viewport, p: ParamValues, m: MusicFrame): void {
    gfx.feedback(p.afterglow as number, p.zoom as number, p.spin as number, this.stepped);
    this.stepped = false;
    this.build(view, p, m);
    const sx = this.sx, ew = this.edgeWidth, solid = this.style === "solid";
    const edges = (i: number) => {
      const c = this.edgeCol[i];
      if (!c) return;
      for (let e = 0; e < 3; e++) {
        const a = this.edgeA[i * 3 + e];
        if (a < 0.02) continue;
        const o = i * 6, e2 = (e + 1) % 3;
        gfx.line(sx[o + e * 2], sx[o + e * 2 + 1], sx[o + e2 * 2], sx[o + e2 * 2 + 1], ew, a >= 1 ? c : fade(c, a));
      }
    };
    if (solid) {
      gfx.blend("normal");
      for (const i of this.order) {
        const c = this.faceCol[i];
        if (!c) continue;
        const o = i * 6;
        gfx.tri(sx[o], sx[o + 1], sx[o + 2], sx[o + 3], sx[o + 4], sx[o + 5], c);
        edges(i);
      }
      gfx.blend("add");
    } else {
      gfx.blend("add");
      for (let i = 0; i < this.items; i++) {
        const c = this.faceCol[i];
        if (!c || c >>> 24 === 0) continue;
        const o = i * 6;
        gfx.tri(sx[o], sx[o + 1], sx[o + 2], sx[o + 3], sx[o + 4], sx[o + 5], c);
      }
      for (let i = 0; i < this.items; i++) edges(i);
    }
    for (let d = 0; d < this.dots; d++) gfx.disc(this.dotX[d], this.dotY[d], this.dotS[d], this.dotC[d]);
    for (const g of this.glows) gfx.glow(g.x, g.y, g.size, Math.round(g.hue / 10) * 10, 90);
    gfx.blend("normal");
  }

  render(g: CanvasRenderingContext2D, view: Viewport, p: ParamValues, m: MusicFrame): void {
    applyFeedback(this.fb, g, view, p, this.stepped);
    this.stepped = false;
    this.build(view, p, m);
    const sx = this.sx, solid = this.style === "solid";
    g.lineWidth = this.edgeWidth;
    g.lineCap = "round";
    g.lineJoin = "round";
    const edges = (i: number) => {
      const c = this.edgeCol[i];
      if (!c) return;
      for (let e = 0; e < 3; e++) {
        const a = this.edgeA[i * 3 + e];
        if (a < 0.02) continue;
        const o = i * 6, e2 = (e + 1) % 3;
        g.strokeStyle = css(c, a);
        g.beginPath();
        g.moveTo(sx[o + e * 2], sx[o + e * 2 + 1]);
        g.lineTo(sx[o + e2 * 2], sx[o + e2 * 2 + 1]);
        g.stroke();
      }
    };
    const face = (i: number) => {
      const c = this.faceCol[i];
      if (!c || c >>> 24 === 0) return;
      const o = i * 6;
      g.fillStyle = css(c, 1);
      g.beginPath();
      g.moveTo(sx[o], sx[o + 1]);
      g.lineTo(sx[o + 2], sx[o + 3]);
      g.lineTo(sx[o + 4], sx[o + 5]);
      g.closePath();
      g.fill();
    };
    if (solid) {
      for (const i of this.order) { face(i); edges(i); }
      g.globalCompositeOperation = "lighter";
    } else {
      g.globalCompositeOperation = "lighter";
      for (let i = 0; i < this.items; i++) face(i);
      for (let i = 0; i < this.items; i++) edges(i);
    }
    for (let d = 0; d < this.dots; d++) {
      g.fillStyle = css(this.dotC[d], 1);
      g.beginPath();
      g.arc(this.dotX[d], this.dotY[d], this.dotS[d], 0, Math.PI * 2);
      g.fill();
    }
    for (const gl of this.glows) {
      const grad = g.createRadialGradient(gl.x, gl.y, 0, gl.x, gl.y, gl.size / 2);
      grad.addColorStop(0, `hsla(${gl.hue} 90% 92% / 1)`);
      grad.addColorStop(0.18, `hsla(${gl.hue} 90% 70% / 0.75)`);
      grad.addColorStop(0.5, `hsla(${gl.hue} 90% 55% / 0.18)`);
      grad.addColorStop(1, `hsla(${gl.hue} 90% 50% / 0)`);
      g.fillStyle = grad;
      g.fillRect(gl.x - gl.size / 2, gl.y - gl.size / 2, gl.size, gl.size);
    }
    g.globalCompositeOperation = "source-over";
    g.lineCap = "butt";
    g.lineJoin = "miter";
    g.lineWidth = 1;
  }

  stats(): string {
    return `${this.mesh.name} · ${this.items} triangles`;
  }
}

/** Rotation matrix of the unit quaternion (w, x, y, z), row-major. */
function quatMatrix(q: number[], out: Float32Array): void {
  const [w, x, y, z] = q;
  out[0] = 1 - 2 * (y * y + z * z); out[1] = 2 * (x * y - w * z); out[2] = 2 * (x * z + w * y);
  out[3] = 2 * (x * y + w * z); out[4] = 1 - 2 * (x * x + z * z); out[5] = 2 * (y * z - w * x);
  out[6] = 2 * (x * z - w * y); out[7] = 2 * (y * z + w * x); out[8] = 1 - 2 * (x * x + y * y);
}

/** A packed colour as a CSS colour, its alpha scaled by `k`. */
function css(c: Colour, k: number): string {
  return `rgba(${c & 255},${(c >>> 8) & 255},${(c >>> 16) & 255},${(((c >>> 24) / 255) * k).toFixed(3)})`;
}

export const facets: ModelDefinition = {
  id: "facets",
  name: "Facets",
  category: "Shapes",
  description: "3D polyhedra turning in space and changing form with the music. Every few bars the shape evolves one way and back: its faces subdivide and swell into a sphere, grow spikes, shatter apart, fold open like petals or twist, and it morphs into the next shape. Kicks burst the faces outward, snares knock it spinning, melody notes light faces by pitch, chords tint the nested shells and the spectrum pushes spikes out of the faces.",
  hint: "Drag to spin the shape. Right-click or Shift-click to burst it apart.",
  paintsBackground: true,
  params: [
    { kind: "choice", key: "shape", label: "Shape", default: "icosa", group: "Shape",
      description: "Which polyhedron. Changing it morphs across through a sphere.",
      options: SHAPES.map(({ value, label }) => ({ value, label })) },
    { kind: "boolean", key: "autoShape", label: "Next shape each cycle", default: true, group: "Shape",
      description: "Morph on to the next shape in the list at the end of every evolution cycle." },
    { kind: "number", key: "morphTime", label: "Morph time", min: 0.2, max: 8, step: 0.1, default: 1.6, group: "Shape",
      description: "Seconds a morph from one shape to the next takes.", format: (v) => `${v.toFixed(1)} s` },
    { kind: "number", key: "shells", label: "Shells", min: 1, max: MAX_SHELLS, step: 1, default: 2, group: "Shape",
      description: "Nested copies of the shape, one inside the other, each turning its own way." },
    { kind: "number", key: "shellGap", label: "Shell gap", min: 0.05, max: 0.3, step: 0.01, default: 0.22, group: "Shape",
      description: "How much smaller each inner shell is." },
    { kind: "number", key: "size", label: "Size", min: 0.3, max: 2.5, step: 0.01, default: 1, group: "Shape",
      description: "How big the shape is on screen." },
    { kind: "choice", key: "evolution", label: "Evolution", default: "all", group: "Evolution",
      description: "How the shape changes over each cycle. Everything takes a different one each cycle.",
      options: [
        { value: "all", label: "Everything, a new one each cycle" },
        { value: "subdivide", label: "Subdivide into a sphere" },
        { value: "spikes", label: "Grow spikes" },
        { value: "shatter", label: "Shatter into faces" },
        { value: "fold", label: "Fold open like petals" },
        { value: "twist", label: "Twist" },
        { value: "none", label: "None, just turn" },
      ] },
    { kind: "number", key: "evolve", label: "Evolve", min: 0, max: 1, step: 0.01, default: 0, group: "Evolution",
      description: "How far the evolution is pushed all the time, before the cycle sweeps it further." },
    { kind: "number", key: "sweep", label: "Cycle sweep", min: 0, max: 1, step: 0.01, default: 0.8, group: "Evolution",
      description: "How far each cycle sweeps the evolution out and back again." },
    { kind: "number", key: "cycleBars", label: "Cycle length", min: 1, max: 16, step: 1, default: 4, group: "Evolution",
      description: "Bars per evolution cycle (and per shape, when the shape changes each cycle).", format: (v) => `${v} bar${v === 1 ? "" : "s"}` },
    { kind: "number", key: "spin3d", label: "Spin", min: -180, max: 180, step: 1, default: 24, group: "Motion", global: "energy",
      description: "How fast the shape turns, degrees per second." },
    { kind: "number", key: "tumble", label: "Tumble", min: 0, max: 2, step: 0.01, default: 0.6, group: "Motion",
      description: "How much the axis it turns about wanders, so it rolls over instead of only spinning in place." },
    { kind: "number", key: "shellSpin", label: "Shell spin", min: -120, max: 120, step: 1, default: 18, group: "Motion",
      description: "How fast inner shells turn against the outer one, degrees per second." },
    { kind: "number", key: "perspective", label: "Perspective", min: 0, max: 1, step: 0.01, default: 0.6, group: "Motion",
      description: "How strongly near parts look bigger than far ones. Zero is flat, like a technical drawing." },
    { kind: "number", key: "snap", label: "Snap", min: 2, max: 30, step: 0.5, default: 8, group: "Motion",
      description: "How quickly a kick's burst springs back together." },
    { kind: "number", key: "bounce", label: "Bounce", min: 0, max: 1, step: 0.01, default: 0.5, group: "Motion",
      description: "How much it overshoots and wobbles as it springs back." },
    { kind: "choice", key: "style", label: "Style", default: "glass", group: "Look",
      description: "Glass: see-through glowing faces. Solid: lit, opaque faces. Wireframe: only the edges.",
      options: [
        { value: "glass", label: "Glass" },
        { value: "solid", label: "Solid" },
        { value: "wire", label: "Wireframe" },
      ] },
    { kind: "number", key: "faceFill", label: "Face glow", min: 0, max: 2, step: 0.01, default: 0.7, group: "Look",
      description: "How brightly the faces glow in Glass style." },
    { kind: "number", key: "edgeWidth", label: "Edge width", min: 0.3, max: 6, step: 0.1, default: 1.4, group: "Look",
      description: "How thick the edges are. The bass thickens them." },
    { kind: "number", key: "edgeBright", label: "Edge brightness", min: 0, max: 1.5, step: 0.01, default: 0.75, group: "Look",
      description: "How bright the edges are." },
    { kind: "number", key: "dotSize", label: "Corner dots", min: 0, max: 8, step: 0.1, default: 1.6, group: "Look",
      description: "Dots on the corners. Zero hides them." },
    { kind: "number", key: "shellHue", label: "Shell colour shift", min: 0, max: 180, step: 1, default: 40, group: "Look",
      description: "How far round the colour wheel each inner shell is shifted." },
    { kind: "number", key: "kickPunch", label: "Kick punch", min: 0, max: 1, step: 0.01, default: 0.25, group: "Music", global: "energy",
      description: "How much a kick makes the shape jump bigger." },
    { kind: "number", key: "kickBurst", label: "Kick burst", min: 0, max: 1, step: 0.01, default: 0.2, group: "Music", global: "energy",
      description: "How hard a kick bursts the faces apart before they spring back." },
    { kind: "number", key: "snareSpin", label: "Snare spin", min: 0, max: 6, step: 0.05, default: 1.2, group: "Music", global: "energy",
      description: "How hard a snare knocks the shape spinning about a random axis." },
    { kind: "number", key: "spectrumSpikes", label: "Spectrum spikes", min: 0, max: 2, step: 0.01, default: 0.5, group: "Music",
      description: "How far the spectrum pushes spikes out of the faces: bass at the bottom, treble at the top." },
    { kind: "number", key: "bassBend", label: "Bass bend", min: 0, max: 0.6, step: 0.01, default: 0.15, group: "Music",
      description: "How far the bass line's pitch pushes the evolution." },
    { kind: "number", key: "noteGlow", label: "Note glow", min: 0, max: 2, step: 0.01, default: 0.8, group: "Music",
      description: "How big the glow is on a face a melody note lights." },
    { kind: "number", key: "beatPulse", label: "Beat pulse", min: 0, max: 0.3, step: 0.005, default: 0.04, group: "Music",
      description: "How much the shape swells on every beat." },
    { kind: "number", key: "loudSpin", label: "Loud spin", min: 0, max: 3, step: 0.05, default: 0.6, group: "Music",
      description: "How much faster it turns as the music gets louder." },
    gravityModeParam("off"),
    { kind: "number", key: "fieldGravity", label: "Field strength", min: 0, max: 1500, step: 10, default: 300, global: "gravity", hidden: true,
      description: "How hard gravity pulls the faces of a shattered shape." },
    colourParam(),
    ...feedbackParams(0.35),
  ],
  macros: [
    { key: "evolve", label: "Evolve", description: "Pushes the evolution all the way and lengthens the sweep, so the shape stays transformed.",
      targets: [{ param: "evolve", amount: 0.7 }, { param: "sweep", amount: 0.2 }, { param: "spectrumSpikes", amount: 0.2 }] },
    { key: "explode", label: "Explode", description: "Harder kicks and a looser spring: every beat blows the faces apart.",
      targets: [{ param: "kickBurst", amount: 0.6 }, { param: "kickPunch", amount: 0.3 }, { param: "bounce", amount: 0.3 }, { param: "snap", amount: -0.15 }, { param: "snareSpin", amount: 0.3 }] },
    { key: "crystal", label: "Crystal", description: "Solid lit faces and three shells turning against each other.",
      targets: [{ param: "style", set: "solid", at: 0.2 }, { param: "shells", amount: 0.7 }, { param: "shellSpin", amount: 0.25 }, { param: "edgeBright", amount: 0.2 }] },
    { key: "warp", label: "Warp drive", description: "Fast spin with long tunnel trails that fly outward.",
      targets: [{ param: "spin3d", amount: 0.3 }, { param: "afterglow", amount: 0.5 }, { param: "zoom", amount: 0.45 }, { param: "spin", amount: 0.2 }, { param: "perspective", amount: 0.3 }] },
  ],
  modulations: [
    { source: "kick", target: "edgeWidth", amount: 0.12 },
    { source: "treble", target: "dotSize", amount: 0.15 },
    { source: "lfoBar", target: "tumble", amount: 0.1 },
  ],
  reactions: [
    { source: "tone", label: "Light a face", text: "The face at the note's height (low notes at the bottom, high at the top) lights up in the note's colour and glows" },
    { source: "kick", label: "Burst", text: "The shape jumps bigger and its faces burst apart, then spring back together" },
    { source: "snare", label: "Spin", text: "Knocks the shape spinning about a random axis" },
    { source: "hat", label: "Twinkle", text: "A few corners twinkle" },
    { source: "bassline", label: "Push the evolution", text: "The bass line's pitch pushes the evolution further or pulls it back" },
    { source: "chord", label: "Chord colours", text: "Each shell takes the colour of one of the chord's notes" },
    { source: "bass", label: "Thicker edges", text: "Thickens the edges" },
    { source: "level", label: "Glow and spin", text: "Edges glow brighter and the shape turns faster as the music gets louder" },
    { source: "treble", label: "Bigger twinkles", text: "Twinkling corners glow bigger" },
    { source: "spectrum", label: "Spectrum spikes", text: "Each face grows a spike as tall as its part of the spectrum: bass at the bottom, treble at the top" },
    { source: "beat", label: "Beat pulse", text: "The shape swells on every beat" },
  ],
  create: () => new FacetsSim(),
};
