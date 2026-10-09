# CodeSync

CodeSync is a browser-based collaborative code workspace. It brings project files, shared editing, collaborator presence, room chat, and sandboxed code execution into one application. It reduces the coordination overhead of editing code together by synchronizing document changes and presence in real time while keeping room access and persisted state on the server.

[Open the deployed application](https://codesync-nu-ashen.vercel.app/) · [Source repository](https://github.com/sinjaa18/codesync)

## Features

- Account signup and login with server-managed sessions.
- Shared standalone rooms and project workspaces with a file tree.
- Per-file Monaco editing synchronized through Yjs over WebSockets.
- Collaborator presence, active-file information, cursor sharing, and room chat.
- Room invitations and owner-reviewed join requests.
- Project roles: OWNER and EDITOR project memberships allow collaboration. VIEWER preserves project-file reads but grants no room access; an explicit room membership is a separate room-level grant.
- Persistent projects, file contents, room membership, chat, join requests, and Yjs updates in PostgreSQL.
- Owner-only project deletion and coordinated room cleanup when a file or project is deleted.
- Authenticated execution of JavaScript, TypeScript, Python, C++, and Java through a configured Judge0 service.
- Health and database-readiness endpoints.

## Screenshots

### Editor and code execution

![CodeSync editor with the project explorer, collaborator panel, Monaco editor, and execution output](screenshots/editor.png)

### Live collaboration

![Two CodeSync sessions editing the same room](screenshots/collaboration.png)

### Room chat and collaborators

![Room chat alongside the collaborators panel](screenshots/chat-collaborators.png)

## Technology choices

| Technology | Role in CodeSync |
| --- | --- |
| React and TypeScript | Build the interactive browser UI and keep client state/API flows typed. |
| Monaco Editor | Provide code-focused editing and language-aware editor behavior. |
| Yjs and y-monaco | Merge concurrent text edits and bind the shared document to Monaco. |
| WebSockets (ws) | Carry bidirectional document, presence, chat, and request notifications with low-overhead live delivery. |
| Node.js and Express | Serve the HTTP API and host the WebSocket endpoint on the same server. |
| PostgreSQL and Prisma | Keep product and collaboration records durable; use Prisma for typed database access and migrations. |
| Zod | Reject malformed HTTP inputs and WebSocket messages at the server boundary. |
| Judge0 | Execute submitted code in an external sandbox instead of evaluating it inside the application process. |

## Architecture

The browser uses HTTP for account, project, room, chat-history, and execution requests. A WebSocket on the same backend server carries authenticated collaboration events. PostgreSQL is the durable source for saved room updates and product records; active Yjs documents and sockets are held in backend process memory.

```mermaid
flowchart LR
    Browser["React + Monaco + Yjs"]
    API["Express HTTP API"]
    WS["ws WebSocket server"]
    DB[("PostgreSQL via Prisma")]
    Judge["Configured Judge0 service"]

    Browser -->|"HTTPS: auth, projects, rooms, history"| API
    Browser <-->|"WSS: authenticate, join, Yjs, presence, chat"| WS
    API <-->|"authorization and persisted records"| DB
    WS <-->|"load and persist Yjs updates, chat"| DB
    API -->|"validated code and stdin"| Judge
    Judge -->|"execution result"| API
    API -->|"JSON response"| Browser
```

See [docs/architecture.md](docs/architecture.md) for room lifecycle, authorization boundaries, synchronization, persistence, and deletion behavior.

## Collaboration and recovery

1. The client signs in over HTTP. The server issues a random opaque bearer session token; it is not a JWT. The session record stores the token hash and expiry in PostgreSQL.
2. Before opening a room WebSocket, the client authenticates with that token. On a join request, the server checks current room or project membership against PostgreSQL.
3. The server loads the room’s ordered Yjs updates into a Y.Doc (or reuses the active in-memory document), then returns the state missing from the client’s Yjs state vector.
4. Clients send incremental Yjs updates. The server applies them, persists each update and the current project-file content, then broadcasts the update to other sockets in that room. Yjs merges concurrent edits.
5. Presence and chat events use the authorized room connection. Chat history is loaded from PostgreSQL for authorized members.
6. When the last socket leaves, the server drops the in-memory document. PostgreSQL retains the updates, so a later join reconstructs the document. Deleting a file or project fences new joins, closes active sockets, clears cached or loading room state, drains active persistence work, and removes the corresponding records.

This is server-backed reconnect recovery, not an offline-first synchronization service. A reconnecting client reconciles its local Yjs state with the server, but the backend must be reachable to exchange state and persist new changes.

## Repository layout

```text
.
├── client/
│   ├── src/
│   │   ├── App.tsx                 # Application state and API/WebSocket flows
│   │   ├── components/CodeEditor.tsx
│   │   └── joinRequest.ts          # Join approval status reconciliation
│   ├── .env.example
│   └── package.json
├── server/
│   ├── prisma/schema.prisma
│   ├── prisma/migrations/
│   ├── src/
│   │   ├── auth/                   # Sessions and access control
│   │   ├── collaboration/          # Room deletion lifecycle
│   │   ├── execution/              # Judge0 integration
│   │   ├── routes/
│   │   └── index.ts                # Express and WebSocket server
│   ├── scripts/                    # Test database guard and benchmark
│   ├── test/unit/
│   ├── test/integration/
│   ├── .env.example
│   └── package.json
├── docs/
│   ├── architecture.md
│   └── performance-baseline.json
├── screenshots/
└── .github/workflows/ci.yml
```

## Local setup

### Requirements

- Node.js 22 (the CI workflow uses Node.js 22).
- npm.
- PostgreSQL. CI uses PostgreSQL 16; the recorded local benchmark used PostgreSQL 18.6.

### Install and configure

Run from the repository root:

```powershell
npm ci --prefix server
npm ci --prefix client
Copy-Item server/.env.example server/.env
Copy-Item client/.env.example client/.env
```

Create a local development database with your PostgreSQL administrator account. Choose a local password and use the same value in server/.env:

```sql
CREATE ROLE codesync LOGIN PASSWORD 'choose-a-local-password';
CREATE DATABASE codesync OWNER codesync;
```

Apply the checked-in Prisma migrations, then start the backend and frontend in separate terminals:

```powershell
npm --prefix server run db:deploy
npm --prefix server run dev
```

```powershell
npm --prefix client run dev
```

Open http://localhost:5173. The server listens on port 5000 by default. Register an account, create or enter a room, and invite another registered username or request access to a room. A room ID alone does not grant access.

### Environment variables

The example files contain local-development defaults and placeholders. Copy them to ignored .env files; never commit real credentials.

| Variable | Used by | Purpose |
| --- | --- | --- |
| PORT | Server | HTTP and WebSocket listen port; defaults to 5000. |
| DATABASE_URL | Server and Prisma | PostgreSQL connection string. |
| CLIENT_ORIGIN | Server | Comma-separated allowed browser origins; defaults to http://localhost:5173. |
| JUDGE0_API_URL | Server | Judge0-compatible API base URL; defaults to the CE endpoint in the server code. |
| JUDGE0_AUTH_TOKEN | Server | Optional upstream authentication token, depending on the Judge0 provider. |
| VITE_API_URL | Client build | Public HTTP API base URL; defaults to http://localhost:5000. |
| VITE_WS_URL | Client build | Public WebSocket URL; defaults to the WebSocket form of the API URL. |

Vite embeds VITE_* values in browser assets. They must contain public URLs only, never secrets.

## Database and migrations

The Prisma schema defines users, sessions, projects, project memberships, files, rooms, room memberships, join requests, chat messages, and persisted Yjs updates. For a development or deployed database, apply checked-in migrations with:

```bash
npm --prefix server run db:deploy
```

The db:migrate script runs Prisma’s development migration workflow and is intended for local schema development. Production deployments should use db:deploy against the deployment database.

## Development and quality commands

These root commands are defined in package.json:

```bash
npm run typecheck
npm run build
npm run lint
npm run test:unit
npm run test:integration
npm test
```

- typecheck checks server source and server tests.
- build builds the server and client.
- lint runs ESLint on the client.
- test:unit runs server unit tests; PostgreSQL is not required.
- test:integration resets the dedicated test database and runs the PostgreSQL/WebSocket integration test.
- test runs the server test script, including generated Prisma client, test database reset, test typecheck, unit tests, and integration tests.

### Test database safety

Integration tests use server/.env.test.local. Copy the example with <code>Copy-Item server/.env.test.local.example server/.env.test.local</code>, then replace the placeholder password. Create a separate local database named exactly codesync_test with your PostgreSQL administrator (for example, <code>CREATE DATABASE codesync_test OWNER postgres;</code>), then set DATABASE_URL to that database, for example:

```text
postgresql://postgres:local-password@localhost:5432/codesync_test?schema=public
```

The reset script refuses non-PostgreSQL URLs, hosts outside loopback, and database names other than codesync_test. The integration command resets that database before running. Never point it at a development or production database. The integration test uses a local Judge0 mock; it does not call the public execution service.

The integration test exercises HTTP and WebSocket behavior with real PostgreSQL persistence, including authentication, project/file access, room membership, concurrent Yjs edits, presence, chat, join requests, room deletion and reuse, project deletion, and execution request handling. Unit tests cover focused helpers such as execution response validation, join-request reconciliation, observability, benchmark safety, and room lifecycle races.

CI runs these checks on pushes and pull requests to main: server and client dependency installation, migrations against a PostgreSQL 16 service, server tests, typechecks, production builds, and client lint. The scripts do not provide a browser end-to-end suite; the integration test uses WebSocket clients and HTTP requests. Screenshots are illustrative and do not represent a recorded automated browser test.

## Deployment

The repository’s existing project documentation identifies a Vercel-hosted frontend and a Render-hosted backend. The frontend is a Vite static build; the backend is one Node.js process hosting both Express and WebSockets. The backend connects to PostgreSQL through DATABASE_URL and calls the configured Judge0 service for execution.

There are no Vercel, Render, or database-provider deployment manifests in this repository. Hosting settings are configured outside the source tree. For a deployment, build the client with public VITE_API_URL and VITE_WS_URL values, configure CLIENT_ORIGIN and server-side secrets on the backend, apply pending migrations with npm --prefix server run db:deploy, then start the compiled server with npm --prefix server start. Confirm that the platform routes WebSocket upgrades to the backend and provides persistent PostgreSQL. Do not expose DATABASE_URL or Judge0 credentials to the client.

## Security and limitations

Implemented protections include:

- Passwords are hashed with scrypt. Server-issued random session tokens expire after one hour; the database stores a SHA-256 token hash rather than the raw token.
- HTTP routes and WebSocket room joins require a valid session. WebSocket sessions also close on expiry.
- Room and project authorization is checked server-side. OWNER and EDITOR project roles grant project-room access; VIEWER allows project-file reads but does not itself grant room access. An explicit room membership is checked separately. A room ID is not an access credential.
- Room chat history and message writes require room access.
- Inputs are validated with Zod, including execution payload and WebSocket message schemas. Authentication and code execution have per-process rate limits.
- Code execution is sent to the configured Judge0 service; the CodeSync server does not evaluate source code itself. The request disables sandbox network access and applies server-owned CPU, wall-time, memory, stack, process, and file-size limits. Upstream response size, request time, and returned output are bounded.
- CORS origins can be configured through CLIENT_ORIGIN; structured logs redact sensitive error details.

Important boundaries:

- The browser keeps the bearer session token in local storage. Treat it as a credential and avoid shared or untrusted devices.
- Submitted source code and standard input are sent to the configured Judge0 provider. Review that provider’s data-handling terms before using private code.
- Active sockets, room documents, rate-limit counters, and revocation listeners are process-local. Membership revocation, session revocation, room deletion, and WebSocket broadcasts are coordinated within the current backend process. The deployed design therefore assumes one backend instance; it does not provide cross-instance revocation or collaboration fanout.
- Yjs updates are stored as an append-only log. Compaction and document history browsing are not implemented.
- Email verification, password recovery, and multi-factor authentication are not implemented.
- The repository does not include a LICENSE file. Reuse and contribution terms have not been declared.

## Performance snapshot

A successful local benchmark snapshot is recorded in [docs/performance-baseline.json](docs/performance-baseline.json). It was generated on Windows 11 with Node.js 22.18.0 and PostgreSQL 18.6 on an AMD Ryzen 7 7730U. At the 25-client stage, the benchmark recorded:

| Scenario | Samples | p50 | p95 | Throughput |
| --- | ---: | ---: | ---: | ---: |
| Authenticated project list | 90 | 26.16 ms | 33.18 ms | 680.53 requests/s |
| Authenticated project file list | 90 | 28.70 ms | 39.98 ms | 621.02 requests/s |
| WebSocket room join | 75 | 41.13 ms | 51.33 ms | 267.23 joins/s |

The Yjs client-to-peer update scenario used up to five concurrent clients and recorded p50 9.40 ms and p95 17.25 ms over 180 deliveries, with no failed operations. These are local loopback measurements from one machine, not production capacity or multi-instance scalability claims.

To run the opt-in benchmark against the dedicated local test database:

```bash
npm --prefix server run benchmark -- --allow-local-target --max-clients 25 --requests 30 --repetitions 3
```

The benchmark validates that DATABASE_URL targets loopback PostgreSQL database codesync_test, applies checked-in migrations, creates temporary records, and cleans them up. It does not reset the database or call Judge0. Do not run it against production or a development database.

## Limitations and future improvements

1. **Distributed collaboration and revocation:** introduce shared coordination for WebSocket fanout, membership/session revocation, and process-local rate limits before operating more than one backend instance.
2. **Yjs storage growth:** add safe update compaction and verify recovery against compacted state.
3. **Security and contribution readiness:** consider an HttpOnly cookie-based session design, a documented content security policy, and an explicit license/contribution guide.

## Engineering focus

CodeSync is built around practical systems concerns: concurrent state reconciliation, authorization at HTTP and WebSocket boundaries, durable recovery from PostgreSQL, safe room teardown, and constrained delegation of untrusted code execution to an external sandbox.

## Maintainer

[Sintu Kumar](https://github.com/sinjaa18)
