import { agentReportSchema } from '@megacorps/shared';

type SchemaLike = {
  _def?: Record<string, unknown>;
  isOptional?: () => boolean;
  unwrap?: () => SchemaLike;
  shape?: Record<string, SchemaLike>;
  element?: SchemaLike;
};

function pathText(path: readonly PropertyKey[]): string {
  if (path.length === 0) return '<report>';
  return path.map((part, index) => {
    if (typeof part === 'number') return `[${part}]`;
    const value = String(part);
    return /^[A-Za-z_$][\w$]*$/.test(value) ? `${index ? '.' : ''}${value}` : `[${JSON.stringify(value)}]`;
  }).join('');
}

function receivedType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function valueAtPath(value: unknown, path: readonly PropertyKey[]): unknown {
  let current = value;
  for (const part of path) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) return undefined;
    current = (current as Record<PropertyKey, unknown>)[part];
  }
  return current;
}

export function formatReportIssues(value: unknown, issues: readonly { path: PropertyKey[]; message: string }[], prefix = ''): string {
  const lead = prefix ? `${prefix}: ` : '';
  return `${lead}${issues.map((issue) => {
    const path = pathText(issue.path);
    return `${path}: ${issue.message}; received ${receivedType(valueAtPath(value, issue.path))}. Correct ${path} to satisfy the stated constraint.`;
  }).join(' ')}`.slice(0, 2000);
}

function schemaType(schema: SchemaLike): string | undefined {
  return schema._def?.type as string | undefined;
}

function unwrapContainers(schema: SchemaLike): SchemaLike {
  let current = schema;
  while (['optional', 'nullable', 'default', 'readonly', 'catch', 'nonoptional'].includes(schemaType(current) ?? '') && current.unwrap) current = current.unwrap();
  return current;
}

function unionChoice(schema: SchemaLike, value: Record<string, unknown>): SchemaLike | null {
  const options = schema._def?.options;
  if (!Array.isArray(options)) return null;
  for (const option of options as SchemaLike[]) {
    const candidate = unwrapContainers(option);
    if (schemaType(candidate) !== 'object' || !candidate.shape) continue;
    const discriminator = Object.entries(candidate.shape).find(([, field]) => schemaType(unwrapContainers(field)) === 'literal');
    if (!discriminator) continue;
    const [key, field] = discriminator;
    const values = unwrapContainers(field)._def?.values;
    if (value[key] !== undefined && Array.isArray(values) && values.includes(value[key])) return candidate;
  }
  return null;
}

function cloneWithSchema(value: unknown, schema: SchemaLike | undefined, path: PropertyKey[], corrections: string[]): unknown {
  if (Array.isArray(value)) {
    const unwrapped = schema ? unwrapContainers(schema) : undefined;
    const element = unwrapped && schemaType(unwrapped) === 'array' ? unwrapped.element : undefined;
    return value.map((item, index) => cloneWithSchema(item, element, [...path, index], corrections));
  }
  if (!value || typeof value !== 'object') return value;
  let unwrapped = schema ? unwrapContainers(schema) : undefined;
  if (unwrapped && schemaType(unwrapped) === 'union') unwrapped = unionChoice(unwrapped, value as Record<string, unknown>) ?? undefined;
  const shape = unwrapped && schemaType(unwrapped) === 'object' ? unwrapped.shape : undefined;
  const result: Record<string, unknown> = {};
  for (const [key, fieldValue] of Object.entries(value)) {
    const fieldSchema = shape?.[key];
    if (fieldValue === null && fieldSchema?.isOptional?.()) {
      corrections.push(`Omitted optional null field ${pathText([...path, key])}.`);
      continue;
    }
    Object.defineProperty(result, key, {
      value: cloneWithSchema(fieldValue, fieldSchema, [...path, key], corrections),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

export function normalizeOptionalReportFields(value: unknown): { data: unknown; corrections: string[] } {
  const corrections: string[] = [];
  return { data: cloneWithSchema(value, agentReportSchema as unknown as SchemaLike, [], corrections), corrections };
}
