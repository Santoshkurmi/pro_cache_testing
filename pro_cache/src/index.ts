import { type ProCacheConfig, ProCacheClient } from './client';
// entry point

export * from './db';
export * from './cache';
export * from './socket';
export * from './client';
export * from './reactive';

// Export React hooks specifically to avoid type collisions with reactive.ts
export { useLiveFetch, useProCache, ProCacheProvider, useProCacheStatus, useGlobalInvalidation } from './react';
export type { LiveFetchResult, LiveFetchOptions, ProCacheStatus } from './react';

export const createProCache = (config: ProCacheConfig) => {
    return new ProCacheClient(config);
};
