// Screen-based input: the main line editor with slash-command menu,
// plus overlay select and one-off prompt lines for in-app flows.
import { onKeys } from './ui.js';

export function readInput(screen, { commands, audioOn, placeholder = 'Ask Peridot anything...' }) {
  return new Promise((resolve) => {
    screen.input = { buf: '', pos: 0, placeholder, prompt: '>>' };
    let sel = 0;

    const filtered = () => {
      const buf = screen.input.buf;
      if (!buf.startsWith('/') || buf.includes(' ')) return null;
      const q = buf.slice(1).toLowerCase();
      const pre = commands.filter((c) => c.name.startsWith(q));
      const rest = commands.filter((c) => !c.name.startsWith(q) && (c.name.includes(q) || c.cat.startsWith(q)));
      const list = [...pre, ...rest];
      return list.length ? list : null;
    };

    const sync = () => {
      const list = filtered();
      if (list) {
        if (sel >= list.length) sel = list.length - 1;
        screen.menu = {
          title: `commands ${list.length}/${commands.length}`,
          items: list.map((c) => ({
            left: '/' + c.name,
            right: c.audio && !audioOn ? c.desc + '  (locked · audio keys required)' : c.desc,
            dim: c.audio && !audioOn,
            cmd: c,
          })),
          sel,
        };
      } else {
        screen.menu = null;
      }
      screen.render();
    };

    const done = (value) => {
      off();
      screen.menu = null;
      screen.input = { buf: '', pos: 0, placeholder, prompt: '>>' };
      resolve(value);
    };

    const off = onKeys((key) => {
      const inp = screen.input;
      const list = filtered();
      switch (key.name) {
        case 'char':
          inp.buf = inp.buf.slice(0, inp.pos) + key.ch + inp.buf.slice(inp.pos);
          inp.pos++;
          sel = 0;
          break;
        case 'backspace':
          if (inp.pos > 0) { inp.buf = inp.buf.slice(0, inp.pos - 1) + inp.buf.slice(inp.pos); inp.pos--; }
          break;
        case 'delete': inp.buf = inp.buf.slice(0, inp.pos) + inp.buf.slice(inp.pos + 1); break;
        case 'left': if (inp.pos > 0) inp.pos--; break;
        case 'right': if (inp.pos < inp.buf.length) inp.pos++; break;
        case 'home': inp.pos = 0; break;
        case 'end': inp.pos = inp.buf.length; break;
        case 'up': if (list) sel = Math.max(sel - 1, 0); break;
        case 'down': if (list) sel = Math.min(sel + 1, list.length - 1); break;
        case 'pageup': screen.scrollBy(screen.contentHeight() - 1); return;
        case 'pagedown': screen.scrollBy(-(screen.contentHeight() - 1)); return;
        case 'tab':
          if (list) { const c = list[sel]; inp.buf = '/' + c.name + (c.args ? ' ' : ''); inp.pos = inp.buf.length; }
          break;
        case 'escape':
          inp.buf = ''; inp.pos = 0; sel = 0;
          break;
        case 'enter': {
          if (list) {
            const c = list[sel];
            if (c.args && !c.optional && inp.buf !== '/' + c.name) {
              inp.buf = '/' + c.name + ' ';
              inp.pos = inp.buf.length;
              break;
            }
            done('/' + c.name);
            return;
          }
          const out = inp.buf.trim();
          if (!out) break;
          done(out);
          return;
        }
        case 'ctrl-c': case 'ctrl-d':
          done('/exit');
          return;
      }
      sync();
    });

    sync();
  });
}

