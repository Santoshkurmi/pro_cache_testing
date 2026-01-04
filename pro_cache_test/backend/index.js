const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = 3001;
const INTERNAL_API = 'http://127.0.0.1:8081/internal'; // pro_cache_backend
const PROJECT_ID = 'test-project';

// Dummy Data
let todos = [
    { id: 1, title: 'Learn Rust', completed: false },
    { id: 2, title: 'Build Cache Server', completed: true },
];

let nextId = 3;

// Helper to trigger invalidation
async function invalidate(path, userId) {
    console.log(`[Backend] Invalidating: ${path}`);
    try {
        await fetch(`${INTERNAL_API}/invalidate`, {
            method: 'POST',
            body: JSON.stringify({
                project_id: PROJECT_ID,
                path: path,
                user_id: userId // Optional
            }),
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        console.error(`[Backend] Invalidation Failed: ${e.message}`);
    }
}

// Routes

// 1. Login (Mock)
app.post('/api/login', async (req, res) => {
    const { userId } = req.body;
    if (!userId) return res.status(400).send('userId required');

    const token = `token-${userId}-${Date.now()}`;
    
    // Register token with pro_cache_backend
    try {
        await fetch(`${INTERNAL_API}/auth/register`, {
            method: 'POST',
            body: JSON.stringify({
                token: token,
                user_id: userId,
                project_id: PROJECT_ID,
                ttl: 86400
            }),
            headers: { 'Content-Type': 'application/json' }
        });
        res.json({ token, projectId: PROJECT_ID });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 2. Get Todos
app.get('/api/todos', (req, res) => {
    res.json(todos);
});

// 3. Create Todo
app.post('/api/todos', async (req, res) => {
    const { title } = req.body;
    const newTodo = { id: nextId++, title, completed: false };
    todos.push(newTodo);
    
    // Invalidate list
    // User requested "use route name instead of route path"
    // pro_cache requires keys to start with / for auto-detection logic
    await invalidate('/todo.list'); 
    
    res.json(newTodo);
});

// 4. Update Todo
app.put('/api/todos/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    const { title, completed } = req.body;
    
    const todo = todos.find(t => t.id === id);
    if (!todo) return res.status(404).send('Not found');
    
    if (title !== undefined) todo.title = title;
    if (completed !== undefined) todo.completed = completed;
    
    // Invalidate list AND detail
    await invalidate('/todo.list');
    await invalidate(`/todo.detail.${id}`); // Example detail route name
    
    res.json(todo);
});

// 5. Delete Todo
app.delete('/api/todos/:id', async (req, res) => {
    const id = parseInt(req.params.id);
    todos = todos.filter(t => t.id !== id);
    
    await invalidate('/todo.list');
    
    res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Dummy Backend running on http://0.0.0.0:${PORT}`);
});
