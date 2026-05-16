# ⚡ CodeSync

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat&logo=typescript&logoColor=white)]()
[![React](https://img.shields.io/badge/React-20232A?style=flat&logo=react&logoColor=61DAFB)]()

A high-performance, real-time collaborative code editor built with React, TypeScript, WebSockets, and the Monaco Editor. 

---

## 📑 Table of Contents
- [Features](#-features)
- [Tech Stack](#-tech-stack)
- [Architecture](#-architecture)
- [Screenshots](#-screenshots)
- [Getting Started](#-getting-started)
- [Future Roadmap](#-future-roadmap)
- [Author](#-author)

---

## ✨ Features

### 🤝 Collaboration
- **Real-time Syncing:** Instantaneous code updates across all connected clients.
- **Room-Based Sessions:** Isolated workspaces for different teams or projects.
- **Live Cursors:** Visual indicators showing where other users are currently typing.
- **Session Management:** Easily join, leave, and copy room IDs for quick sharing.
- **Room Persistence:** Code state remains intact even if users temporarily disconnect.

### 💻 Editor Experience
- **Monaco Engine:** Powered by the same robust editor engine used in VS Code.
- **Multi-Language Support:** Syntax highlighting and formatting for various programming languages.
- **Code Execution:** Run code directly within the browser environment.

---

## 🛠️ Tech Stack

**Frontend:**
- [React](https://reactjs.org/) - UI Framework
- [TypeScript](https://www.typescriptlang.org/) - Type Safety
- [Monaco Editor](https://microsoft.github.io/monaco-editor/) - Core editing experience

**Backend:**
- [Node.js](https://nodejs.org/) & [Express](https://expressjs.com/) - Server environment and REST API
- [WebSocket (`ws`)](https://github.com/websockets/ws) - Bi-directional real-time communication
- [Zod](https://zod.dev/) - Schema validation

---

## 🏗️ Architecture

CodeSync utilizes a hybrid communication approach to ensure low latency and reliability:

- **WebSockets (State & Sync):** Handles the real-time collaboration layer. Each room independently maintains its connected users, shared code state, and live cursor coordinates.
- **REST API (Execution):** Handles isolated code execution requests.

---

## 📸 Screenshots
![join room](<Screenshot 2026-05-17 010612-1.png>)
![editor & output](<Screenshot 2026-05-17 013409.png>)

---

## 🚀 Getting Started

### Prerequisites
Make sure you have [Node.js](https://nodejs.org/) (v16 or higher) and `npm` installed on your machine.

### 1. Clone the repository
```bash
git clone https://github.com/sinjaa18/codesync
cd CodeSync

### 2. Start the Backend 
```bash
cd server
npm install
npm run dev

2. Start the Backend
``bash

cd server
npm install
npm run dev
(The server will typically run on http://localhost:5000 or your configured PORT)

3. Start the Frontend
Open a new terminal window:

``bash
cd client
npm install
npm run dev


🗺️ Future Roadmap
[ ] Better Execution Sandbox: Implementing Docker or secure VMs for safer code execution.
[ ] Database Persistence: Saving room states permanently using a database like MongoDB.
[ ] Authentication: User accounts, login, and saved project dashboards.
[ ] Multi-cursor Support: Enhanced text-selection syncing across users.
[ ] Real Deployment: Hosting the backend on a cloud provider and frontend on Vercel/Netlify.


👨‍💻 Author

Sintu Kumar
📧 Email: santa143ns@gmail.com
🐙 GitHub: @sinjaa18

If you found this project helpful, please consider giving it a ⭐ on GitHub!