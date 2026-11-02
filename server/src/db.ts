import pg from 'pg';

export const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgres://localhost:5432/cohort_tracker';

export const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 10 });

export type Db = pg.Pool | pg.PoolClient;

/** Run fn inside a transaction on a dedicated connection. */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
