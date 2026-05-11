# DeepsProxy

Local proxy server that interfaces with DeepSeek using browser automation via Playwright.  
Provides a REST API for chat interactions and tool execution.

---

## Features

- REST API endpoints for chat completion
- Tool execution support
- Persistent browser session with login state
- Built with Hono and TypeScript

---

## Prerequisites

- Node.js v20 or later
- Playwright browsers

---

## Installation

```bash
npm install
npx playwright install
```

---

## Configuration

Create a `.env` file in the project root:

```env
DEEPSEEK_EMAIL=your_email@example.com
DEEPSEEK_PASSWORD=your_password
PORT=3000
```

---

## Usage

### Login and Save Session

```bash
npm run login
```

### Start the Server

```bash
npm start
```

The server runs by default at:

```txt
http://localhost:3000
```

---

## Testing

```bash
npm test
```

---

## API Endpoints

### `POST /chat`

Send a chat message.

#### Request Body

```json
{
  "message": "Hello, DeepSeek!",
  "tools": []
}
```

#### Response

```json
{
  "response": "...",
  "toolCalls": []
}
```

---

## Development

```bash
npm run test
npx tsx src/index.ts
```

---

## Project Structure

```txt
.
├── src/
│   ├── index.ts           # Server entry
│   ├── routes/            # API routes
│   ├── services/          # DeepSeek & Playwright services
│   ├── tools/             # Tool execution
│   └── utils/             # Utilities
├── dist/                  # Compiled output
└── deepseek_profile/      # Browser profile storage
```

---

## License

ISC

---

# Disclaimer

This project is provided strictly for educational and research purposes.

The authors do not encourage or endorse:

- Misuse
- Unauthorized automation
- Abuse of third-party services
- Violations of platform Terms of Service

Users are solely responsible for how they use this software, including compliance with applicable laws, regulations, and service agreements.

This repository is intended to demonstrate concepts related to:

- Browser automation
- Session management
- OpenAI-compatible runtime architectures

Use at your own risk.
