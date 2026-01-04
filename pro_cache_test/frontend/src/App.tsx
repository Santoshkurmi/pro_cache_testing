import { useState, useEffect } from 'react';
import axios from 'axios';
import { createProCache, useLiveFetch, ProCacheClient } from 'pro_cache';

// Initialize Cache Global
// Use a mutable variable for token to allow dynamic updates via function-based URL
let currentToken = '';

const apiBase = 'http://localhost:3001/api';

const cache = createProCache({ 
    debug: true,
     db: {
        dbName: 'finance_pro_cache',
        dbVersion: 1
    }, 
    api: {
        baseUrl: apiBase,
        defaultCacheTtl: 600 // 5 Minutes Cache
        // axiosInstance: axios, //use axios instance if needed
    },
    ws: {
        // pro_cache supports function for URL to allow dynamic values
        url: () => `${WS_URL}?token=${currentToken}`,
        routeToCacheKey: (routePath: string) => {
            // Identity mapping for now. 
            // If backend sends specific keys, we might need a map here or ensure consistency.
            return routePath;
        },
        defaultBackgroundDelay: 1000, // Testing: 5 seconds max wait for background tabs
        backgroundPollInterval: 200   // Testing: Poll every 200ms
    }
});

const API_URL = 'http://localhost:3001/api';
const WS_URL = 'ws://127.0.0.1:8080/ws';

function App() {
  const [userId, setUserId] = useState(localStorage.getItem('userId'));
  const [token, setToken] = useState(localStorage.getItem('token'));
  const [projectId, setProjectId] = useState('');
  const [newTodo, setNewTodo] = useState('');

  // 1. Login Logic
  const performLogin = async (uid: string|null) => {
    try {
      const res = await axios.post(`${API_URL}/login`, { userId: uid });
      setToken(res.data.token);
      setProjectId(res.data.projectId);
      setUserId(uid);
      localStorage.setItem('userId', uid ??"");
      localStorage.setItem('token', res.data.token);
    } catch (err) {
      console.error(err);
      alert('Login failed');
      localStorage.removeItem('userId'); // Clear invalid ID if any
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    await performLogin(userId);
  };

  const handleLogout = () => {
    setUserId('');
    setToken('');
    setProjectId('');
    localStorage.removeItem('userId');
    localStorage.removeItem('token');
    // derived currentToken and socket cleanup happens in useEffect([token])
  };

  // Restore session
  useEffect(() => {
    if (!token && userId) {
        performLogin(userId);
    }
  }, []);

  useEffect(() => {
    if (token) {
        console.log("Updating WebSocket Token...");
        // Update the reference used by the URL function
        currentToken = token;

        // Update API token for pro_cache axios instance
        cache.api.defaults.headers.common['Authorization'] = `Bearer ${token}`; 
        
        // Reconnect so it picks up the new URL
        if (cache.socket) {
            cache.socket.disconnect();
            cache.connect();
        }
    }
  }, [token]);

  // 2. Data Fetching with useLiveFetch
  // Key: "todo.list"
  // Path: "/todos" (relative to baseURL default /api is set in client, but let's be explicit if needed)
  // BaseURL in client.ts defaults to '/api'. So fetching ''/todos' -> '/api/todos'.
  // 2. Data Fetching with useLiveFetch
  // Key: "todo.list"
  // Path: "/todos" (relative to baseURL default /api is set in client, but let's be explicit if needed)
  // BaseURL in client.ts defaults to '/api'. So fetching ''/todos' -> '/api/todos'.
  const { data: todos, loading, refetch } = useLiveFetch<any[]>(
    cache,
    '/todos', // Path (relative to /api)
    {},       // Params
    { 
        cacheKey: '/todo.list'
    }
  );

  // 3. Mutations
  const addTodo = async (e: React.FormEvent) => {
    e.preventDefault();
    
    await axios.post(`${API_URL}/todos`, { title: newTodo });
    setNewTodo('');
    refetch(); // Manual update
  };

  const toggleTodo = async (id: number, completed: boolean) => {
    await axios.put(`${API_URL}/todos/${id}`, { completed: !completed });
    refetch(); // Manual update
  };

  const deleteTodo = async (id: number) => {
    await axios.delete(`${API_URL}/todos/${id}`);
    refetch(); // Manual update
  };

  if (!token) {
    return (
      <div style={{ padding: 20 }}>
        <h2>Login</h2>
        <form onSubmit={handleLogin}>
          <input 
            value={userId ??""} 
            onChange={e => setUserId(e.target.value)} 
            placeholder="User ID" 
            required
          />
          <button type="submit">Enter</button>
        </form>
      </div>
    );
  }

  return (
    <div style={{ padding: 20 }}>
      {/* Header with Logout */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h1>Todo App ({userId})</h1>
          <button onClick={handleLogout} style={{ height: 'fit-content' }}>Logout</button>
      </div>
      <p>Project: {projectId}</p>

      <div style={{ marginBottom: 20 }}>
        <form onSubmit={addTodo}>
          <input 
            value={newTodo}
            onChange={e => setNewTodo(e.target.value)}
            placeholder="New Todo"
          />
          <button type="submit">Add</button>
        </form>
      </div>

      {loading && <p>Loading...</p>}
      
      <ul>
        {(todos || []).map((todo: any) => (
          <li key={todo.id} style={{ marginBottom: 5 }}>
            <span 
              style={{ 
                  textDecoration: todo.completed ? 'line-through' : 'none',
                  cursor: 'pointer',
                  marginRight: 10
              }}
              onClick={() => toggleTodo(todo.id, todo.completed)}
            >
              {todo.title}
            </span>
            <button onClick={() => deleteTodo(todo.id)}>x</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;
