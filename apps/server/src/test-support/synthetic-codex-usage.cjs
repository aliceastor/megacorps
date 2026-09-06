// Synthetic JSON-RPC fixture. Never starts Codex or contacts a provider.
const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  send({ id: request.id, result: request.method.startsWith('thread/') ? { thread: { id: 'synthetic-thread' } } : request.method === 'turn/start' ? { turn: { id: 'synthetic-turn' } } : {} });
  if (request.method === 'turn/start') setTimeout(() => send({ method: 'turn/completed', params: { turn: { id: 'synthetic-turn', status: 'completed' } } }), 20);
});
