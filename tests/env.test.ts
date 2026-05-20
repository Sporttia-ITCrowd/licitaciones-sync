import { describe, expect, it } from 'vitest';
import { loadEnv } from '../src/env.js';

describe('loadEnv', () => {
  it('throws when DATABASE_URL is missing', () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow();
  });

  it('applies defaults for optional vars', () => {
    const e = loadEnv({ DATABASE_URL: 'postgres://x/y' } as NodeJS.ProcessEnv);
    expect(e.BATCH_SIZE).toBe(500);
    expect(e.LOG_LEVEL).toBe('info');
    expect(e.TMP_DIR).toBe('./tmp/placsp');
    expect(e.LOCK_HEARTBEAT_INTERVAL_MS).toBe(60_000);
    expect(e.LOCK_STALE_AFTER_MS).toBe(30 * 60_000);
  });

  it('coerces numeric env values from strings', () => {
    const e = loadEnv({
      DATABASE_URL: 'postgres://x/y',
      BATCH_SIZE: '250',
      LOCK_HEARTBEAT_INTERVAL_MS: '10000',
    } as NodeJS.ProcessEnv);
    expect(e.BATCH_SIZE).toBe(250);
    expect(e.LOCK_HEARTBEAT_INTERVAL_MS).toBe(10_000);
  });

  it('parses RUN_MIGRATIONS as boolean', () => {
    const yes = loadEnv({
      DATABASE_URL: 'postgres://x/y',
      RUN_MIGRATIONS: 'true',
    } as NodeJS.ProcessEnv);
    expect(yes.RUN_MIGRATIONS).toBe(true);

    const no = loadEnv({
      DATABASE_URL: 'postgres://x/y',
      RUN_MIGRATIONS: 'false',
    } as NodeJS.ProcessEnv);
    expect(no.RUN_MIGRATIONS).toBe(false);
  });

  it('rejects invalid LOG_LEVEL', () => {
    expect(() =>
      loadEnv({ DATABASE_URL: 'x', LOG_LEVEL: 'shouty' } as NodeJS.ProcessEnv),
    ).toThrow();
  });
});
