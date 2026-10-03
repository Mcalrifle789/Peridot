// Full-screen terminal engine: alternate screen buffer, fixed chrome
// (header / status / input / footer), scrollback viewport, overlay menu.
import { stdout } from 'node:process';
import { C, fg, paint, BOLD, DIM, stripAnsi } from './theme.js';

const bg = ([r, g, b]) => `\x1b[48;2;${r};${g};${b}m`;
const BAR_BG = [10, 26, 8];   // near-black green for header/footer bars
const RESET = '\x1b[0m';

// ANSI-aware hard wrap that carries active SGR styles onto continuation lines.
function wrapAnsi(line, width) {
  if (width < 4) width = 4;
  const out = [];
  let cur = '', vis = 0, active = '';
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\x1b') {
      const m = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
      if (m) {
        cur += m[0];
        active = m[0] === RESET ? '' : active + m[0];
        i += m[0].length;
        continue;
      }
    }
    cur += line[i]; vis++; i++;
    if (vis >= width) { out.push(cur + RESET); cur = active; vis = 0; }
  }
  out.push(cur + RESET);
  return out;
}

// Pad/truncate a styled string to an exact visible width (for bg-filled bars).
function fit(str, width) {
  const vis = stripAnsi(str).length;
  if (vis <= width) return str + ' '.repeat(width - vis);
  // crude truncate: strip styles, cut, restyle plain
  return stripAnsi(str).slice(0, width - 1) + '…';
}

