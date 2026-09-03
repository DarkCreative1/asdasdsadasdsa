import 'dotenv/config';

const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

const boundedNumber = (name, fallback, min, max) => Math.min(max, Math.max(min, number(name, fallback)));
const boundedInteger = (name, fallback, min, max) => Math.floor(boundedNumber(name, fallback, min, max));

const defaultCheckTarget = 'https://www.google.com/generate_204';
const configuredTargets = (process.env.CHECK_TARGETS || defaultCheckTarget)
  .split(',')
  .map((value) => value.trim())
  .filter((value) => {
    try {
      return ['http:', 'https:'].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  });

export const settings = {
  databasePath: process.env.DATABASE_PATH || './data/proxies.db',
  targetPoolSize: boundedInteger('TARGET_POOL_SIZE', 25, 1, 100000),
  fetchIntervalSeconds: boundedNumber('FETCH_INTERVAL_SECONDS', 300, 1, 86400),
  checkIntervalSeconds: boundedNumber('CHECK_INTERVAL_SECONDS', 10, 1, 3600),
  checkConcurrency: boundedInteger('CHECK_CONCURRENCY', 100, 1, 2000),
  checkPersistBatchSize: boundedInteger('CHECK_PERSIST_BATCH_SIZE', 1000, 100, 10000),
  sourceFetchConcurrency: boundedInteger('SOURCE_FETCH_CONCURRENCY', 6, 1, 100),
  checkTimeoutSeconds: boundedNumber('CHECK_TIMEOUT_SECONDS', 2, 0.1, 120),
  minSuccessRate: boundedNumber('MIN_SUCCESS_RATE', 1, 0, 1),
  // Recent-result history is stored as a SQLite integer bit window.
  minChecks: boundedInteger('MIN_CHECKS', 2, 1, 30),
  staleAfterSeconds: boundedNumber('STALE_AFTER_SECONDS', 60, 1, 86400),
  maxCandidatesPerCycle: boundedInteger('MAX_CANDIDATES_PER_CYCLE', 0, 0, 10000000),
  apiKey: process.env.API_KEY || '',
  checkTargets: configuredTargets.length ? configuredTargets : [defaultCheckTarget],
};
