const WebSocket = require('ws');
const fetch = require('node-fetch');

const INTERNAL_API = "http://127.0.0.1:8081/internal";
const WS_URL = "ws://127.0.0.1:8080/ws";

const USER_ID = "user-refine";
const PROJECT_ID = "project-refine";
const TOKEN_1 = "token-1-old";
const TOKEN_2 = "token-2-new";

async function registerToken(token) {
    console.log(`[Client] Registering token: ${token}`);
    try {
        const response = await fetch(`${INTERNAL_API}/auth/register`, {
            method: 'POST',
            body: JSON.stringify({
                token: token,
                user_id: USER_ID,
                project_id: PROJECT_ID,
                ttl: 86400
            }),
            headers: { 'Content-Type': 'application/json' }
        });
        return response.ok;
    } catch (e) {
        console.log(`[Client] Register error: ${e}`);
        return false;
    }
}

async function triggerInvalidation(path) {
    console.log(`[Invalidator] Triggering invalidation for ${path}`);
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
    } catch (e) {
        console.log(`[Invalidator] Error: ${e}`);
    }
}

async function run() {
    // 1. Initial Invalidation (to populate state)
    await triggerInvalidation("/initial-route"); // Timestamp T1

    // 2. Register Token 1
    await registerToken(TOKEN_1);

    // 3. Register Token 2 (Should invalidate Token 1 in storage)
    await registerToken(TOKEN_2);

    // 4. Try Connect with Token 1 (Should Fail because it was replaced)
    console.log("[Client] Connecting with TOKEN_1 (Expect Failure)...");
    try {
        await new Promise((resolve, reject) => {
            const ws1 = new WebSocket(`${WS_URL}?token=${TOKEN_1}`);
            ws1.on('open', () => { ws1.close(); reject("Token 1 should have been invalid"); });
            ws1.on('error', () => resolve("Token 1 rejected as expected"));
        });
        console.log("[Client] Token 1 correctly rejected.");
    } catch (e) {
        console.log(`[Client] Unexpected success with Token 1: ${e}`);
        process.exit(1);
    }

    // 5. Connect with Token 2 (Should Succeed and receive Initial State)
    console.log("[Client] Connecting with TOKEN_2 (Expect Success + Initial State)...");
    const ws2 = new WebSocket(`${WS_URL}?token=${TOKEN_2}`);
    
    ws2.on('open', () => {
        console.log("[WS2] Connected");
    });

    ws2.on('message', (data) => {
        console.log(`[WS2] Received: ${data}`);
        if (data.includes('"/initial-route"')) {
            console.log("[WS2] Received initial state! Success.");
            ws2.close();
            process.exit(0);
        }
    });

    ws2.on('error', (e) => {
        console.log(`[WS2] Error: ${e}`);
        process.exit(1);
    });
}

run();
