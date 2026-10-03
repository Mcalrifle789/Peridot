import { C, gradientBlock, paint, DIM } from './theme.js';

// Glowing infinity loop — the peridot structure.
const INFINITY = [
  '                    .:oOOo:.    .:oOOo:.  ',
  "                   oO'    'Oo..oO'    'Oo ",
  '                  O:        :OO:        :O',
  '                  O:        :OO:        :O',
  "                   Oo.    .oO''Oo.    .oO ",
  "                    ':oOOo:'    ':oOOo:'  ",
];

// Fallback block wordmark, used only if the generated Neuton art is missing.
const BLOCK_WORDMARK = [
  ' ██████╗ ███████╗ ██████╗  ██╗ ██████╗   ██████╗  ████████╗',
  ' ██╔══██╗██╔════╝ ██╔══██╗ ██║ ██╔══██╗ ██╔═══██╗ ╚══██╔══╝',
  ' ██████╔╝█████╗   ██████╔╝ ██║ ██║  ██║ ██║   ██║    ██║   ',
  ' ██╔═══╝ ██╔══╝   ██╔══██╗ ██║ ██║  ██║ ██║   ██║    ██║   ',
  ' ██║     ███████╗ ██║  ██║ ██║ ██████╔╝ ╚██████╔╝    ██║   ',
  ' ╚═╝     ╚══════╝ ╚═╝  ╚═╝ ╚═╝ ╚═════╝   ╚═════╝     ╚═╝   ',
];

// Neuton-font wordmark, pre-rendered to ANSI half-block art by scripts/gen-wordmark.py.
let NEUTON = null;
try {
  ({ WORDMARK: NEUTON } = await import('./wordmark.js'));
} catch { /* fall back to block letters */ }

export function logo() {
  const inf = gradientBlock(INFINITY, C.deep, C.green, DIM);
  const word = NEUTON
    ? NEUTON.map((l) => ' ' + l)
    : gradientBlock(BLOCK_WORDMARK, C.chart, C.neon);
  return [...inf, ...word].join('\n');
}

export function smallMark() {
  return paint('◈ peridot', C.neon);
}
