import os
import json
import uuid
import hashlib
from datetime import datetime
from typing import Dict, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse
from pydantic import BaseModel

app = FastAPI()

# --- Простая "база данных" в памяти (для продакшна замени на PostgreSQL) ---
users: Dict[str, dict] = {}       # username -> {password_hash, id}
rooms: Dict[str, Set[str]] = {}   # room_name -> set of usernames
connections: Dict[str, WebSocket] = {}  # username -> websocket
room_history: Dict[str, list] = {}      # room_name -> [messages]

TURN_URL = os.getenv("TURN_URL", "your_turn_url_here")
TURN_USER = os.getenv("TURN_USERNAME", "your_turn_username")
TURN_CRED = os.getenv("TURN_CREDENTIAL", "your_turn_credential")


# --- Модели ---
class RegisterRequest(BaseModel):
    username: str
    password: str

class LoginRequest(BaseModel):
    username: str
    password: str


# --- Auth endpoints ---
@app.post("/api/register")
async def register(req: RegisterRequest):
    if req.username in users:
        raise HTTPException(status_code=400, detail="Имя занято")
    if len(req.username) < 2 or len(req.password) < 4:
        raise HTTPException(status_code=400, detail="Слишком короткий логин или пароль")
    users[req.username] = {
        "id": str(uuid.uuid4()),
        "password_hash": hashlib.sha256(req.password.encode()).hexdigest()
    }
    return {"ok": True}

@app.post("/api/login")
async def login(req: LoginRequest):
    user = users.get(req.username)
    if not user:
        raise HTTPException(status_code=401, detail="Пользователь не найден")
    if user["password_hash"] != hashlib.sha256(req.password.encode()).hexdigest():
        raise HTTPException(status_code=401, detail="Неверный пароль")
    return {"ok": True, "username": req.username}

@app.get("/api/turn-config")
async def get_turn_config():
    return {
        "iceServers": [
            {"urls": "stun:stun.l.google.com:19302"},
            {
                "urls": f"turn:{TURN_URL}",
                "username": TURN_USER,
                "credential": TURN_CRED
            }
        ]
    }

@app.get("/api/rooms")
async def get_rooms():
    return {"rooms": list(rooms.keys())}


# --- WebSocket ---
@app.websocket("/ws/{username}")
async def websocket_endpoint(websocket: WebSocket, username: str):
    await websocket.accept()
    connections[username] = websocket
    current_room = None

    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            msg_type = msg.get("type")

            # Присоединиться к комнате
            if msg_type == "join_room":
                room = msg["room"]
                # Выйти из предыдущей
                if current_room and current_room in rooms:
                    rooms[current_room].discard(username)
                    await broadcast_room(current_room, {
                        "type": "user_left",
                        "username": username,
                        "room": current_room
                    }, exclude=username)

                if room not in rooms:
                    rooms[room] = set()
                    room_history[room] = []

                rooms[room].add(username)
                current_room = room

                # Отправить историю
                await websocket.send_text(json.dumps({
                    "type": "room_history",
                    "messages": room_history[room][-50:]
                }))

                # Список пользователей в комнате
                await broadcast_room(room, {
                    "type": "user_joined",
                    "username": username,
                    "room": room,
                    "users": list(rooms[room])
                })

            # Текстовое сообщение
            elif msg_type == "message":
                if not current_room:
                    continue
                out = {
                    "type": "message",
                    "from": username,
                    "text": msg["text"],
                    "room": current_room,
                    "time": datetime.now().strftime("%H:%M")
                }
                room_history[current_room].append(out)
                await broadcast_room(current_room, out)

            # WebRTC сигналинг — передаём напрямую нужному пользователю
            elif msg_type in ("call_offer", "call_answer", "ice_candidate", "call_reject", "call_end"):
                target = msg.get("target")
                if target and target in connections:
                    msg["from"] = username
                    await connections[target].send_text(json.dumps(msg))

    except WebSocketDisconnect:
        pass
    finally:
        connections.pop(username, None)
        if current_room and current_room in rooms:
            rooms[current_room].discard(username)
            await broadcast_room(current_room, {
                "type": "user_left",
                "username": username,
                "room": current_room,
                "users": list(rooms.get(current_room, set()))
            })


async def broadcast_room(room: str, message: dict, exclude: str = None):
    if room not in rooms:
        return
    text = json.dumps(message)
    for uname in list(rooms[room]):
        if uname == exclude:
            continue
        ws = connections.get(uname)
        if ws:
            try:
                await ws.send_text(text)
            except Exception:
                pass


# --- Static files ---
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
async def root():
    return FileResponse("static/index.html")
