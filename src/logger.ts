import { randomBytes } from 'node:crypto';
import pino, { type Logger } from 'pino';
import { createGcpLoggingPinoConfig } from '@google-cloud/pino-logging-gcp-config';
import { env } from './env.js';

const traceId = randomBytes(16).toString('hex');
const traceField = env.GOOGLE_CLOUD_PROJECT
  ? `projects/${env.GOOGLE_CLOUD_PROJECT}/traces/${traceId}`
  : traceId;

const base = pino(
  createGcpLoggingPinoConfig(
    {
      serviceContext: {
        service: 'licitaciones-sync',
        version: process.env.K_REVISION ?? 'local',
      },
    },
    { level: env.LOG_LEVEL },
  ),
);

export const logger: Logger = base.child({
  'logging.googleapis.com/trace': traceField,
  'logging.googleapis.com/labels': {
    job: process.env.CLOUD_RUN_JOB ?? 'local',
    execution: process.env.CLOUD_RUN_EXECUTION ?? '-',
    task_index: process.env.CLOUD_RUN_TASK_INDEX ?? '0',
  },
});

export type { Logger };
