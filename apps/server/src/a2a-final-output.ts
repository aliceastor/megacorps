const AMBIGUOUS_OUTPUT = 'a2a_final_output_ambiguous: CLI output did not contain an identifiable terminal answer.';
const CHAT_KIND = 'megacorps-chat-response';

/** Transport-only framing; the body still uses the existing chat-actions protocol. */
export function wrapA2aPrompt(prompt: string, kind?: string): string {
  if (kind !== 'chat') return prompt;
  return `${prompt}\n\nA2A final-response framing: Return your final display answer as exactly one terminal JSON object on a single line, with only these fields: {"kind":"${CHAT_KIND}","body":"your complete answer"}. JSON-escape newlines and quotes in body. Include any chat-actions fence required above unchanged inside body. Put no text after this object.`;
}

function decodeChatEnvelope(candidate: string): string {
  if (!candidate.trimStart().startsWith('{') || !/"kind"\s*:\s*"megacorps-chat-response"/.test(candidate)) return candidate;
  try {
    const value = JSON.parse(candidate);
    if (value.kind !== CHAT_KIND) return candidate;
    if (value.kind === CHAT_KIND && typeof value.body === 'string'
      && Object.keys(value).length === 2) return value.body;
  } catch { /* Never reveal a malformed envelope's surrounding transcript. */ }
  return AMBIGUOUS_OUTPUT;
}

// Do not let the downstream report extractor select an earlier root from a
// purported final answer. Syntax/schema errors in one root still belong to the
// normal correction path; only trailing material makes its boundary ambiguous.
function projectStandaloneCandidate(candidate: string): string {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        if (candidate.slice(index + 1).trim()) return AMBIGUOUS_OUTPUT;
        break;
      }
    }
  }
  return decodeChatEnvelope(candidate);
}

// Hermes appends this exact verifier diagnostic after the assistant answer.
// Recognize only the observed write-safe-root denial format, including its file
// count and repeated path. Other footers remain part of the ambiguous output.
function withoutKnownVerifierFooter(text: string): string {
  const tail = text.slice(-16_384);
  const marker = '⚠️ File-mutation verifier: ';
  const offset = tail.lastIndexOf(marker);
  if (offset < 0) return text;
  const start = text.length - tail.length + offset;
  if (!/(?:\r?\n){2}$/.test(text.slice(0, start))) return text;
  const lines = text.slice(start).split(/\r?\n/);
  const header = /^⚠️ File-mutation verifier: ([1-9]\d*) file\(s\) were NOT modified this turn despite any wording above that may suggest otherwise\. Run `git status` or `read_file` to confirm\.$/.exec(lines[0]!);
  if (!header || Number(header[1]) !== lines.length - 1) return text;
  for (const line of lines.slice(1)) {
    const denial = /^  • `([^`\r\n]+)` — \[write_file\] Write denied: '`([^`\r\n]+)`' is outside HERMES_WRITE_SAFE_ROOT \(([^()\r\n]+)\)\. Unset the variable or add this path's directory prefix\.$/.exec(line);
    if (!denial || denial[1] !== denial[2]) return text;
  }
  return text.slice(0, start).trimEnd();
}

/** Project recognizable CLI output before report parsing or Direct Chat rendering.
 * Hermes currently prints an open Reasoning banner without a final delimiter.
 * Only an explicit terminal report or chat envelope is recoverable in that format;
 * arbitrary prose has no safe boundary and must not expose the transcript.
 */
export function projectFinalText(text: string): string {
  if (!/^(?:⚠️?[^\r\n]*\r?\n)*(?:\r?\n)*┌─ Reasoning ─+┐(?:\r?\n|$)/.test(text)) return decodeChatEnvelope(text);
  const end = withoutKnownVerifierFooter(text.trimEnd());
  // Bound final-answer work independently of an arbitrarily large tool log.
  const tail = end.slice(-262_144);
  // Never reinterpret a chopped first line as a new standalone payload.
  const suffix = end.length > 262_144 ? tail.slice(tail.indexOf('\n') >= 0 ? tail.indexOf('\n') + 1 : tail.length) : tail;
  const lastLine = suffix.slice(suffix.lastIndexOf('\n') + 1).trim();
  const hasAnswerMarker = (body: string) => body.includes('megacorps-report') || body.includes(CHAT_KIND);
  if (lastLine.startsWith('{') && hasAnswerMarker(lastLine)) return projectStandaloneCandidate(lastLine);
  if (lastLine === '```') {
    const lines = suffix.split(/\r?\n/);
    for (let index = lines.length - 2; index >= 0; index -= 1) {
      if (!/^\s*```/.test(lines[index]!)) continue;
      if (!/^\s*```(?:json)?\s*$/i.test(lines[index]!)) break;
      const body = lines.slice(index + 1, -1).join('\n').trim();
      if (body.startsWith('{') && hasAnswerMarker(body)) return projectStandaloneCandidate(body);
      break;
    }
  }
  return AMBIGUOUS_OUTPUT;
}
