const WebSocket = require('ws');
const fetch = require('node-fetch');
const fs = require('fs');

const INTERNAL_API = "http://127.0.0.1:8081/internal";
const WS_URL = "ws://127.0.0.1:8080/ws";

const USER_ID = "user-persist";
const PROJECT_ID = "project-persist";
const TOKEN = "token-persist";

async function registerToken() {
    try {
        const response = await fetch(`${INTERNAL_API}/auth/register`, {
            method: 'POST',
            body: JSON.stringify({
                token: TOKEN,
                user_id: USER_ID,
                project_id: PROJECT_ID,
                ttl: 86400
            }),
            headers: { 'Content-Type': 'application/json' }
        });
        return response.ok;
    } catch { return false; }
}

async function triggerInvalidation(path) {
    try {
        await fetch(`${INTERNAL_API}/invalidate`, {
            method: 'POST',
            body: JSON.stringify({
                project_id: PROJECT_ID,
                path: path,
                user_id: USER_ID
            }),
            headers: { 'Content-Type': 'application/json' }
        });
    } catch {}
}

async function run() {
    // 1. Initial Clean (Remove routes.json if exists to test generation)
    if (fs.existsSync('routes.json')) fs.unlinkSync('routes.json');

    // 2. Trigger Invalidation -> Should create routes.json
    const uniqueRoute = "/new-route-" + Date.now();
    await triggerInvalidation(uniqueRoute);
    await new Promise(r => setTimeout(r, 500)); // Wait for FS
    
    if (!fs.existsSync('routes.json')) {
        console.log("FAIL: routes.json not created");
        process.exit(1);
    }
    const content = fs.readFileSync('routes.json', 'utf-8');
    if (!content.includes(uniqueRoute)) {
        console.log("FAIL: route not saved");
        process.exit(1);
    }
    console.log("PASS: Route persistence verified");

    // 3. Register Token
    await registerToken();

    // 4. Trigger Invalidation for a specific route to set project state
    await triggerInvalidation("/some-route");

    // 5. Connect -> Should receive explicit state for /some-route, NOT 'all'
    // Actually wait, if I trigger invalidation, state is NOT empty.
    
    // Let's test "all" by using a NEW project with NO state
    const TOKEN_NEW = "token-clean";
    const PROJ_NEW = "project-clean"; // Empty state
     await fetch(`${INTERNAL_API}/auth/register`, {
            method: 'POST',
            body: JSON.stringify({
                token: TOKEN_NEW,
                user_id: USER_ID,
                project_id: PROJ_NEW,
                ttl: 86400
            }),
            headers: { 'Content-Type': 'application/json' }
    });

    console.log("Connecting to clean project (Expect 'all')...");
    const ws = new WebSocket(`${WS_URL}?token=${TOKEN_NEW}`);
    ws.on('message', (data) => {
        console.log(`Received: ${data}`);
        if (data.includes('"all":')) {
            console.log("PASS: Received 'all' signal on empty state");
            process.exit(0);
        } else {
             console.log("FAIL: Did not receive 'all'");
             process.exit(1);
        }
    });
}

run();
