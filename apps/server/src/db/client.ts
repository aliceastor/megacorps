import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.ts';

const connectionString = process.env.DATABASE_URL ?? 'postgresql://megacorps:megacorps_dev@localhost:5432/megacorps';
export const sql = postgres(connectionString, { max: 10 });
export const db = drizzle(sql, { schema });