const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class Screen {
  constructor(chrome) {
    this.chrome = chrome;        // () => { headerLeft, headerRight, footerLeft, footerRight, statusRight }
    this.lines = [];             // logical scrollback lines
    this.scroll = 0;             // 0 = pinned to bottom
    this.input = { buf: '', pos: 0, placeholder: 'Ask Peridot anything...', prompt: '>>' };
    this.menu = null;            // { title, items: [{ left, right, dim }], sel }
    this.status = null;          // transient status text (spinner)
    this.active = false;
    this._spinTimer = null;
    this._resize = () => this.render();
  }

  enter() {
    stdout.write('\x1b[?1049h\x1b[H\x1b[2J');
    this.active = true;
    stdout.on('resize', this._resize);
    this.render();
  }

  exit() {
    this.stopSpinner();
    stdout.off('resize', this._resize);
    stdout.write('\x1b[?25h\x1b[?1049l');
    this.active = false;
  }

  suspend() {
    stdout.write('\x1b[?25h\x1b[?1049l');
    this.active = false;
  }

  resume() {
    stdout.write('\x1b[?1049h');
    this.active = true;
    this.render();
  }

  size() {
    return { W: stdout.columns || 100, H: stdout.rows || 30 };
  }

  contentHeight() {
    const { H } = this.size();
    return Math.max(H - 6, 3); // rows 3..H-4
  }

  push(text = '') {
    for (const l of String(text).split('\n')) this.lines.push(l);
    if (this.lines.length > 3000) this.lines.splice(0, this.lines.length - 3000);
    this.scroll = 0;
    this.render();
  }

  appendLast(chunk) {
    const parts = String(chunk).split('\n');
    if (this.lines.length === 0) this.lines.push('');
    this.lines[this.lines.length - 1] += parts[0];
    for (let i = 1; i < parts.length; i++) this.lines.push(parts[i]);
    this.scroll = 0;
    this.render();
  }

  clearContent() {
    this.lines = [];
    this.scroll = 0;
    this.render();
  }

  scrollBy(n) {
    const { W } = this.size();
    const total = this.lines.reduce((acc, l) => acc + wrapAnsi(' ' + l, W - 2).length, 0);
    const max = Math.max(total - this.contentHeight(), 0);
    this.scroll = Math.min(Math.max(this.scroll + n, 0), max);
    this.render();
  }

  spinner(text) {
    this.stopSpinner();
    let i = 0;
    this.status = SPIN[0] + ' ' + text;
    this._spinTimer = setInterval(() => {
      this.status = SPIN[++i % SPIN.length] + ' ' + text;
      this.render();
    }, 90);
    this.render();
    return () => this.stopSpinner();
  }

  stopSpinner() {
    if (this._spinTimer) clearInterval(this._spinTimer);
    this._spinTimer = null;
    if (this.status) { this.status = null; if (this.active) this.render(); }
  }

  render() {
    if (!this.active) return;
    const { W, H } = this.size();
    const ch = this.chrome();
    const contentH = this.contentHeight();
    let s = '\x1b[?2026h\x1b[?25l';
    const row = (r, text) => { s += `\x1b[${r};1H\x1b[K` + text; };

    // Bars: re-apply the bar background after every embedded reset so styled
    // spans inside header/footer text don't punch holes in the bar.
    const barify = (text, width) => {
      const solid = bg(BAR_BG) + text.replaceAll(RESET, RESET + bg(BAR_BG));
      return solid + ' '.repeat(Math.max(width - stripAnsi(text).length, 0)) + RESET;
    };

    // header bar (row 1) + rule (row 2)
    row(1, barify(' ' + ch.headerLeft + ' '.repeat(Math.max(W - stripAnsi(ch.headerLeft).length - stripAnsi(ch.headerRight).length - 3, 1)) + ch.headerRight + '  ', W));
    row(2, paint('─'.repeat(W), C.deep, DIM));

    // content viewport (rows 3..H-4)
    const disp = this.lines.flatMap((l) => wrapAnsi(' ' + l, W - 2));
    const end = disp.length - this.scroll;
    const view = disp.slice(Math.max(end - contentH, 0), end);
    const padTop = contentH - view.length;
    for (let i = 0; i < contentH; i++) {
      row(3 + i, i < padTop ? '' : view[i - padTop]);
    }
    if (this.scroll > 0) {
      row(3, paint(` ↑ scrolled ${this.scroll} — pgdn to return `, C.dimg, DIM));
    }

    // overlay menu panel above the input, on top of content
    if (this.menu && this.menu.items.length) {
      const m = this.menu;
      const maxShow = Math.min(m.items.length, Math.max(Math.min(10, contentH - 2), 3));
      if (m.sel >= m.items.length) m.sel = m.items.length - 1;
      if (m.sel < 0) m.sel = 0;
      const scroll = Math.max(0, Math.min(m.sel - maxShow + 1, m.items.length - maxShow));
      const panel = [];
      panel.push(paint('┌─ ', C.dimg) + paint(m.title, C.moss) + paint('  ·  ↑↓ · enter · esc', C.dimg, DIM));
      m.items.slice(scroll, scroll + maxShow).forEach((it, idx) => {
        const i = scroll + idx;
        const mark = i === m.sel ? paint('▸ ', C.neon) : '  ';
        const left = i === m.sel ? paint(it.left, C.neon, BOLD) : (it.dim ? paint(it.left, C.dimg) : paint(it.left, C.green));
        const gap = ' '.repeat(Math.max(16 - stripAnsi(it.left).length, 1));
        panel.push(paint('│ ', C.dimg) + mark + left + gap + paint(it.right || '', it.dim ? C.dimg : C.gray));
      });
      panel.push(paint(m.items.length > maxShow
        ? `└─ ${scroll + 1}–${Math.min(scroll + maxShow, m.items.length)} of ${m.items.length} ▾`
        : '└─', C.dimg));
      const startRow = 3 + contentH - panel.length;
      panel.forEach((p, i) => row(startRow + i, ' ' + p));
    }

    // input line (row H-3), underline (H-2), status (H-1), footer bar (H)
    const maxVis = Math.max(W - 10, 20);
    const start = Math.max(0, this.input.pos - maxVis);
    const view2 = this.input.buf.slice(start, start + maxVis);
    const body = this.input.buf.length === 0
      ? paint(this.input.placeholder, C.dimg, DIM)
      : paint(view2, C.white);
    row(H - 3, ' ' + paint(this.input.prompt, C.neon, BOLD) + ' ' + body);
    row(H - 2, ' ' + paint('─'.repeat(Math.max(W - 2, 10)), C.deep));
    const statusLeft = this.status
      ? paint(this.status, C.neon)
      : paint('local ready | ' + (ch.idle || 'idle'), C.dimg);
    const statusRight = paint(ch.statusRight || '', C.dimg, DIM);
    row(H - 1, ' ' + statusLeft + '\x1b[' + (H - 1) + ';' + Math.max(W - stripAnsi(ch.statusRight || '').length - 1, 1) + 'H' + statusRight);
    row(H, barify('  ' + ch.footerLeft + ' '.repeat(Math.max(W - stripAnsi(ch.footerLeft).length - stripAnsi(ch.footerRight).length - 5, 1)) + ch.footerRight + '   ', W));

    // park the cursor in the input line
    const col = 2 + stripAnsi(this.input.prompt).length + 1 + (this.input.pos - start) + 1;
    s += `\x1b[${H - 3};${col}H` + (this.status ? '\x1b[?25l' : '\x1b[?25h');
    s += '\x1b[?2026l';
    stdout.write(s);
  }
}
