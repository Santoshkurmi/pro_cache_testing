# ProCache

A powerful offline-first caching and real-time synchronization library for modern web applications.

## Features

-   **Live Updates**: Automatically updates UI when data changes (via WebSocket).
-   **Tab Synchronization**: Syncs cache across multiple tabs using BroadcastChannel.
-   **Offline Support**: Persists data to IndexedDB.
-   **Smart Refetching**: Prioritizes active tabs; background tabs poll for changes.
-   **Framework Agnostic Core**: Logic is separated from UI bindings.

## Installation

```bash
npm install pro_cache
```

## Usage with SolidJS

```typescript
import { createLiveFetch } from 'pro_cache';

const [data, { refetch }] = createLiveFetch(client, '/api/users');
```

## Usage with React

```typescript
import { useLiveFetch } from 'pro_cache';

const { data, loading, error } = useLiveFetch(client, '/api/users');
```
