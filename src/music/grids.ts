/**
 * A drum map in the spirit of Mutable Instruments' Grids: a grid of two-bar
 * kick/snare/hat patterns, each step weighted by how essential it is. A point
 * on the map blends the four nearest patterns, and a drum's Fill sets how
 * weak a step may be and still play, so turning Fill up only ever adds hits.
 *
 * The patterns are Tonefield's own, written for this map; no tables or code
 * come from the Grids firmware.
 */

/** Steps in a map pattern: two bars of sixteenths. */
export const GRIDS_STEPS = 32;

/**
 * The map's patterns, by row (Y, sparse at 0 to busy at the top) and then
 * column (X, straight on the left to broken on the right). Each drum's step
 * weight is a digit, 9 the backbone and 1 a faint ornament; spaces are only
 * for reading.
 */
const NODES: { kick: string; snare: string; hat: string }[][] = [
  // Sparse, half-time.
  [
    { // Pulse
      kick: "9000 0000 4000 0000 9000 0000 4000 0000",
      snare: "0000 0000 8000 0000 0000 0000 8000 0002",
      hat: "6020 4020 6020 4020 6020 4020 6020 4031" },
    { // Half-time rock
      kick: "9000 0050 0000 0000 9000 0030 0060 0000",
      snare: "0000 0000 9000 0001 0000 0000 9000 0030",
      hat: "7030 5030 7030 5030 7030 5030 7030 5050" },
    { // Half-time hip-hop
      kick: "9000 0060 0040 0000 9000 0000 0700 0030",
      snare: "0000 0000 9000 0000 0000 0000 9000 0400",
      hat: "6040 6140 6040 6140 6040 6140 6040 6343" },
    { // Dub
      kick: "9000 0000 0700 0000 0000 0060 0000 0000",
      snare: "0000 0300 9000 0020 0000 0030 9000 0200",
      hat: "8000 0050 0040 5000 8000 0050 0040 5030" },
  ],
  // Steady.
  [
    { // Four on the floor
      kick: "9000 9000 9000 9001 9000 9000 9000 9030",
      snare: "0000 9000 0000 9000 0000 9000 0000 9002",
      hat: "0180 2181 0180 2181 0180 2181 0180 2383" },
    { // Backbeat
      kick: "9000 0000 7060 0000 9000 0000 7000 0050",
      snare: "0000 9000 0000 9000 0000 9000 0000 9030",
      hat: "8050 7050 8050 7050 8050 7050 8050 7253" },
    { // Boom bap
      kick: "9000 0006 0090 0000 9000 0040 0080 0060",
      snare: "0000 9000 0002 9001 0000 9000 0020 9003",
      hat: "7363 6363 7363 6363 7363 6363 7363 6465" },
    { // Breakbeat
      kick: "9080 0000 0097 0000 9080 0000 0060 0400",
      snare: "0000 9006 0700 9005 0000 9006 0700 9060",
      hat: "8060 7060 8060 7060 8060 7060 8060 7060" },
  ],
  // Busy.
  [
    { // Driving techno
      kick: "9002 9000 9002 9000 9002 9000 9002 9050",
      snare: "0000 9000 0010 9000 0000 9000 0010 9365",
      hat: "4282 4282 4282 4282 4282 4282 4282 4292" },
    { // Disco
      kick: "9000 0060 8000 0050 9000 0060 8000 0300",
      snare: "0000 9000 0003 9000 0000 9000 0003 9370",
      hat: "8484 7484 8484 7484 8484 7484 8484 7686" },
    { // Funk
      kick: "9007 0050 0090 0070 9006 0050 0090 3050",
      snare: "0030 9003 0300 9030 0030 9003 0300 9353",
      hat: "8686 7686 8686 7686 8686 7686 8686 7898" },
    { // Jungle
      kick: "9080 0000 0090 0050 9080 0000 0400 0070",
      snare: "0000 9007 0700 9007 0300 9007 0700 9897",
      hat: "6464 6464 6464 6464 6464 6464 6464 6575" },
  ],
  // Frantic.
  [
    { // Hard groove
      kick: "9050 9050 9050 9050 9050 9050 9050 9070",
      snare: "0000 9000 0000 9000 0000 9000 0040 9686",
      hat: "6868 6868 6868 6868 6868 6868 6868 6898" },
    { // Two-step
      kick: "9000 0000 0070 0000 9000 0000 0080 0000",
      snare: "0000 9000 0000 9000 0000 9000 0000 9060",
      hat: "7473 7473 7473 7473 7473 7473 7473 7686" },
    { // Broken and busy
      kick: "9050 0070 0090 5007 9050 0070 0090 0700",
      snare: "0040 9020 0070 9040 0040 9020 0070 9585",
      hat: "8676 8676 8676 8676 8676 8676 8676 8898" },
    { // Glitch
      kick: "9007 0060 7008 0050 9070 0007 0080 6090",
      snare: "0060 9008 0070 0950 0005 9070 0800 9878",
      hat: "7350 5735 0573 5057 3505 7350 5735 8888" },
  ],
];

