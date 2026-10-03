import { stdin, stdout } from 'node:process';
import {
  C, fg, RESET, BOLD, DIM, paint, rule, spread, stripAnsi, cols,
  neon, nb, soft, dim, grey, white, HIDE_CURSOR, SHOW_CURSOR,
} from './theme.js';

// ─── raw keyboard ────────────────────────────────────────────────────────────
export function rawStart() { if (stdin.isTTY) stdin.setRawMode(true); stdin.resume(); }
export function rawStop() { if (stdin.isTTY) stdin.setRawMode(false); stdin.pause(); }

function parseKeys(str) {
  const keys = [];
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch === '\x1b') {
      if (str[i + 1] === '[' || str[i + 1] === 'O') {
        const code = str[i + 2];
        const map = { A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end' };
        if (map[code]) { keys.push({ name: map[code] }); i += 3; continue; }
        if (/[0-9]/.test(code)) {
          let j = i + 2, num = '';
          while (j < str.length && /[0-9;]/.test(str[j])) { num += str[j]; j++; }
          if (str[j] === '~') {
            const tmap = { 1: 'home', 3: 'delete', 4: 'end', 5: 'pageup', 6: 'pagedown', 7: 'home', 8: 'end' };
            if (tmap[num]) keys.push({ name: tmap[num] });
            i = j + 1; continue;
          }
        }
        // swallow unknown CSI sequence
        let j = i + 2;
        while (j < str.length && !/[a-zA-Z~]/.test(str[j])) j++;
        i = j + 1; continue;
      }
      keys.push({ name: 'escape' }); i++; continue;
    }
    if (ch === '\r' || ch === '\n') { keys.push({ name: 'enter' }); i++; continue; }
    if (ch === '\x7f' || ch === '\b') { keys.push({ name: 'backspace' }); i++; continue; }
    if (ch === '\t') { keys.push({ name: 'tab' }); i++; continue; }
    if (ch === '\x03') { keys.push({ name: 'ctrl-c' }); i++; continue; }
    if (ch === '\x04') { keys.push({ name: 'ctrl-d' }); i++; continue; }
    if (ch >= ' ') { keys.push({ name: 'char', ch }); i++; continue; }
    i++;
  }
  return keys;
}

export function onKeys(handler) {
  const listener = (data) => {
    for (const key of parseKeys(data.toString('utf8'))) handler(key);
  };
  stdin.on('data', listener);
  return () => stdin.off('data', listener);
}

// ─── repaintable bottom area ─────────────────────────────────────────────────
export class Area {
  constructor() { this.rows = 0; this.curRow = 0; }
  render(lines, cRow = lines.length - 1, cCol = 0) {
    let out = '';
    if (this.rows > 0) out += (this.curRow > 0 ? `\x1b[${this.curRow}F` : '\r') + '\x1b[J';
    out += lines.join('\n') + '\n';
    const up = lines.length - cRow;
    if (up > 0) out += `\x1b[${up}A`;
    out += '\r';
    if (cCol > 0) out += `\x1b[${cCol}C`;
    stdout.write(out);
    this.rows = lines.length;
    this.curRow = cRow;
  }
  clear() {
    if (this.rows > 0) stdout.write((this.curRow > 0 ? `\x1b[${this.curRow}F` : '\r') + '\x1b[J');
    this.rows = 0;
    this.curRow = 0;
  }
}

