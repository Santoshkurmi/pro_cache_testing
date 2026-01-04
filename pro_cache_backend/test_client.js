const WebSocket = require('ws');
const fetch = require('node-fetch');

const INTERNAL_API = "http://127.0.0.1:8081/internal";
const WS_URL = "ws://127.0.0.1:8080/ws";

const TOKEN = "test-token-123";
const USER_ID = "user-1";
const PROJECT_ID = "project-A";

async function registerToken() {
    console.log(`[Client] Registering token: ${TOKEN}`);
    try {
        const response = await fetch(`${INTERNAL_API}/auth/register`, {
            method: 'POST',
            body: JSON.stringify({
                token: TOKEN,
                user_id: USER_ID,
                project_id: PROJECT_ID,
                ttl: 300
            }),
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.ok) {
            console.log(`[Client] Register success: ${response.status}`);
            return true;
        } else {
            console.log(`[Client] Register failed: ${response.status} ${await response.text()}`);
            return false;
        }
    } catch (e) {
        console.log(`[Client] Register error: ${e}`);
        return false;
    }
}

async function triggerInvalidation() {
    await new Promise(r => setTimeout(r, 1000));
    console.log(`[Invalidator] Triggering invalidation for ${PROJECT_ID}`);
    try {
        const response = await fetch(`${INTERNAL_API}/invalidate`, {
            method: 'POST',
            body: JSON.stringify({
                project_id: PROJECT_ID,
                path: "/users",
                user_id: USER_ID
            }),
            headers: { 'Content-Type': 'application/json' }
        });
        console.log(`[Invalidator] Response: ${response.status}`);
    } catch (e) {
        console.log(`[Invalidator] Error: ${e}`);
    }
}

async function run() {
    if (!await registerToken()) process.exit(1);

    console.log("[Client] Connecting to WebSocket...");
    const ws = new WebSocket(`${WS_URL}?token=${TOKEN}`);

    ws.on('open', function open() {
        console.log("[WS] Connected");
        triggerInvalidation();
    });

    ws.on('message', function message(data) {
        console.log(`[WS] Received: ${data}`);
        // Check if it's the expected message
        if (data.includes('"/users"')) {
            console.log("[WS] Test Passed!");
            process.exit(0);
        }
    });
    
    ws.on('error', (e) => console.log(`[WS] Error: ${e}`));
}

run();