// Arrow-key list picker rendered as the overlay menu. Resolves the picked item or null on esc.
// items: [{ label, desc?, dim?, swatch? }]
// filter:  typing narrows the list (every typed word must appear in label or desc)
// initial: index of the item selected first
// onMove:  called with the highlighted item whenever it changes (live previews)
export function overlaySelect(screen, { title, items, filter = false, initial = 0, query = '', onMove }) {
  return new Promise((resolve) => {
    let sel = Math.min(Math.max(initial, 0), Math.max(items.length - 1, 0));
    let q = filter ? query : '';
    let lastMoved;
    const prevInput = screen.input;
    const hint = filter ? 'type to filter · ↑↓ · enter to select · esc to cancel' : '↑↓ to choose · enter to select · esc to cancel';
    screen.input = { buf: q, pos: q.length, placeholder: hint, prompt: '»' };

    const matches = (it) => {
      const hay = `${it.label} ${it.desc || ''}`.toLowerCase();
      return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
    };
    let list = items.filter(matches);

    const sync = () => {
      if (sel >= list.length) sel = Math.max(list.length - 1, 0);
      screen.input.buf = q;
      screen.input.pos = q.length;
      screen.menu = {
        title: filter ? `${title}  ${list.length}/${items.length}` : title,
        items: list.length
          ? list.map((it) => ({ left: it.label, right: it.desc || '', dim: it.dim, swatch: it.swatch }))
          : [{ left: '(no matches)', right: 'backspace to widen the search', dim: true }],
        sel,
      };
      if (onMove && list[sel] !== lastMoved) { lastMoved = list[sel]; if (lastMoved) onMove(lastMoved); }
      screen.render();
    };

    const done = (value) => {
      off();
      screen.menu = null;
      screen.input = prevInput;
      screen.render();
      resolve(value);
    };

    const refilter = () => { list = items.filter(matches); sel = 0; };

    const off = onKeys((key) => {
      switch (key.name) {
        case 'up': if (list.length) sel = (sel - 1 + list.length) % list.length; break;
        case 'down': if (list.length) sel = (sel + 1) % list.length; break;
        case 'pageup': sel = Math.max(sel - 10, 0); break;
        case 'pagedown': sel = Math.min(sel + 10, Math.max(list.length - 1, 0)); break;
        case 'char': if (filter) { q += key.ch; refilter(); } break;
        case 'backspace': if (filter && q) { q = q.slice(0, -1); refilter(); } break;
        case 'enter': if (list.length) { done(list[sel]); return; } break;
        case 'escape': case 'ctrl-c': done(null); return;
      }
      sync();
    });

    sync();
  });
}

// Single-line prompt inside the app (agent names, API keys, confirmations, ...).
// Resolves the entered string, or null on esc/ctrl-c. `mask` hides the input.
export function promptLine(screen, { label, allowEmpty = false, mask = false }) {
  return new Promise((resolve) => {
    const prevInput = screen.input;
    screen.input = { buf: '', pos: 0, placeholder: label, prompt: ' ▸', mask };
    screen.render();

    const done = (value) => {
      off();
      screen.input = prevInput;
      screen.render();
      resolve(value);
    };

    const off = onKeys((key) => {
      const inp = screen.input;
      switch (key.name) {
        case 'char': inp.buf = inp.buf.slice(0, inp.pos) + key.ch + inp.buf.slice(inp.pos); inp.pos++; break;
        case 'backspace': if (inp.pos > 0) { inp.buf = inp.buf.slice(0, inp.pos - 1) + inp.buf.slice(inp.pos); inp.pos--; } break;
        case 'delete': inp.buf = inp.buf.slice(0, inp.pos) + inp.buf.slice(inp.pos + 1); break;
        case 'left': if (inp.pos > 0) inp.pos--; break;
        case 'right': if (inp.pos < inp.buf.length) inp.pos++; break;
        case 'home': inp.pos = 0; break;
        case 'end': inp.pos = inp.buf.length; break;
        case 'enter': {
          const out = inp.buf.trim();
          if (!out && !allowEmpty) break;
          done(out);
          return;
        }
        case 'escape': case 'ctrl-c': done(null); return;
      }
      screen.render();
    });
  });
}
