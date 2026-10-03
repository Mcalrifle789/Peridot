# ◈ Peridot

**Local AI agent runtime in a full-screen terminal GUI.** Matrix/peridot green (`#80FF00`) on pitch black, with a glowing infinity-loop identity — built to match the reference design in `Peridot.png`. The title is set in the **Neuton** serif font (`assets/Neuton-Regular.ttf`), pre-rendered to terminal half-block art by `scripts/gen-wordmark.py`.

The app owns the whole terminal (alternate screen buffer): fixed header bar (agent · session · mode), scrollback viewport (PgUp/PgDn), pinned input line, status row, and a model/token footer bar.

## Install

```powershell
cd "C:\Users\hextu\OneDrive\Documents\Terminal GUIs\Peridot"
npm install
npm link        # puts `peridot` on your PATH
```

## Commands

| Command | What it does |
|---|---|
| `peridot setup` | Configuration wizard — username/password, AI model providers (OpenRouter / OpenCode / Kilo / Custom; **at least one API key is required**), search provider (DuckDuckGo, Gemini, Perplexity, Parallel, Parallel Free, Firecrawl, Brave, Custom), optional ElevenLabs + Deepgram keys |
| `peridot` | Launches the main runtime (intentional 3-second boot sequence) |
| `peridot status` | Quick status report *(maintenance)* |
| `peridot config` | Print loaded config, keys redacted *(maintenance)* |
| `peridot doctor` | Environment diagnostics *(maintenance)* |

## Inside the runtime

- Type anything at `>> Ask Peridot anything...` to chat with the configured model (streamed).
- Type `/` to open the scrollable dropdown of all **61 skills/commands** — filter by typing, navigate with `↑`/`↓`, select with `Enter` or `Tab`, close with `Esc`. `PgUp`/`PgDn` scrolls the conversation.
- **Plan mode** (`/mode plan`) — architecture and step-by-step reasoning, no file changes. Shown as a `PLAN` chip in the header.
- **Build mode** (`/mode build`) — writes code, runs commands, executes scripts. Shown as a `BUILD` chip in the header.
- **`/agent`** — arrow-key picker to switch between agents or create a new one (name, description, persona/system prompt). Each agent keeps its own sessions.
- **`/sessions`** — switch between the current agent's sessions.
- **`/new [name]`** — create a fresh session for the current agent (auto-names `session-N` if you skip the name).
- The **8 audio/music commands** (`/speak`, `/voice`, `/listen`, `/transcribe`, `/music`, `/ambient`, `/stream`, `/sound`) stay locked until both ElevenLabs and Deepgram keys are configured in `peridot setup`.

### Command categories (61 total)

- **system** (17): help, clear, exit, mode, model, models, session, sessions, new, history, status, config, setup, tokens, theme, version, doctor
- **filesystem** (10): ls, read, write, edit, mkdir, rm, mv, cp, find, tree
- **web** (5): search, fetch, scrape, news, docs
- **code** (10): run, exec, sh, py, node, test, build, lint, debug, git
- **memory** (5): remember, recall, forget, memories, note
- **agent** (6): plan, act, task, tasks, agent, workflow
- **audio** (8): speak, voice, listen, transcribe, music, ambient, stream, sound

## Architecture

```
bin/peridot.js       entry point + maintenance commands
src/theme.js         ANSI 24-bit peridot palette, gradients
src/logo.js          infinity loop + Neuton wordmark (block-art fallback)
src/wordmark.js      generated Neuton half-block art (scripts/gen-wordmark.py)
src/config.js        ~/.peridot/peridot.yaml, memory
src/agents.js        agent registry + per-agent session storage
src/commands.js      the 61 skills/commands registry
src/screen.js        full-screen engine: alt buffer, chrome, viewport, overlays
src/ui.js            raw-mode key parsing, wizard controls (setup)
src/input.js         line editor, slash menu, overlay select, prompt line
src/boot.js          3s boot sequence, landing screen, local gateway
src/agent.js         command dispatch + streaming chat
src/setup.js         4-step configuration wizard (provider key required)
src/main.js          runtime loop
```

- **Local gateway**: a real HTTP endpoint on `http://127.0.0.1:18789` reporting runtime state as JSON.
- **Config**: `~/.peridot/peridot.yaml` — passwords stored as SHA-256 hashes, never plaintext.
- **Providers**: any OpenAI-compatible chat-completions endpoint; OpenRouter recommended for `anthropic/*` models. The request model id lives in `model.id` (default `anthropic/claude-sonnet-4.5`) and is separate from the display name.
- **Token tracker**: approximate usage persisted per session, shown as `x/1M tokens` in the footer.
