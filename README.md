# ⚡ CodeSync

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=flat\&logo=typescript\&logoColor=white)]()
[![React](https://img.shields.io/badge/React-20232A?style=flat\&logo=react\&logoColor=61DAFB)]()

A high-performance real-time collaborative code editor built using React, TypeScript, WebSockets, and Monaco Editor.

---

# 📑 Table of Contents

* [Features](#-features)
* [Tech Stack](#-tech-stack)
* [Architecture](#-architecture)
* [Screenshots](#-screenshots)
* [Getting Started](#-getting-started)
* [Future Roadmap](#-future-roadmap)
* [Live Demo](#-live-demo)
* [Author](#-author)

---

# ✨ Features

## 🤝 Real-Time Collaboration

* Instant code synchronization across connected users
* Room-based collaborative sessions
* Live cursor tracking
* Join / leave room management
* Room persistence during temporary disconnects

## 💻 Editor Experience

* Monaco Editor integration (same editor engine as VS Code)
* Multi-language syntax highlighting
* In-browser code execution
* Smooth low-latency editing experience

## ⚙️ Backend & Sync

* WebSocket-powered real-time communication
* REST API for code execution
* Schema validation using Zod
* Scalable room-based architecture

---

# 🛠️ Tech Stack

## Frontend

* [React](https://reactjs.org/)
* [TypeScript](https://www.typescriptlang.org/)
* [Monaco Editor](https://microsoft.github.io/monaco-editor/)

## Backend

* [Node.js](https://nodejs.org/)
* [Express](https://expressjs.com/)
* [ws WebSocket Library](https://github.com/websockets/ws)
* [Zod](https://zod.dev/)

---

# 🏗️ Architecture

CodeSync follows a hybrid communication architecture for performance and reliability.

### 🔄 WebSockets — Real-Time Collaboration

Handles:

* Shared editor state
* Live code syncing
* Cursor positions
* Room session management

Each room independently maintains its own connected users and synchronized editor state.

### 🌐 REST API — Code Execution

Handles isolated code execution requests separately from the synchronization layer.

This separation keeps collaboration responsive while execution tasks remain independent.

---

# 📸 Screenshots

## Join Room

![Join Room](./Screenshot%202026-05-17%20010612-1.png)

## Editor & Output

![Editor Output](./Screenshot%202026-05-17%20013409.png)

---

# 🚀 Getting Started

## Prerequisites

Make sure you have the following installed:

* [Node.js](https://nodejs.org/) (v16 or higher)
* npm

---

## 1️⃣ Clone the Repository

```bash
git clone https://github.com/sinjaa18/codesync.git

cd codesync
```

---

## 2️⃣ Start the Backend

```bash
cd server

npm install

npm run dev
```

Backend will typically run on:

```txt
http://localhost:5000
```

---

## 3️⃣ Start the Frontend

Open a new terminal window:

```bash
cd client

npm install

npm run dev
```

Frontend will typically run on:

```txt
http://localhost:5173
```

---

# 🗺️ Future Roadmap

* [ ] Secure execution sandbox using Docker / VMs
* [ ] Database persistence with MongoDB
* [ ] User authentication & dashboards
* [ ] Advanced multi-cursor synchronization
* [ ] Cloud deployment infrastructure
* [ ] File & project management
* [ ] Chat system inside collaboration rooms

---

# 🌐 Live Demo

👉 [https://codesync-xi-one.vercel.app/](https://codesync-xi-one.vercel.app/)

---

# 👨‍💻 Author

**Sintu Kumar**

* 📧 Email: [santa143ns@gmail.com](mailto:santa143ns@gmail.com)
* 🐙 GitHub: [https://github.com/sinjaa18](https://github.com/sinjaa18)

---

# ⭐ Support

If you found this project useful, consider giving the repository a star on GitHub.
