// The 62 Peridot skills/commands. `args: true` means the command accepts arguments
// (menu selection fills the input instead of executing immediately);
// `optional: true` runs it straight from the menu — Tab still fills it for arguments.
// `audio: true` commands stay locked until ElevenLabs + Deepgram keys are configured.

const C = (name, desc, cat, opts = {}) => ({ name, desc, cat, ...opts });

export const COMMANDS = [
  // ── system (18)
  C('help', 'show command overview', 'system'),
  C('clear', 'clear the screen', 'system'),
  C('exit', 'shut down the runtime', 'system'),
  C('mode', 'switch plan | build mode', 'system', { args: true }),
  C('model', 'pick a model from every provider', 'system', { args: true, optional: true }),
  C('models', 'providers + model counts · refresh', 'system', { args: true, optional: true }),
  C('provider', 'add, replace or remove model providers', 'system', { args: true, optional: true }),
  C('session', 'show current session', 'system'),
  C('sessions', 'list saved sessions', 'system'),
  C('new', 'start a fresh session', 'system'),
  C('history', 'show conversation history', 'system'),
  C('status', 'runtime status report', 'system'),
  C('config', 'show loaded configuration', 'system'),
  C('setup', 'how to re-run the setup wizard', 'system'),
  C('tokens', 'token usage this session', 'system'),
  C('theme', 'change the GUI theme (live preview)', 'system', { args: true, optional: true }),
  C('version', 'runtime version', 'system'),
  C('doctor', 'run environment diagnostics', 'system'),

  // ── filesystem (10)
  C('ls', 'list directory contents', 'filesystem', { args: true }),
  C('read', 'read a file', 'filesystem', { args: true }),
  C('write', 'write text to a file', 'filesystem', { args: true }),
  C('edit', 'open a file in the system editor', 'filesystem', { args: true }),
  C('mkdir', 'create a directory', 'filesystem', { args: true }),
  C('rm', 'delete a file (confirmed)', 'filesystem', { args: true }),
  C('mv', 'move / rename a file', 'filesystem', { args: true }),
  C('cp', 'copy a file', 'filesystem', { args: true }),
  C('find', 'find files by pattern', 'filesystem', { args: true }),
  C('tree', 'directory tree view', 'filesystem', { args: true }),

  // ── web (5)
  C('search', 'web search via configured provider', 'web', { args: true }),
  C('fetch', 'fetch a URL', 'web', { args: true }),
  C('scrape', 'scrape readable text from a page', 'web', { args: true }),
  C('news', 'headlines for a topic', 'web', { args: true }),
  C('docs', 'search developer docs', 'web', { args: true }),

  // ── code (10)
  C('run', 'run a shell command', 'code', { args: true }),
  C('exec', 'execute a script file', 'code', { args: true }),
  C('sh', 'drop into a subshell', 'code'),
  C('py', 'run inline python', 'code', { args: true }),
  C('node', 'run inline javascript', 'code', { args: true }),
  C('test', 'run the project test suite', 'code'),
  C('build', 'run the project build', 'code'),
  C('lint', 'lint the current project', 'code'),
  C('debug', 'debug last command output', 'code'),
  C('git', 'run a git command', 'code', { args: true }),

  // ── memory (5)
  C('remember', 'store a fact in long-term memory', 'memory', { args: true }),
  C('recall', 'search long-term memory', 'memory', { args: true }),
  C('forget', 'delete a memory by number', 'memory', { args: true }),
  C('memories', 'list all stored memories', 'memory'),
  C('note', 'append to the session notepad', 'memory', { args: true }),

  // ── agent (6)
  C('plan', 'architect a task before building', 'agent', { args: true }),
  C('act', 'execute the current plan', 'agent'),
  C('task', 'add a task to the queue', 'agent', { args: true }),
  C('tasks', 'show the task queue', 'agent'),
  C('agent', 'agent runtime details', 'agent'),
  C('workflow', 'multi-step workflow builder', 'agent', { args: true }),

  // ── audio suite (8) — locked until ElevenLabs + Deepgram are configured
  C('speak', 'synthesize speech from text', 'audio', { args: true, audio: true }),
  C('voice', 'choose a synthesis voice', 'audio', { args: true, audio: true }),
  C('listen', 'live microphone transcription', 'audio', { audio: true }),
  C('transcribe', 'transcribe an audio file', 'audio', { args: true, audio: true }),
  C('music', 'generate a music clip', 'audio', { args: true, audio: true }),
  C('ambient', 'generate ambient soundscape', 'audio', { args: true, audio: true }),
  C('stream', 'real-time audio streaming session', 'audio', { audio: true }),
  C('sound', 'sound effect generation', 'audio', { args: true, audio: true }),
];

if (COMMANDS.length !== 62) {
  throw new Error(`Peridot expects exactly 62 commands, found ${COMMANDS.length}`);
}

export const findCommand = (name) => COMMANDS.find((c) => c.name === name);
