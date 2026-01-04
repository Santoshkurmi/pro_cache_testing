import { createProCache } from './index';

// Example setup
const cache = createProCache({
    ws: {
        url: 'ws://localhost:3000/api/ws',
        channelName: 'my-app-sync',
        routeToCacheKey: (route) => {
            if (route === '/users') return 'users.list';
            return route;
        }
    },
    api: {
        baseUrl: '/api/v1',
        defaultCacheTtl: 60 // 1 minute
    },
    debug: true
});

// Example connection
cache.connect().then(() => {
    console.log('Connected');
});

// Example usage
async function loadUsers() {
    try {
        // Simple string route
        const users = await cache.fetch<any[]>('/users');
        console.log('Users:', users);

        // Object route with TTL override
        const roles = await cache.fetch<any[]>({ path: '/roles', cache_ttl: 300 });
        console.log('Roles:', roles);
        
        const isOnline = cache.socket.isOnline();
        console.log('Is Online:', isOnline);
        
    } catch (e) {
        console.error(e);
    }
}

// Example Reactive Usage (SolidJS Component)
import { createLiveFetch } from './index';
import { createSignal } from 'solid-js';

function MyComponent() {
    // 1. Basic usage - matches the cache key for '/users'
    const [users] = createLiveFetch<any[]>(cache, '/users');
    // Usage: users() returns the data or undefined
    // console.log(users());

    // 2. Usage with reactive parameters
    const [userId, setUserId] = createSignal(1);
    
    // Auto-refetches when userId changes OR when socket sends update for /users/1
    const [user] = createLiveFetch<any>(
        cache, 
        '/users/{id}', 
        () => ({ id: userId() })
    );
    
    // 3. Usage with full route definition
    const [roles] = createLiveFetch<any[]>(
        cache,
        { path: '/roles', cache_ttl: 300 }
    );
}