// ─── spinner ─────────────────────────────────────────────────────────────────
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function spinnerStart(text) {
  let i = 0;
  stdout.write(HIDE_CURSOR);
  const timer = setInterval(() => {
    stdout.write('\r\x1b[K ' + neon(FRAMES[i++ % FRAMES.length]) + ' ' + soft(text));
  }, 80);
  return (finalLine) => {
    clearInterval(timer);
    stdout.write('\r\x1b[K' + (finalLine ? finalLine + '\n' : '') + SHOW_CURSOR);
  };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── chat line editor with slash-command menu ────────────────────────────────
const MENU_MAX = 8;

export function lineEditor({ footerLeft, footerRight, commands, audioOn, placeholder = 'Ask Peridot anything...' }) {
  return new Promise((resolve) => {
    const area = new Area();
    let buf = '';
    let pos = 0;
    let sel = 0;

    const filtered = () => {
      if (!buf.startsWith('/') || buf.includes(' ')) return null;
      const q = buf.slice(1).toLowerCase();
      const pre = commands.filter((c) => c.name.startsWith(q));
      const rest = commands.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.cat.startsWith(q)));
      const list = [...pre, ...rest];
      return list.length ? list : null;
    };

    const draw = () => {
      const width = cols();
      const lines = [''];
      const maxVis = Math.max(width - 10, 20);
      const start = Math.max(0, pos - maxVis);
      const view = buf.slice(start, start + maxVis);
      const inputBody = buf.length === 0
        ? paint(placeholder, C.dimg, DIM)
        : white(view);
      lines.push(' ' + nb('>>') + ' ' + inputBody);
      lines.push(' ' + rule(Math.min(width - 4, 120), C.deep));

      const menu = filtered();
      if (menu) {
        if (sel >= menu.length) sel = menu.length - 1;
        if (sel < 0) sel = 0;
        const scroll = Math.max(0, Math.min(sel - MENU_MAX + 1, menu.length - MENU_MAX));
        lines.push(' ' + dim('┌─ ') + soft(`commands ${menu.length}/${commands.length}`) +
          dim('  ·  ↑↓ navigate · enter select · esc close'));
        menu.slice(scroll, scroll + MENU_MAX).forEach((c, idx) => {
          const i = scroll + idx;
          const locked = c.audio && !audioOn;
          const marker = i === sel ? neon('▸ ') : '  ';
          const name = i === sel ? nb('/' + c.name) : (locked ? dim('/' + c.name) : paint('/' + c.name, C.green));
          const pad = ' '.repeat(Math.max(14 - c.name.length, 1));
          const desc = locked ? dim(c.desc + '  (locked · audio keys required)') : grey(c.desc);
          lines.push(' ' + dim('│') + ' ' + marker + name + pad + desc);
        });
        if (menu.length > MENU_MAX) {
          lines.push(' ' + dim(`└─ ${scroll + 1}–${Math.min(scroll + MENU_MAX, menu.length)} of ${menu.length} ▾`));
        } else {
          lines.push(' ' + dim('└─'));
        }
      }

      lines.push(spread('  ' + soft('Model: ') + neon(footerLeft), grey(footerRight) + '  ', Math.min(width, 122)));
      area.render(lines, 1, 4 + (pos - start));
    };

    const off = onKeys((key) => {
      const menu = filtered();
      switch (key.name) {
        case 'char':
          buf = buf.slice(0, pos) + key.ch + buf.slice(pos);
          pos++;
          sel = 0;
          break;
        case 'backspace':
          if (pos > 0) { buf = buf.slice(0, pos - 1) + buf.slice(pos); pos--; }
          break;
        case 'delete':
          buf = buf.slice(0, pos) + buf.slice(pos + 1);
          break;
        case 'left': if (pos > 0) pos--; break;
        case 'right': if (pos < buf.length) pos++; break;
        case 'home': pos = 0; break;
        case 'end': pos = buf.length; break;
        case 'up': if (menu) sel = Math.max(sel - 1, 0); break;
        case 'down': if (menu) sel = Math.min(sel + 1, menu.length - 1); break;
        case 'tab':
          if (menu) { buf = '/' + menu[sel].name + (menu[sel].args ? ' ' : ''); pos = buf.length; }
          break;
        case 'escape':
          if (menu) { buf = ''; pos = 0; } else { buf = ''; pos = 0; }
          break;
        case 'enter': {
          if (menu) {
            const c = menu[sel];
            if (c.args && buf !== '/' + c.name) {
              buf = '/' + c.name + ' ';
              pos = buf.length;
              break;
            }
            off(); area.clear(); resolve('/' + c.name); return;
          }
          const out = buf.trim();
          if (!out) break;
          off(); area.clear(); resolve(out); return;
        }
        case 'ctrl-c':
        case 'ctrl-d':
          off(); area.clear(); resolve('/exit'); return;
      }
      draw();
    });

    draw();
  });
}

