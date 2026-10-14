import { BACKGROUND_RGB } from "../models/lib/visual";
import { GRADE_GLSL, gradeUniforms, isNeutral, type Grade } from "../ui/grade";

/**
 * Drawing on the GPU. Models that have a `renderGL` draw through this instead
 * of Canvas 2D: every line, dot and glow of a frame goes into one vertex
 * buffer and reaches the GPU in a handful of draw calls, where Canvas 2D in
 * a software-rendered webview fills each one on the CPU.
 *
 * The frame is built in an offscreen texture so the fading trails (and the
 * tunnel zoom and spin) can feed back on it, then shown on the canvas through
 * the colour grade, which costs nothing extra here.
 *
 * Coordinates are CSS pixels, like the Canvas 2D path; `scale` turns them
 * into the canvas's device pixels.
 */

/** Packed colour, as `rgba()` makes it: straight (not premultiplied) RGBA bytes, red lowest. */
export type Colour = number;

export function rgba(r: number, g: number, b: number, a = 1): Colour {
  return ((clampByte(a * 255) << 24) | (clampByte(b) << 16) | (clampByte(g) << 8) | clampByte(r)) >>> 0;
}

/** HSL (h in degrees, s and l 0..1) with alpha 0..1, packed. */
export function hsla(h: number, s: number, l: number, a = 1): Colour {
  h = ((h % 360) + 360) % 360;
  const k = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const t = (n + h / 30) % 12;
    return 255 * (l - k * Math.max(-1, Math.min(t - 3, 9 - t, 1)));
  };
  return rgba(f(0), f(8), f(4), a);
}

function clampByte(v: number): number {
  return v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
}

export type Blend = "add" | "normal";

// Shape modes, matched in the fragment shader.
const SOLID = 0, CAPSULE = 1, BUTT = 2, GLOW = 3, IMAGE = 4, RING = 5, INK = 6;

const VERTEX = `#version 300 es
in vec2 pos;
in vec4 shape;
in float mode;
in vec4 colour;
uniform vec2 res;
out vec4 vShape;
out float vMode;
out vec4 vColour;
void main() {
  vShape = shape;
  vMode = mode;
  vColour = colour;
  vec2 c = pos / res * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

// Shapes are drawn as quads; `shape` holds the pixel's place in its shape
// (along, across, half the length, radius) so edges are antialiased here.
const FRAGMENT = `#version 300 es
precision highp float;
in vec4 vShape;
in float vMode;
in vec4 vColour;
uniform sampler2D image;
uniform sampler2D lut;
uniform ivec2 grid;
uniform bool sharp;
out vec4 outColour;

vec3 inkAt(ivec2 p) {
  p = ivec2((p.x % grid.x + grid.x) % grid.x, (p.y % grid.y + grid.y) % grid.y);
  return texture(lut, vec2((texelFetch(image, p, 0).r * 255.0 + 0.5) / 256.0, 0.5)).rgb;
}

