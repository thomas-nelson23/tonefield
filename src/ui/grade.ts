/**
 * The global colour controls, applied on the GPU. A CSS filter on the canvas
 * does the same job, but the webview recomputes it on the CPU for every frame
 * of a full-screen canvas, which cost close to half the frame rate. Here the
 * finished picture is copied into a WebGL canvas laid over it and the colour
 * maths runs in a shader. When every control is neutral nothing extra happens.
 */

export interface Grade {
  /** Degrees round the colour wheel. */
  hue: number;
  saturation: number;
  brightness: number;
  contrast: number;
  invert: boolean;
}

const VERTEX = `
attribute vec2 pos;
varying vec2 uv;
void main() {
  uv = vec2(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
  gl_Position = vec4(pos, 0.0, 1.0);
}`;

// The same steps, in the same order, as the CSS filter the controls used to build:
// hue-rotate, saturate, brightness, contrast, invert (matrices from the Filter Effects spec).
const FRAGMENT = `
precision mediump float;
varying vec2 uv;
uniform sampler2D image;
uniform mat3 hue;
uniform float saturation, brightness, contrast, invert;
void main() {
  vec4 c = texture2D(image, uv);
  vec3 rgb = clamp(hue * c.rgb, 0.0, 1.0);
  float luma = dot(rgb, vec3(0.213, 0.715, 0.072));
  rgb = clamp(mix(vec3(luma), rgb, saturation), 0.0, 1.0);
  rgb = clamp(rgb * brightness, 0.0, 1.0);
  rgb = clamp((rgb - 0.5) * contrast + 0.5, 0.0, 1.0);
  rgb = mix(rgb, 1.0 - rgb, invert);
  gl_FragColor = vec4(rgb, 1.0);
}`;

function hueMatrix(deg: number): Float32Array {
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  // Row-major from the spec, written column by column for WebGL.
  const m = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ];
  return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
}

export function isNeutral(g: Grade): boolean {
  const hue = ((g.hue % 360) + 360) % 360;
  return (hue < 0.5 || hue > 359.5) && g.saturation === 1 && g.brightness === 1 && g.contrast === 1 && !g.invert;
}

/** The CSS filter for the same grade, for webviews without WebGL. */
export function cssFilter(g: Grade): string {
  if (isNeutral(g)) return "";
  const parts: string[] = [];
  const hue = ((g.hue % 360) + 360) % 360;
  if (hue > 0.5 && hue < 359.5) parts.push(`hue-rotate(${hue.toFixed(1)}deg)`);
  if (g.saturation !== 1) parts.push(`saturate(${g.saturation})`);
  if (g.brightness !== 1) parts.push(`brightness(${g.brightness})`);
  if (g.contrast !== 1) parts.push(`contrast(${g.contrast})`);
  if (g.invert) parts.push("invert(1)");
  return parts.join(" ");
}

/** Frames each way while trying both: the first few after a switch are skipped. */
const TRIAL_FRAMES = 50;
const TRIAL_SKIP = 8;

/**
 * Which is faster depends on the machine: with a real GPU the shader is close
 * to free, but where WebGL itself runs on the CPU it can lose to the filter.
 * So the first time the colour controls are used, each way runs for a moment
 * (they look the same) and the faster one is kept until the app restarts.
 */
type Mode = "gpu" | "css";

export class ColourGrade {
  private overlay: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private mode: Mode | null = null;
  private shown: Mode | null = null;
  private cssShown = "";
  private trial: { mode: Mode; frames: number; start: number; time: Record<Mode, number> } = { mode: "gpu", frames: 0, start: 0, time: { gpu: 0, css: 0 } };

  constructor(private readonly source: HTMLCanvasElement) {}

  /** The WebGL overlay, made the first time it's needed; null where WebGL is missing. */
  private context(): WebGLRenderingContext | null {
    if (this.overlay) return this.gl;
    this.overlay = document.createElement("canvas");
    this.overlay.className = "grade";
    this.overlay.hidden = true;
    this.source.after(this.overlay);
    const gl = this.overlay.getContext("webgl", { alpha: false, antialias: false, depth: false, preserveDrawingBuffer: false });
    this.gl = gl && this.setup(gl) ? gl : null;
    return this.gl;
  }

  private setup(gl: WebGLRenderingContext): boolean {
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = shader(gl.VERTEX_SHADER, VERTEX), fs = shader(gl.FRAGMENT_SHADER, FRAGMENT);
    if (!vs || !fs) return false;
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, "pos");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    gl.bindTexture(gl.TEXTURE_2D, gl.createTexture());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    for (const u of ["hue", "saturation", "brightness", "contrast", "invert"]) this.uniforms[u] = gl.getUniformLocation(prog, u);
    return true;
  }

  /** Show the canvas through `grade`. Call once per frame, after the model has drawn. */
  draw(grade: Grade): void {
    if (isNeutral(grade)) {
      this.show(null, "");
      // A trial cut short starts over next time, so idle frames don't skew it.
      if (!this.mode) this.trial = { mode: "gpu", frames: 0, start: 0, time: { gpu: 0, css: 0 } };
      return;
    }
    let mode = this.mode ?? (this.context() ? this.trialStep() : "css");
    if (mode === "gpu" && !this.drawGpu(grade)) mode = this.mode = "css";
    this.show(mode, mode === "css" ? cssFilter(grade) : "");
  }

  /** Time one more frame of the trial and say which way to draw it. */
  private trialStep(): Mode {
    const t = this.trial, now = performance.now();
    t.frames++;
    if (t.frames === TRIAL_SKIP) t.start = now;
    if (t.frames === TRIAL_SKIP + TRIAL_FRAMES) {
      t.time[t.mode] = (now - t.start) / TRIAL_FRAMES;
      if (t.mode === "gpu") {
        t.mode = "css";
        t.frames = 0;
      } else {
        // The GPU way also leaves the CPU free for the models, so it wins a near tie.
        this.mode = t.time.gpu <= t.time.css * 1.05 ? "gpu" : "css";
        return this.mode;
      }
    }
    return t.mode;
  }

  private show(mode: Mode | null, css: string): void {
    if (css !== this.cssShown) this.source.style.filter = this.cssShown = css;
    if (mode === this.shown) return;
    this.shown = mode;
    if (this.overlay) this.overlay.hidden = mode !== "gpu";
    // Left showing under the overlay it would still be composited every frame.
    this.source.style.visibility = mode === "gpu" ? "hidden" : "";
  }

  private drawGpu(grade: Grade): boolean {
    const gl = this.gl, src = this.source, out = this.overlay;
    if (!gl || !out || gl.isContextLost()) return false;
    if (out.width !== src.width || out.height !== src.height) {
      out.width = src.width;
      out.height = src.height;
      gl.viewport(0, 0, src.width, src.height);
    }
    if (out.style.width !== src.style.width || out.style.height !== src.style.height) {
      out.style.width = src.style.width;
      out.style.height = src.style.height;
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    const u = this.uniforms;
    gl.uniformMatrix3fv(u.hue, false, hueMatrix(grade.hue));
    gl.uniform1f(u.saturation, grade.saturation);
    gl.uniform1f(u.brightness, grade.brightness);
    gl.uniform1f(u.contrast, grade.contrast);
    gl.uniform1f(u.invert, grade.invert ? 1 : 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }
}
