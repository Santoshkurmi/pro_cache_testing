import { type ProCacheConfig, ProCacheClient } from './client';

export * from './db';
export * from './cache';
export * from './socket';
export * from './client';
export * from './reactive';

// Export React hooks specifically to avoid type collisions with reactive.ts
export { useLiveFetch } from './react';
export type { LiveFetchResult } from './react';

export const createProCache = (config: ProCacheConfig) => {
    return new ProCacheClient(config);
};
