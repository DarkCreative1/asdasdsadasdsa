import 'dotenv/config';

const number = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
};

export const settings = {
  databasePath: process.env.DATABASE_PATH || './data/proxies.db',
  targetPoolSize: number('TARGET_POOL_SIZE', 25),
  fetchIntervalSeconds: number('FETCH_INTERVAL_SECONDS', 300),
  checkIntervalSeconds: number('CHECK_INTERVAL_SECONDS', 10),
  checkConcurrency: Math.max(1, Math.floor(number('CHECK_CONCURRENCY', 100))),
  sourceFetchConcurrency: Math.max(1, Math.floor(number('SOURCE_FETCH_CONCURRENCY', 6))),
  checkTimeoutSeconds: number('CHECK_TIMEOUT_SECONDS', 2),
  minSuccessRate: number('MIN_SUCCESS_RATE', 1),
  minChecks: Math.max(1, Math.floor(number('MIN_CHECKS', 2))),
  staleAfterSeconds: number('STALE_AFTER_SECONDS', 60),
  maxCandidatesPerCycle: Math.max(0, Math.floor(number('MAX_CANDIDATES_PER_CYCLE', 0))),
  apiKey: process.env.API_KEY || '',
  checkTargets: (process.env.CHECK_TARGETS || 'https://www.google.com/generate_204')
    .split(',').map((value) => value.trim()).filter(Boolean),
};
