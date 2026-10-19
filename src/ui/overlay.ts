/**
 * One canvas laid over a block of controls, on which every live bar in the
 * block (meters, modulation markers) is drawn.
 *
 * Why not move each bar's own element: WebKitGTK repaints without the GPU on
 * Thomas's PC, and it repaints the *whole window* whenever more than ten
 * separate spots changed in a frame (DrawingAreaCoordinatedGraphics only
 * paints individual rects up to that count). Five strip meters plus a few
 * slider markers crossed that line every tick, so each tick repainted every
 * panel, which halved the frame rate while music played. Drawn on one canvas
 * per block, all of a block's bars are one changed spot.
 *
 * The block is made `position: relative` so the bars' positions can be read
 * off `offsetTop`/`offsetLeft`. Positions are measured once and again only
 * after the block changes size (rows shown, hidden or folded, help toggled,
 * the panel resized), so a tick never forces a layout.
 */

export type BarDraw = (g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) => void;

interface Item {
  el: HTMLElement;
  x: number;
  y: number;
  w: number;
  h: number;
  draw: BarDraw;
  /** Whether the bar has anything to show now; an idle bar stays out of the redrawn area. */
  active: () => boolean;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class LiveOverlay {
  private readonly canvas = document.createElement("canvas");
  private readonly g: CanvasRenderingContext2D | null;
  private items: Item[] = [];
  private measured = false;
  private shown = "";
  private w = 0;
  private h = 0;
  private dpr = 1;
  /** The area drawn last time, which the next draw clears. */
  private last: Box | null = null;
  private readonly observer: ResizeObserver;
  /** The fill every bar is drawn with unless its `draw` picks its own. */
  fill = "#2ad4ff";

  /** `restyle` runs after each measurement, to read colours off the block's computed style. */
  constructor(private readonly block: HTMLElement, private readonly restyle?: (o: LiveOverlay) => void) {
    block.classList.add("live-block");
    this.canvas.className = "live-overlay";
    this.canvas.setAttribute("aria-hidden", "true");
    this.g = this.canvas.getContext("2d");
    block.append(this.canvas);
    this.observer = new ResizeObserver(() => {
      this.measured = false;
      this.shown = "";
    });
    this.observer.observe(block);
  }

  /** Draw `draw` over `el` (which must be inside the block) whenever the overlay redraws. */
  add(el: HTMLElement, draw: BarDraw, active: () => boolean = () => true): void {
    this.items.push({ el, x: 0, y: 0, w: 0, h: 0, draw, active });
    this.measured = false;
    this.shown = "";
  }

  /** The block's own computed style, read once per measurement for colours. */
  colour(name: string, fallback: string): string {
    return getComputedStyle(this.block).getPropertyValue(name).trim() || fallback;
  }

  /**
   * Redraw the bars. `key` describes what would be drawn, so a tick that
   * would draw the same picture touches nothing. Only the area the active
   * bars cover (and the area the last draw covered) is cleared and drawn, so
   * the webview repaints that much of the block, not all of it.
   */
  draw(key: string): void {
    if (key === this.shown || !this.g) return;
    this.shown = key;
    if (!this.measured) this.measure();
    if (this.w === 0 || this.h === 0) return;
    const g = this.g;
    let box: Box | null = null;
    const live: Item[] = [];
    for (const it of this.items) {
      if (it.w <= 0 || it.h <= 0 || !it.active()) continue;
      live.push(it);
      box = box
        ? { x0: Math.min(box.x0, it.x), y0: Math.min(box.y0, it.y), x1: Math.max(box.x1, it.x + it.w), y1: Math.max(box.y1, it.y + it.h) }
        : { x0: it.x, y0: it.y, x1: it.x + it.w, y1: it.y + it.h };
    }
    const clear = this.last && box
      ? { x0: Math.min(this.last.x0, box.x0), y0: Math.min(this.last.y0, box.y0), x1: Math.max(this.last.x1, box.x1), y1: Math.max(this.last.y1, box.y1) }
      : this.last ?? box;
    this.last = box;
    if (!clear) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(clear.x0, clear.y0, clear.x1 - clear.x0, clear.y1 - clear.y0);
    g.fillStyle = this.fill;
    for (const it of live) it.draw(g, it.x, it.y, it.w, it.h);
  }

  dispose(): void {
    this.observer.disconnect();
    this.canvas.remove();
    this.items = [];
  }

  private measure(): void {
    this.measured = true;
    this.dpr = window.devicePixelRatio || 1;
    this.w = this.block.clientWidth;
    this.h = this.block.clientHeight;
    const pw = Math.round(this.w * this.dpr), ph = Math.round(this.h * this.dpr);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
      // A resized canvas starts blank.
      this.last = null;
    }
    for (const it of this.items) {
      let x = 0, y = 0;
      let e: HTMLElement | null = it.el;
      while (e && e !== this.block) {
        x += e.offsetLeft;
        y += e.offsetTop;
        e = e.offsetParent as HTMLElement | null;
      }
      // Hidden, or not inside the block after all: nothing to draw.
      if (e !== this.block) {
        it.w = it.h = 0;
        continue;
      }
      it.x = x;
      it.y = y;
      it.w = it.el.offsetWidth;
      it.h = it.el.offsetHeight;
    }
    this.restyle?.(this);
  }
}

/** A horizontal bar with rounded ends, like the meter tracks it is drawn over. */
export function bar(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number): void {
  if (w <= 0) return;
  if (typeof g.roundRect === "function") {
    g.beginPath();
    g.roundRect(x, y, Math.max(w, h), h, h / 2);
    g.fill();
  } else {
    g.fillRect(x, y, w, h);
  }
}

/** Quantise a 0..1 level to a hundredth, for an overlay's key. */
export function q(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 100);
}