const ROWS = NODES.length;
const COLS = NODES[0].length;
const DRUM_KEYS = ["kick", "snare", "hat"] as const;

/** Every node's weights as 0..1 levels: [row][col][drum][step]. */
const LEVELS: Float32Array[][][] = NODES.map((row) =>
  row.map((node) =>
    DRUM_KEYS.map((d) => {
      const digits = node[d].replace(/\s+/g, "");
      if (digits.length !== GRIDS_STEPS) throw new Error(`Grids map: ${d} pattern needs ${GRIDS_STEPS} steps`);
      return Float32Array.from(digits, (c) => Number(c) / 9);
    }),
  ),
);

/** Names for where the map is, for the pad's readout. */
export const GRIDS_NAMES: string[][] = [
  ["Pulse", "Half-time rock", "Half-time hip-hop", "Dub"],
  ["Four on the floor", "Backbeat", "Boom bap", "Breakbeat"],
  ["Driving techno", "Disco", "Funk", "Jungle"],
  ["Hard groove", "Two-step", "Broken and busy", "Glitch"],
];

export const GRIDS_ROWS = ROWS;
export const GRIDS_COLS = COLS;

/** The nearest named pattern to a point on the map. */
export function gridsName(x: number, y: number): string {
  const c = Math.round(Math.max(0, Math.min(1, x)) * (COLS - 1));
  const r = Math.round(Math.max(0, Math.min(1, y)) * (ROWS - 1));
  return GRIDS_NAMES[r][c];
}

/**
 * One drum's step levels at a point on the map (x and y 0..1), blended from
 * the four surrounding patterns. Writes into `out` (GRIDS_STEPS long).
 */
export function gridsLevels(drum: number, x: number, y: number, out: Float32Array): Float32Array {
  const gx = Math.max(0, Math.min(1, x)) * (COLS - 1);
  const gy = Math.max(0, Math.min(1, y)) * (ROWS - 1);
  const c = Math.min(COLS - 2, Math.floor(gx)), r = Math.min(ROWS - 2, Math.floor(gy));
  const fx = gx - c, fy = gy - r;
  const a = LEVELS[r][c][drum], b = LEVELS[r][c + 1][drum];
  const d = LEVELS[r + 1][c][drum], e = LEVELS[r + 1][c + 1][drum];
  for (let k = 0; k < GRIDS_STEPS; k++) {
    const top = a[k] + (b[k] - a[k]) * fx;
    const bottom = d[k] + (e[k] - d[k]) * fx;
    out[k] = top + (bottom - top) * fy;
  }
  return out;
}

/** The level a step needs to play at a Fill of 0..1: none at 0, every weighted step at 1. */
export function gridsThreshold(fill: number): number {
  return fill <= 0 ? Infinity : 1 - fill;
}
