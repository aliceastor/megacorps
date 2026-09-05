import { eq } from 'drizzle-orm';
import { db } from './db/client.ts';
import { agents, agentRuntimes, projects } from './db/schema.ts';
import { redactPromptForLog } from './prompt-logs.ts';

const secretKey = /(?:token|secret|password|api[_-]?key|authorization|private[_-]?key)/i;
function collect(value: unknown, result: string[]): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (secretKey.test(key) && typeof nested === 'string' && nested && nested !== '[redacted]') result.push(nested);
    else if (nested && typeof nested === 'object') collect(nested, result);
  }
}

/** One invocation snapshot; never cached across credential edits or company boundaries. */
export async function companyOutputSanitizer(companyId: string) {
  const [companyAgents, runtimes, companyProjects] = await Promise.all([
    db.select().from(agents).where(eq(agents.companyId, companyId)),
    db.select().from(agentRuntimes).where(eq(agentRuntimes.companyId, companyId)),
    db.select().from(projects).where(eq(projects.companyId, companyId)),
  ]);
  const secrets: string[] = [];
  for (const row of [...companyAgents, ...runtimes, ...companyProjects]) collect(row, secrets);
  for (const [key, value] of Object.entries(process.env)) if (secretKey.test(key) && value) secrets.push(value);
  function sanitize<T>(value: T): T {
    if (typeof value === 'string') return redactPromptForLog(value, secrets) as T;
    if (Array.isArray(value)) return value.map(sanitize) as T;
    if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, secretKey.test(key) && typeof nested === 'string' && nested ? '[redacted]' : sanitize(nested)])) as T;
    return value;
  }
  return Object.assign(sanitize, { partial(value: string) {
    // A credential split across adapter chunks must not leak its first half.
    for (const secret of secrets) for (const variant of [secret, encodeURIComponent(secret)]) {
      for (let length = Math.min(value.length, variant.length - 1); length > 0; length--) {
        if (value.endsWith(variant.slice(0, length))) { value = value.slice(0, -length); break; }
      }
    }
    // Incomplete URL credentials and headers are only safe after their line ends.
    const lastLine = value.lastIndexOf('\n');
    return sanitize(lastLine < 0 ? '' : value.slice(0, lastLine + 1));
  } });
}

export async function sanitizeCompanyOutput<T>(companyId: string, value: T): Promise<T> {
  return (await companyOutputSanitizer(companyId))(value);
}
