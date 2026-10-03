// Peridot theme — matrix/peridot green on pitch black, 24-bit ANSI.
export const RESET = '\x1b[0m';
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const ITALIC = '\x1b[3m';
export const UNDER = '\x1b[4m';
export const HIDE_CURSOR = '\x1b[?25l';
export const SHOW_CURSOR = '\x1b[?25h';

export const C = {
  neon: [128, 255, 0],     // #80FF00 signature peridot
  chart: [204, 255, 0],    // chartreuse highlight (logo core)
  lime: [57, 255, 20],     // electric lime
  green: [0, 220, 60],     // matrix green
  mid: [34, 197, 94],      // balanced green
  deep: [24, 140, 60],     // deep green
  moss: [110, 150, 90],    // muted moss (secondary text)
  dimg: [70, 110, 60],     // dim structure lines
  gray: [140, 160, 140],   // gray-green (tertiary)
  white: [235, 255, 235],  // near-white green tint
  red: [255, 90, 90],
  yellow: [255, 220, 90],
};

export const fg = ([r, g, b]) => `\x1b[38;2;${r};${g};${b}m`;

export const paint = (text, color, ...styles) => styles.join('') + fg(color) + text + RESET;

export const neon = (t) => paint(t, C.neon);
export const nb = (t) => paint(t, C.neon, BOLD);
export const soft = (t) => paint(t, C.moss);
export const dim = (t) => paint(t, C.dimg);
export const grey = (t) => paint(t, C.gray);
export const white = (t) => paint(t, C.white);
export const warn = (t) => paint(t, C.yellow);
export const err = (t) => paint(t, C.red);

const lerp = (a, b, t) => Math.round(a + (b - a) * t);

// Horizontal per-character gradient.
export function gradient(text, from, to, styles = '') {
  const chars = [...text];
  const n = Math.max(chars.length - 1, 1);
  let out = styles;
  for (let i = 0; i < chars.length; i++) {
    const t = i / n;
    if (chars[i] === ' ') { out += ' '; continue; }
    out += fg([lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)]) + chars[i];
  }
  return out + RESET;
}

// Vertical gradient across an array of lines.
export function gradientBlock(lines, from, to, styles = '') {
  const n = Math.max(lines.length - 1, 1);
  return lines.map((line, i) => {
    const t = i / n;
    const c = [lerp(from[0], to[0], t), lerp(from[1], to[1], t), lerp(from[2], to[2], t)];
    return styles + fg(c) + line + RESET;
  });
}

export const cols = () => process.stdout.columns || 100;

export function rule(width = cols() - 2, color = C.dimg) {
  return paint('─'.repeat(Math.max(width, 10)), color);
}

// Left text + right text pushed to the edge.
export function spread(left, right, width = cols()) {
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const pad = Math.max(width - strip(left).length - strip(right).length - 1, 1);
  return left + ' '.repeat(pad) + right;
}

export const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
