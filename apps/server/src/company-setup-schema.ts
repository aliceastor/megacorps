import { z } from 'zod';
const text = z.string().trim().min(1).max(200);
const slug = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const startInput = z.object({
  setupKey: z.string().uuid(),
  name: text,
  slug,
  mission: z.string().max(10000).optional(),
});
export const stepInput = z.discriminatedUnion('step', [
  z.object({ step: z.literal('company'), name: text, slug, mission: z.string().max(10000).optional() }),
  z.object({
    step: z.literal('boss'),
    name: text,
    slug,
    agentId: z.string().uuid().optional(),
    prompt: z.string().max(8000).optional(),
  }),
  z.object({
    step: z.literal('department'),
    name: text,
    slug,
    description: z.string().max(10000).optional(),
  }),
  z.object({
    step: z.literal('head'),
    name: text,
    slug,
    agentId: z.string().uuid().optional(),
    prompt: z.string().max(8000).optional(),
  }),
  z.object({
    step: z.literal('runtime'),
    runtimeId: z.string().uuid().optional(),
    runtimeCreateKey: z.string().uuid().optional(),
    name: text.optional(),
    a2aBaseUrl: z.string().url().optional(),
  }),
  z.object({ step: z.literal('finish') }),
  z.object({ step: z.literal('reopen') }),
]);
