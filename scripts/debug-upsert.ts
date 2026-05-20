/**
 * Diagnostic: download the latest 1 .atom, parse it, upsert each entry one by one,
 * and dump the FULL error object for any failure.
 *
 * Usage:
 *   DATABASE_URL=... npx tsx scripts/debug-upsert.ts
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetch } from 'undici';
import { createDb, tenders } from '../src/db.js';
import {
  discoverPeriods,
  mapEntry,
  parseAtom,
  streamAtoms,
  type Tender,
} from '../src/placsp.js';
import { upsertTenders } from '../src/db.js';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://postgres:postgres@localhost:5432/licitaciones';

async function main() {
  const periods = discoverPeriods({});
  const current = periods.find((p) => p.isCurrent)!;
  const zipPath = './tmp/debug.zip';
  await mkdir('./tmp', { recursive: true });

  console.log('downloading', current.url);
  const resp = await fetch(current.url);
  if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
  await pipeline(resp.body as unknown as Readable, createWriteStream(zipPath));
  console.log('downloaded');

  const { db, close } = createDb(DATABASE_URL);
  await db.delete(tenders);

  let processed = 0;
  let failed = 0;
  let buffer: Tender[] = [];
  const BATCH = 500;
  outer: for await (const { name, stream } of streamAtoms(zipPath)) {
    console.log('atom:', name);
    for await (const ev of parseAtom(stream)) {
      if (ev.type !== 'entry') continue;
      const t: Tender = mapEntry(ev.raw);
      buffer.push(t);
      if (buffer.length >= BATCH) {
        try {
          await upsertTenders(db, buffer);
          processed += buffer.length;
          console.log('batch ok, processed=', processed);
          buffer = [];
        } catch (err: any) {
          console.error('\n=== BATCH FAILED ===');
          console.error('batch size:', buffer.length);
          console.error('error.name:', err.name);
          console.error('error.message (first line):', String(err.message).split('\n')[0].slice(0, 300));
          console.error('error.cause type:', typeof err.cause, err.cause?.constructor?.name);
          if (err.cause) {
            const c = err.cause;
            console.error('cause.name:', c.name);
            console.error('cause.message:', c.message);
            console.error('cause.code:', c.code);
            console.error('cause.column:', c.column);
            console.error('cause.detail:', c.detail);
            console.error('cause.severity:', c.severity);
            console.error('cause.position:', c.position);
            console.error('cause.routine:', c.routine);
            console.error('cause keys:', Object.keys(c));
          }
          // Try halving the batch
          const half1 = buffer.slice(0, buffer.length / 2);
          const half2 = buffer.slice(buffer.length / 2);
          try { await upsertTenders(db, half1); console.log('half1 OK', half1.length); }
          catch (e: any) { console.log('half1 FAIL:', e.cause?.message ?? e.message.split('\n')[0]); }
          try { await upsertTenders(db, half2); console.log('half2 OK', half2.length); }
          catch (e: any) { console.log('half2 FAIL:', e.cause?.message ?? e.message.split('\n')[0]); }
          failed += buffer.length;
          buffer = [];
          break outer;
        }
      }
      if (processed + failed + buffer.length >= 5000) break outer;
    }
  }

  console.log('\nDone. processed:', processed, 'failed:', failed);
  await close();
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
