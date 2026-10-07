# CodeSync

CodeSync is a browser-based shared code editor. People in the same room edit one Monaco document and can see each other's cursor positions.

## Features

- Join a room using its ID; copy the ID to invite another person.
- Share the latest room code and cursor positions over WebSockets.
- Edit with Monaco syntax highlighting for JavaScript, TypeScript, Python, C++, and Java.
- Run code through a configured Judge0 sandbox service.
- See connection state, participant count, execution output, and request errors.

## Tech Stack

- Frontend: React, TypeScript, Vite, Monaco Editor.
- Backend: Node.js, TypeScript, Express, `ws`, and Zod.
- Execution: Judge0 Community Edition API (configurable).

## Architecture

```text
React + Monaco
      │ WebSocket (room join, code, cursor)
      ▼
Node.js + Express + ws ── in-memory room state

React ── HTTP POST /run ── Express ── Judge0 sandbox API
```

WebSockets carry collaboration events. Express keeps room membership and each active room's latest full code string in memory. The REST endpoint validates execution requests and submits them to Judge0; user code is never evaluated inside the CodeSync server process.

## Realtime synchronization

The client debounces code changes by 300 ms and sends the current document as a `code-update`. The server saves it for that active room and broadcasts it to the other room members. A newly joined member receives the current code in the join acknowledgement. Cursor coordinates are broadcast to other room members. The client applies incoming code as editor state and does not send that remote update back.

This is a simple last-update-wins model. Concurrent edits to overlapping text can overwrite each other and are not merged. Room state is held in memory and is deleted when its last socket leaves.

## Local setup

Requires Node.js 22.12 or later and npm.

1. In one terminal, configure and start the backend:

   ```bash
   cd server
   cp .env.example .env
   npm install
   npm run dev
   ```

2. In another terminal, configure and start the frontend:

   ```bash
   cd client
   cp .env.example .env
   npm install
   npm run dev
   ```

3. Open the Vite URL (normally `http://localhost:5173`) in two browser tabs and join the same room ID.

On PowerShell, use `Copy-Item .env.example .env` in each directory instead of `cp` if needed.

## Environment variables

`client/.env.example` sets `VITE_API_URL` and `VITE_WS_URL`. Vite exposes these values in the browser bundle, so they must only contain public service URLs. Local defaults are also provided by the app.

`server/.env.example` sets the backend port, allowed frontend origin, Judge0 API URL, and optional Judge0 auth token. Copy it to `server/.env` and set credentials privately when the chosen Judge0 host requires them. The server defaults to the official Judge0 CE endpoint; public service availability and rate limits are controlled by that service.

## Screenshots

![CodeSync room join screen](screenshots/join-room.png)

![CodeSync editor and output panel](screenshots/editor-output.png)

## Limitations

- Rooms and code exist only in server memory and are removed after the last participant disconnects or the server restarts.
- Concurrent edits are not conflict-free; the latest received full-document update wins.
- Cursor sharing shows one remote cursor at a time and does not sync selections or identify participants.
- There is no authentication or authorization. Room IDs are the only room access mechanism.
- Execution depends on an external Judge0 host. The selected service controls language versions, availability, and any additional limits. CodeSync applies basic per-process request limits and bounded source/runtime settings; a public deployment should use a configured sandbox and a shared rate limiter behind its trusted proxy.

## Future improvements

- Persist room state with a database and an expiry policy.
- Add authentication and room access controls.
- Add presence labels and per-user cursor decorations.
- Add automated collaboration and execution tests.

## Live demo

No live demo is currently configured.