void main() {
  int m = int(vMode + 0.5);
  vec4 c = vColour;
  float a = 1.0;
  if (m == ${CAPSULE}) {
    float d = length(vec2(max(abs(vShape.x) - vShape.z, 0.0), vShape.y));
    a = clamp(vShape.w - d + 0.5, 0.0, 1.0);
  } else if (m == ${BUTT}) {
    a = clamp(vShape.w - abs(vShape.y) + 0.5, 0.0, 1.0);
  } else if (m == ${RING}) {
    a = clamp(vShape.z - abs(length(vShape.xy) - vShape.w) + 0.5, 0.0, 1.0);
  } else if (m == ${GLOW}) {
    // The same stops as the Canvas 2D glow sprite: lightness 92%, 70%, 55%, 50%
    // at alpha 1, 0.75, 0.18, 0, on a colour handed over at 50% lightness.
    float t = min(1.0, length(vShape.xy) / vShape.w), l;
    if (t < 0.18) { float f = t / 0.18; a = mix(1.0, 0.75, f); l = mix(0.92, 0.70, f); }
    else if (t < 0.5) { float f = (t - 0.18) / 0.32; a = mix(0.75, 0.18, f); l = mix(0.70, 0.55, f); }
    else { float f = (t - 0.5) / 0.5; a = mix(0.18, 0.0, f); l = mix(0.55, 0.5, f); }
    c.rgb = mix(c.rgb, vec3(1.0), 2.0 * l - 1.0);
  } else if (m == ${IMAGE}) {
    outColour = texture(image, vShape.xy) * c.a;
    return;
  } else if (m == ${INK}) {
    // A grid of 0..255 shades, coloured through a 256-entry palette. Sharp
    // smooths the shades and then colours them, so edges stay crisp; soft
    // colours the cells and smooths the colours.
    vec2 g = vShape.xy * vec2(grid) - 0.5;
    ivec2 i = ivec2(floor(g));
    vec2 f = g - floor(g);
    vec3 rgb;
    if (sharp) {
      ivec2 p0 = ivec2((i.x % grid.x + grid.x) % grid.x, (i.y % grid.y + grid.y) % grid.y);
      ivec2 p1 = ivec2((p0.x + 1) % grid.x, (p0.y + 1) % grid.y);
      float s = mix(mix(texelFetch(image, p0, 0).r, texelFetch(image, ivec2(p1.x, p0.y), 0).r, f.x),
                    mix(texelFetch(image, ivec2(p0.x, p1.y), 0).r, texelFetch(image, p1, 0).r, f.x), f.y);
      rgb = texture(lut, vec2((floor(s * 255.0 + 0.001) + 0.5) / 256.0, 0.5)).rgb;
    } else {
      rgb = mix(mix(inkAt(i), inkAt(i + ivec2(1, 0)), f.x), mix(inkAt(i + ivec2(0, 1)), inkAt(i + ivec2(1, 1)), f.x), f.y);
    }
    outColour = vec4(rgb, 1.0) * c.a;
    return;
  }
  a *= c.a;
  outColour = vec4(c.rgb * a, a);
}`;

const PRESENT_VERTEX = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() {
  uv = pos * 0.5 + 0.5;
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

const PRESENT_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 uv;
uniform sampler2D image;
uniform bool graded;
${GRADE_GLSL}
out vec4 outColour;
void main() {
  vec4 c = texture(image, uv);
  outColour = graded ? vec4(grade(c.rgb), 1.0) : vec4(c.rgb, 1.0);
}`;

