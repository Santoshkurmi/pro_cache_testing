import requests
import websocket
import json
import threading
import time
import sys

# Configuration
INTERNAL_API = "http://127.0.0.1:8081/internal"
WS_URL = "ws://127.0.0.1:8080/ws"

TOKEN = "test-token-123"
USER_ID = "user-1"
PROJECT_ID = "project-A"

def register_token():
    print(f"[Client] Registering token: {TOKEN}")
    payload = {
        "token": TOKEN,
        "user_id": USER_ID,
        "project_id": PROJECT_ID,
        "ttl": 300
    }
    try:
        resp = requests.post(f"{INTERNAL_API}/auth/register", json=payload)
        print(f"[Client] Register response: {resp.status_code} {resp.text}")
        return resp.status_code == 200
    except Exception as e:
        print(f"[Client] Register failed: {e}")
        return False

def trigger_invalidation():
    time.sleep(2) # Wait for WS connection
    print(f"[Invalidator] Triggering invalidation for {PROJECT_ID}")
    payload = {
        "project_id": PROJECT_ID,
        "path": "/users",
        "user_id": USER_ID 
    }
    try:
        resp = requests.post(f"{INTERNAL_API}/invalidate", json=payload)
        print(f"[Invalidator] Invalidate response: {resp.status_code} {resp.text}")
    except Exception as e:
        print(f"[Invalidator] Failed: {e}")

def on_message(ws, message):
    print(f"[WS] Received: {message}")
    ws.close()
    print("[WS] Test Passed!")
    sys.exit(0)

def on_error(ws, error):
    print(f"[WS] Error: {error}")

def on_close(ws, close_status_code, close_msg):
    print("[WS] Closed")

def on_open(ws):
    print("[WS] Connected")
    # Start invalidation thread
    threading.Thread(target=trigger_invalidation).start()

def connect_ws():
    # websocket.enableTrace(True)
    ws = websocket.WebSocketApp(f"{WS_URL}?token={TOKEN}",
                              on_open=on_open,
                              on_message=on_message,
                              on_error=on_error,
                              on_close=on_close)
    ws.run_forever()

if __name__ == "__main__":
    if not register_token():
        sys.exit(1)
    
    print("[Client] Connecting to WebSocket...")
    connect_ws()