// ─── wizard controls ─────────────────────────────────────────────────────────
// `trim: false` keeps the input exactly as typed (passwords).
export function textInput({ label, mask = false, allowEmpty = false, hint = '', trim = true }) {
  return new Promise((resolve) => {
    const area = new Area();
    let buf = '';
    let pos = 0;

    const draw = () => {
      const lines = [];
      lines.push(' ' + soft(label) + (hint ? '  ' + dim(hint) : ''));
      const shown = mask ? '•'.repeat(buf.length) : buf;
      lines.push(' ' + nb('>') + ' ' + white(shown));
      lines.push(' ' + rule(48, C.deep));
      area.render(lines, 1, 3 + pos);
    };

    const off = onKeys((key) => {
      switch (key.name) {
        case 'char': buf = buf.slice(0, pos) + key.ch + buf.slice(pos); pos++; break;
        case 'backspace': if (pos > 0) { buf = buf.slice(0, pos - 1) + buf.slice(pos); pos--; } break;
        case 'delete': buf = buf.slice(0, pos) + buf.slice(pos + 1); break;
        case 'left': if (pos > 0) pos--; break;
        case 'right': if (pos < buf.length) pos++; break;
        case 'home': pos = 0; break;
        case 'end': pos = buf.length; break;
        case 'enter': {
          const value = trim ? buf.trim() : buf;
          if (!value && !allowEmpty) break;
          off(); area.clear();
          stdout.write(' ' + soft(label) + ' ' + neon(mask ? '•'.repeat(Math.min(value.length, 8)) || '(skipped)' : value || '(skipped)') + '\n');
          resolve(value);
          return;
        }
        case 'ctrl-c': off(); area.clear(); resolve(null); return;
      }
      draw();
    });

    draw();
  });
}

export function singleSelect({ title, items }) {
  return new Promise((resolve) => {
    const area = new Area();
    let sel = 0;

    const draw = () => {
      const lines = [' ' + soft(title) + '  ' + dim('↑↓ · enter')];
      items.forEach((it, i) => {
        const marker = i === sel ? neon('▸ ') : '  ';
        const label = i === sel ? nb(it.label) : paint(it.label, C.green);
        lines.push('   ' + marker + label + (it.desc ? '  ' + grey(it.desc) : ''));
      });
      area.render(lines, lines.length - 1, 0);
    };

    const off = onKeys((key) => {
      switch (key.name) {
        case 'up': sel = (sel - 1 + items.length) % items.length; break;
        case 'down': sel = (sel + 1) % items.length; break;
        case 'enter':
          off(); area.clear();
          stdout.write(' ' + soft(title) + ' ' + neon(items[sel].label) + '\n');
          resolve(items[sel]);
          return;
        case 'ctrl-c': off(); area.clear(); resolve(null); return;
      }
      draw();
    });

    draw();
  });
}

export function multiSelect({ title, items }) {
  return new Promise((resolve) => {
    const area = new Area();
    let sel = 0;
    const checked = new Set();

    const draw = () => {
      const lines = [' ' + soft(title) + '  ' + dim('↑↓ · space toggle · enter confirm')];
      items.forEach((it, i) => {
        const marker = i === sel ? neon('▸ ') : '  ';
        const box = checked.has(i) ? neon('[■]') : dim('[ ]');
        const label = i === sel ? nb(it.label) : paint(it.label, C.green);
        lines.push('   ' + marker + box + ' ' + label + (it.desc ? '  ' + grey(it.desc) : ''));
      });
      area.render(lines, lines.length - 1, 0);
    };

    const off = onKeys((key) => {
      switch (key.name) {
        case 'up': sel = (sel - 1 + items.length) % items.length; break;
        case 'down': sel = (sel + 1) % items.length; break;
        case 'char':
          if (key.ch === ' ') checked.has(sel) ? checked.delete(sel) : checked.add(sel);
          break;
        case 'enter': {
          off(); area.clear();
          const picked = [...checked].map((i) => items[i]);
          stdout.write(' ' + soft(title) + ' ' + neon(picked.map((p) => p.label).join(', ') || '(none)') + '\n');
          resolve(picked);
          return;
        }
        case 'ctrl-c': off(); area.clear(); resolve(null); return;
      }
      draw();
    });

    draw();
  });
}