/** Words per vertex: x, y, four shape values, mode, colour. */
const STRIDE = 8;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export class Gfx {
  readonly gl: WebGL2RenderingContext;
  /** Device pixels per CSS pixel. */
  scale = 1;
  /** The canvas size in device pixels. */
  width = 1;
  height = 1;

  private readonly prog: WebGLProgram;
  private readonly present: WebGLProgram;
  private readonly u: Record<string, WebGLUniformLocation | null> = {};
  private readonly pu: Record<string, WebGLUniformLocation | null> = {};
  private readonly vbo: WebGLBuffer;
  private readonly quadVbo: WebGLBuffer;
  private readonly vao: WebGLVertexArrayObject;
  private readonly quadVao: WebGLVertexArrayObject;
  private data = new ArrayBuffer(STRIDE * 4 * 6 * 4096);
  private f32 = new Float32Array(this.data);
  private u32 = new Uint32Array(this.data);
  private count = 0;
  private blendMode: Blend = "normal";
  private targets: Target[] = [];
  private current = 0;
  private boundImage: WebGLTexture | null = null;
  private lastFade = 0;
  /** Textures the models upload pixels to, by name, with their size. */
  private images = new Map<string, { tex: WebGLTexture; w: number; h: number; format: number }>();

  private constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.prog = link(gl, VERTEX, FRAGMENT);
    this.present = link(gl, PRESENT_VERTEX, PRESENT_FRAGMENT);
    for (const n of ["res", "image", "lut", "grid", "sharp"]) this.u[n] = gl.getUniformLocation(this.prog, n);
    for (const n of ["image", "graded", "hue", "saturation", "brightness", "contrast", "invert"]) this.pu[n] = gl.getUniformLocation(this.present, n);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.vbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.STREAM_DRAW);
    const attr = (name: string, size: number, type: number, normalized: boolean, offset: number) => {
      const loc = gl.getAttribLocation(this.prog, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, type, normalized, STRIDE * 4, offset * 4);
    };
    attr("pos", 2, gl.FLOAT, false, 0);
    attr("shape", 4, gl.FLOAT, false, 2);
    attr("mode", 1, gl.FLOAT, false, 6);
    attr("colour", 4, gl.UNSIGNED_BYTE, true, 7);

    this.quadVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.quadVao);
    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.present, "pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.useProgram(this.prog);
    gl.uniform1i(this.u.image, 0);
    gl.uniform1i(this.u.lut, 1);
    gl.useProgram(this.present);
    gl.uniform1i(this.pu.image, 0);
    gl.disable(gl.DEPTH_TEST);
  }

  /** A GPU renderer on `canvas`, or null where WebGL 2 is missing or broken. */
  static create(canvas: HTMLCanvasElement): Gfx | null {
    const gl = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "high-performance" });
    if (!gl) return null;
    try {
      return new Gfx(gl);
    } catch (e) {
      console.warn("WebGL drawing unavailable:", e);
      return null;
    }
  }

  /** Match the canvas's size; the picture is kept where it still fits. */
  resize(width: number, height: number, scale: number): void {
    this.scale = scale;
    if (width === this.width && height === this.height && this.targets.length) return;
    const gl = this.gl;
    const old = this.targets[this.current];
    const fresh = [this.target(width, height), this.target(width, height)];
    for (const t of fresh) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(BACKGROUND_RGB[0] / 255, BACKGROUND_RGB[1] / 255, BACKGROUND_RGB[2] / 255, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    if (old) {
      // Keep the old picture, top-left aligned, so a resize doesn't blank the trails.
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, old.fbo);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fresh[0].fbo);
      const w = Math.min(width, this.width), h = Math.min(height, this.height);
      gl.blitFramebuffer(0, this.height - h, w, this.height, 0, height - h, w, height, gl.COLOR_BUFFER_BIT, gl.NEAREST);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    }
    for (const t of this.targets) {
      gl.deleteTexture(t.tex);
      gl.deleteFramebuffer(t.fbo);
    }
    this.targets = fresh;
    this.current = 0;
    this.width = width;
    this.height = height;
  }

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    setFilter(gl, gl.LINEAR, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.boundImage = null;
    return { tex, fbo };
  }

  /** Start a frame: drawing goes to the frame's texture until `show`. */
  begin(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[this.current].fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.prog);
    gl.uniform2f(this.u.res, this.width, this.height);
    gl.bindVertexArray(this.vao);
    // The frame's own texture, left bound by `show`, can't be read while it is drawn to.
    this.unbindImages();
    gl.enable(gl.BLEND);
    this.applyBlend();
  }

  private unbindImages(): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    this.boundImage = null;
  }

  /** Fill the frame with the background, as the host does for models that don't paint their own. */
  clear(r = 13, g = 17, b = 23): void {
    this.flush();
    const gl = this.gl;
    gl.clearColor(r / 255, g / 255, b / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * The shared trails: fade the last frame toward the background, zoomed by
   * `zoom` per second and turned `spin` degrees per second about the centre.
   * Same maths as `Feedback.apply` on the Canvas 2D path.
   */
  feedback(afterglow: number, zoom = 0, spin = 0, moving = true): void {
    const now = performance.now();
    const dt = this.lastFade ? Math.min(0.1, (now - this.lastFade) / 1000) : 1 / 60;
    this.lastFade = now;
    const keep = moving ? Math.pow(Math.min(0.995, Math.max(0, afterglow)), dt * 60) : afterglow > 0 ? 1 : 0;
    const [br, bg, bb] = BACKGROUND_RGB;
    if (keep <= 0.01) {
      this.clear(br, bg, bb);
      return;
    }
    const z = moving ? 1 + zoom * dt : 1;
    const rot = moving ? (spin * Math.PI / 180) * dt : 0;
    const prev = this.blendMode;
    if (z === 1 && rot === 0) {
      if (keep >= 1) return;
      this.blend("normal");
      this.rawRect(0, 0, this.width, this.height, rgba(br, bg, bb, 1 - keep));
      this.blend(prev);
      return;
    }
    // Draw the last frame, faded and transformed, into the other texture, which then becomes the frame.
    this.flush();
    const gl = this.gl;
    const from = this.targets[this.current];
    this.current ^= 1;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.targets[this.current].fbo);
    gl.clearColor(br / 255, bg / 255, bb / 255, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const cx = this.width / 2, cy = this.height / 2;
    const cos = Math.cos(rot) * z, sin = Math.sin(rot) * z;
    const corner = (x: number, y: number): [number, number] => [cx + (x - cx) * cos - (y - cy) * sin, cy + (x - cx) * sin + (y - cy) * cos];
    const W = this.width, H = this.height;
    this.blend("normal");
    this.bindImage(from.tex);
    // The frame's texture is stored bottom row first.
    this.texQuad(corner(0, 0), corner(W, 0), corner(W, H), corner(0, H), [0, 1, 1, 1, 1, 0, 0, 0], keep);
    this.flush();
    this.blend(prev);
  }

  blend(mode: Blend): void {
    if (mode === this.blendMode) return;
    this.flush();
    this.blendMode = mode;
    this.applyBlend();
  }

  private applyBlend(): void {
    const gl = this.gl;
    if (this.blendMode === "add") gl.blendFunc(gl.ONE, gl.ONE);
    else gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** A line `width` CSS pixels thick; round ends like `lineCap = "round"`, else cut square at the ends. */
  line(x0: number, y0: number, x1: number, y1: number, width: number, colour: Colour, round = true): void {
    const s = this.scale;
    x0 *= s; y0 *= s; x1 *= s; y1 *= s;
    const r = (width * s) / 2;
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-4 && !round) return;
    const ux = len > 1e-4 ? dx / len : 1, uy = len > 1e-4 ? dy / len : 0;
    const hl = len / 2, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    // A hairline is drawn a pixel wide and fainter, as a canvas would cover it.
    const rr = Math.max(r, 0.5);
    if (rr > r) colour = fade(colour, r / rr);
    const R = rr + 1;
    const L = hl + (round ? R : 0);
    this.quad(cx, cy, ux * L, uy * L, -uy * R, ux * R, L, R, hl, rr, round ? CAPSULE : BUTT, colour);
  }

  /** A filled circle. */
  disc(x: number, y: number, radius: number, colour: Colour): void {
    const s = this.scale, r = Math.max(radius * s, 0.5);
    if (r > radius * s) colour = fade(colour, (radius * s) / r);
    const R = r + 1;
    this.quad(x * s, y * s, R, 0, 0, R, R, R, 0, r, CAPSULE, colour);
  }

  /** A circle outline. */
  ring(x: number, y: number, radius: number, width: number, colour: Colour): void {
    const s = this.scale, r = radius * s, hw = Math.max((width * s) / 2, 0.5);
    const R = r + hw + 1;
    this.quad(x * s, y * s, R, 0, 0, R, R, R, hw, r, RING, colour);
  }

  /** A soft round light `size` CSS pixels across, like `glowSprite` drawn additively; `hue` in degrees, `sat` 0..100. */
  glow(x: number, y: number, size: number, hue: number, sat = 90, alpha = 1): void {
    const s = this.scale, r = (size * s) / 2;
    this.quad(x * s, y * s, r, 0, 0, r, r, r, 0, r, GLOW, hsla(hue, sat / 100, 0.5, alpha));
  }

  /** A filled four-sided shape, corners in order. */
  quad4(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number, colour: Colour): void {
    const s = this.scale;
    const v = this.reserve(6);
    this.vert(v, ax * s, ay * s, 0, 0, SOLID, colour);
    this.vert(v + 1, bx * s, by * s, 0, 0, SOLID, colour);
    this.vert(v + 2, cx * s, cy * s, 0, 0, SOLID, colour);
    this.vert(v + 3, ax * s, ay * s, 0, 0, SOLID, colour);
    this.vert(v + 4, cx * s, cy * s, 0, 0, SOLID, colour);
    this.vert(v + 5, dx * s, dy * s, 0, 0, SOLID, colour);
  }

  /** A filled rectangle in CSS pixels. */
  rect(x: number, y: number, w: number, h: number, colour: Colour): void {
    const s = this.scale;
    this.rawRect(x * s, y * s, w * s, h * s, colour);
  }

  private rawRect(x: number, y: number, w: number, h: number, colour: Colour): void {
    const v = this.reserve(6);
    this.vert(v, x, y, 0, 0, SOLID, colour);
    this.vert(v + 1, x + w, y, 0, 0, SOLID, colour);
    this.vert(v + 2, x + w, y + h, 0, 0, SOLID, colour);
    this.vert(v + 3, x, y, 0, 0, SOLID, colour);
    this.vert(v + 4, x + w, y + h, 0, 0, SOLID, colour);
    this.vert(v + 5, x, y + h, 0, 0, SOLID, colour);
  }

  /**
   * Upload packed RGBA pixels (as `Raster` holds them, top row first, colours
   * already multiplied by alpha) to the texture called `name`.
   */
  upload(name: string, pixels: Uint32Array | Uint8Array | Uint8ClampedArray, w: number, h: number, smooth: boolean): void {
    this.uploadAs(name, new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), w, h, this.gl.RGBA8, this.gl.RGBA, smooth ? this.gl.LINEAR : this.gl.NEAREST, this.gl.CLAMP_TO_EDGE);
  }

  /** Draw an uploaded texture over `x, y, w, h` CSS pixels, `alpha` 0..1. */
  image(name: string, x: number, y: number, w: number, h: number, alpha = 1): void {
    const img = this.images.get(name);
    if (!img) return;
    const s = this.scale;
    this.bindImage(img.tex);
    x *= s; y *= s; w *= s; h *= s;
    this.texQuad([x, y], [x + w, y], [x + w, y + h], [x, y + h], [0, 0, 1, 0, 1, 1, 0, 1], alpha);
  }

  /**
   * Living ink's picture: a `w` x `h` grid of 0..255 shades coloured through
   * `lut` (256 packed colours), smoothed between cells with wrap-around, over
   * `x, y, w, h` CSS pixels. `zoom` above 1 draws it bigger about its centre.
   */
  ink(shade: Uint8Array | Uint8ClampedArray, gw: number, gh: number, lut: Uint32Array, sharp: boolean, x: number, y: number, w: number, h: number, alpha = 1, zoom = 1): void {
    const gl = this.gl;
    this.flush();
    if (this.lastLut !== lut) {
      this.uploadAs("ink-lut", new Uint8Array(lut.buffer, lut.byteOffset, 1024), 256, 1, gl.RGBA8, gl.RGBA, gl.NEAREST, gl.CLAMP_TO_EDGE);
      this.lastLut = lut;
    }
    if (this.inkShade !== shade) {
      this.uploadAs("ink", new Uint8Array(shade.buffer, shade.byteOffset, shade.byteLength), gw, gh, gl.R8, gl.RED, gl.NEAREST, gl.REPEAT);
      this.inkShade = shade;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.images.get("ink-lut")!.tex);
    gl.activeTexture(gl.TEXTURE0);
    this.bindImage(this.images.get("ink")!.tex);
    gl.uniform2i(this.u.grid, gw, gh);
    gl.uniform1i(this.u.sharp, sharp ? 1 : 0);
    const s = this.scale;
    const cx = (x + w / 2) * s, cy = (y + h / 2) * s, hw = (w * s * zoom) / 2, hh = (h * s * zoom) / 2;
    const v = this.reserve(6);
    const c = rgba(255, 255, 255, alpha);
    const corners: [number, number, number, number][] = [[cx - hw, cy - hh, 0, 0], [cx + hw, cy - hh, 1, 0], [cx + hw, cy + hh, 1, 1], [cx - hw, cy - hh, 0, 0], [cx + hw, cy + hh, 1, 1], [cx - hw, cy + hh, 0, 1]];
    corners.forEach(([px, py, u, vv], i) => this.vert(v + i, px, py, u, vv, INK, c));
    this.flush();
  }

  /** Mark the ink grid as changed even if it is the same array, e.g. after the model wrote into it. */
  touchInk(): void {
    this.inkShade = null;
  }

  private lastLut: Uint32Array | null = null;
  private inkShade: Uint8Array | Uint8ClampedArray | null = null;

  private uploadAs(name: string, bytes: Uint8Array, w: number, h: number, internal: number, format: number, filter: number, wrap: number): void {
    const gl = this.gl;
    this.flush();
    let img = this.images.get(name);
    if (!img || img.w !== w || img.h !== h || img.format !== internal) {
      if (img) gl.deleteTexture(img.tex);
      const tex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
      img = { tex, w, h, format: internal };
      this.images.set(name, img);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, img.tex);
    }
    setFilter(gl, filter, wrap);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, gl.UNSIGNED_BYTE, bytes);
    this.boundImage = null;
  }

  private bindImage(tex: WebGLTexture): void {
    if (this.boundImage === tex) return;
    this.flush();
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.boundImage = tex;
  }

  private texQuad(a: [number, number], b: [number, number], c: [number, number], d: [number, number], uv: number[], alpha: number): void {
    const v = this.reserve(6);
    const col = rgba(255, 255, 255, alpha);
    this.vert(v, a[0], a[1], uv[0], uv[1], IMAGE, col);
    this.vert(v + 1, b[0], b[1], uv[2], uv[3], IMAGE, col);
    this.vert(v + 2, c[0], c[1], uv[4], uv[5], IMAGE, col);
    this.vert(v + 3, a[0], a[1], uv[0], uv[1], IMAGE, col);
    this.vert(v + 4, c[0], c[1], uv[4], uv[5], IMAGE, col);
    this.vert(v + 5, d[0], d[1], uv[6], uv[7], IMAGE, col);
    this.flush();
  }

  /**
   * A quad centred on `cx, cy` with half-axes `(ax, ay)` and `(bx, by)` in
   * device pixels; the shape coordinates run ±su along the first and ±sv
   * along the second.
   */
  private quad(cx: number, cy: number, ax: number, ay: number, bx: number, by: number, su: number, sv: number, z: number, w: number, mode: number, colour: Colour): void {
    const v = this.reserve(6);
    const f = this.f32, u = this.u32;
    const put = (i: number, sx: number, sy: number) => {
      const o = (v + i) * STRIDE;
      f[o] = cx + ax * sx + bx * sy;
      f[o + 1] = cy + ay * sx + by * sy;
      f[o + 2] = su * sx;
      f[o + 3] = sv * sy;
      f[o + 4] = z;
      f[o + 5] = w;
      f[o + 6] = mode;
      u[o + 7] = colour;
    };
    put(0, -1, -1); put(1, 1, -1); put(2, 1, 1);
    put(3, -1, -1); put(4, 1, 1); put(5, -1, 1);
  }

  private vert(i: number, x: number, y: number, su: number, sv: number, mode: number, colour: Colour): void {
    const o = i * STRIDE, f = this.f32;
    f[o] = x;
    f[o + 1] = y;
    f[o + 2] = su;
    f[o + 3] = sv;
    f[o + 4] = 0;
    f[o + 5] = 0;
    f[o + 6] = mode;
    this.u32[o + 7] = colour;
  }

  /** Room for `n` more vertices; returns the first one's index. */
  private reserve(n: number): number {
    if ((this.count + n) * STRIDE > this.f32.length) {
      if (this.count * STRIDE * 4 >= 4 * 1024 * 1024) this.flush();
      else {
        const bigger = new ArrayBuffer(this.data.byteLength * 2);
        new Uint8Array(bigger).set(new Uint8Array(this.data));
        this.data = bigger;
        this.f32 = new Float32Array(bigger);
        this.u32 = new Uint32Array(bigger);
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
        gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.STREAM_DRAW);
      }
    }
    const first = this.count;
    this.count += n;
    return first;
  }

  /** Send what has been queued to the GPU. */
  flush(): void {
    if (this.count === 0) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f32, 0, this.count * STRIDE);
    gl.drawArrays(gl.TRIANGLES, 0, this.count);
    this.count = 0;
  }

  /** Put the frame on the canvas through the colour grade. Also redraws an unchanged frame when only the grade moved. */
  show(grade: Grade): void {
    this.flush();
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.present);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.targets[this.current].tex);
    this.boundImage = null;
    const neutral = isNeutral(grade);
    gl.uniform1i(this.pu.graded, neutral ? 0 : 1);
    if (!neutral) gradeUniforms(gl, this.pu, grade);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }
}

/** Scale a packed colour's alpha. */
export function fade(c: Colour, k: number): Colour {
  const a = ((c >>> 24) * k + 0.5) | 0;
  return ((c & 0xffffff) | (Math.min(255, a) << 24)) >>> 0;
}

function setFilter(gl: WebGL2RenderingContext, filter: number, wrap: number): void {
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const shader = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader failed");
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? "link failed");
  return prog;
}
