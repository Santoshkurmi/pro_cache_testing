import { useState, useEffect } from 'react';
import axios from 'axios';
import { useLiveFetch, useProCacheStatus, useGlobalInvalidation, useToggleCaching, useProCache } from 'pro_cache';
import { TodoDetail } from './TodoDetail';
import { cache, setCacheToken } from './cache';

const API_URL = `http://${window.location.hostname}:3001/api`;

function App() {
  const { wsStatus, isOnline, recentActivity, isLeaderTab, isCacheEnabled, isDebugEnabled } = useProCacheStatus();
  const { toggle: toggleCache, isConfigEnabled } = useToggleCaching();
  const client = useProCache();
  
  // Keyboard shortcuts: Ctrl+K = toggle cache, Ctrl+Shift+D = toggle debug
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === 'k') {
        e.preventDefault();
        toggleCache();
      }
      if (e.ctrlKey && e.shiftKey && e.key === 'D') {
        e.preventDefault();
        const newDebug = !isDebugEnabled;
        client.config.debug = newDebug;
        client.socket.setDebug(newDebug);
        console.log(`[ProCache] Debug mode: ${newDebug ? 'ON' : 'OFF'}`);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [toggleCache, isDebugEnabled, client]);
  
  useGlobalInvalidation(() => {
    console.log('Global cache invalidation received! Refreshing all data...');
  });

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
    setCacheToken(''); // Reset token
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
        setCacheToken(token); // Update token reference

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
    const { data: todos, loading, refetch, isRefetching, isRefetchNeeded } = useLiveFetch<any[]>(
    '/todos', // Path (relative to /api)
    { 
      params:{},
      query:{},
        autoRefetch: true // Manually testing this behavior now
    }
  );

  // State for navigation
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // 3. Mutations
  const addTodo = async (e: React.FormEvent) => {
    e.preventDefault();
    
    await axios.post(`${API_URL}/todos`, { title: newTodo });
    setNewTodo('');
    refetch(); // Manual update
  };

  const toggleTodo = async (id: number, completed: boolean) => {
    await axios.put(`${API_URL}/todos/${id}`, { completed: !completed });
    // Note: This will trigger invalidation from backend -> socket -> client
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

  if (selectedId !== null) {
      return <TodoDetail id={selectedId} onBack={() => setSelectedId(null)} />;
  }

  // Render List
  return (
    <div style={{ padding: 20 }}>
      <h1>ProCache Todo List ({userId})</h1>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <button onClick={handleLogout} style={{ height: 'fit-content' }}>Logout</button>
      </div>
      <div style={{ padding: 5, fontSize: 12, marginBottom: 10, display: 'flex', gap: 10, alignItems: 'center' }}>
          {/* Status dot with activity ring animation */}
          <span style={{ position: 'relative', width: 10, height: 10 }}>
              {/* Expanding ring on activity */}
              {recentActivity && (
                  <span 
                      style={{ 
                          position: 'absolute',
                          top: '50%',
                          left: '50%',
                          transform: 'translate(-50%, -50%)',
                          width: 10, 
                          height: 10, 
                          borderRadius: '50%', 
                          border: '2px solid #22c55e',
                          animation: 'ping 1s cubic-bezier(0, 0, 0.2, 1) infinite',
                          opacity: 0.75
                      }} 
                  />
              )}
              {/* Main dot */}
              <span 
                  style={{ 
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: 10, 
                      height: 10, 
                      borderRadius: '50%', 
                      backgroundColor: 
                          wsStatus === 'connected' ? '#22c55e' :
                          wsStatus === 'connecting' ? '#f59e0b' :
                          wsStatus === 'error' ? '#ef4444' :
                          wsStatus === 'offline' ? '#6b7280' :
                          '#9ca3af',
                      boxShadow: recentActivity 
                          ? '0 0 12px #22c55e' 
                          : wsStatus === 'connected' ? '0 0 6px #22c55e' 
                          : wsStatus === 'connecting' ? '0 0 6px #f59e0b' 
                          : wsStatus === 'error' ? '0 0 6px #ef4444' 
                          : 'none',
                      transition: 'box-shadow 0.3s ease'
                  }} 
                  title={wsStatus}
              />
          </span>
          <span><b>{wsStatus}</b></span>
          <span>|</span>
          <span>Cache: <b style={{ color: isCacheEnabled ? '#22c55e' : '#f59e0b' }}>{isCacheEnabled ? 'ON' : 'OFF'}</b> {!isConfigEnabled && <small>(Global Lock)</small>}</span>
          <span>|</span>
          <span>Internet: <b>{isOnline ? 'YES' : 'NO'}</b></span>
          {isCacheEnabled && (
              <>
                  <span>|</span>
                  <span>Tab: <b>{isLeaderTab ? 'LEADER' : 'FOLLOWER'}</b></span>
              </>
          )}
          <span>|</span>
          <span>Debug: <b style={{ color: isDebugEnabled ? '#22c55e' : '#6b7280' }}>{isDebugEnabled ? 'ON' : 'OFF'}</b></span>
          <span style={{ marginLeft: 'auto', color: '#6b7280', fontSize: 10 }}>
              (Ctrl+K: Toggle Cache | Ctrl+Shift+D: Toggle Debug)
          </span>
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
      {isRefetching && <p style={{ color: 'blue' }}>Updating...</p>}
      {isRefetchNeeded && (
          <div style={{ background: 'yellow', padding: 10, marginBottom: 10 }}>
              <span>New data available! </span>
              <button onClick={() => refetch()}>Refresh Now</button>
          </div>
      )}
      
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
            <button onClick={() => setSelectedId(todo.id)} style={{ marginLeft: 5 }}>View</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default App;
