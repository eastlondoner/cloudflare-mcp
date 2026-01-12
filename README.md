# cloudflare-mcp

> A smol MCP server for the complete Cloudflare API.

Uses codemode to avoid dumping too much context to your agent.

## The Problem

The Cloudflare OpenAPI spec is **2.3 million tokens** in JSON format. Even compressed to TypeScript endpoint summaries, it's still **~50k tokens**. Traditional MCP servers that expose every endpoint as a tool, or include the full spec in tool descriptions, leak this entire context to the main agent on every request.

This server solves the problem by using **code execution** in a [codemode](https://blog.cloudflare.com/code-mode/) pattern - the spec lives on the server, and only the results of queries are returned to the agent.

## Two MCP Servers

There are currently two MCP servers available. I'm running some evals to determine the best approach.

### 1. Search + Execute (Default: `/`)

Two tools where the agent writes code to search the spec and execute API calls. Akin to [ACI.dev's MCP server](https://github.com/aipotheosis-labs/aci) but with added codemode.

| Tool      | Description                                                                   |
| --------- | ----------------------------------------------------------------------------- |
| `search`  | Write JavaScript to query `spec.paths` and find endpoints                     |
| `execute` | Write JavaScript to call `cloudflare.request()` with the discovered endpoints |

**Token usage:** Only search results and API responses are returned. The 6MB spec stays on the server.

```
Agent                         MCP Server
  │                               │
  ├──search({code: "..."})───────►│ Execute code against spec.json
  │◄──[matching endpoints]────────│
  │                               │
  ├──execute({code: "..."})──────►│ Execute code against Cloudflare API
  │◄──[API response]──────────────│
```

### 2. Agent Mode (`/agent`)

Single tool that accepts natural language. The MCP server uses an LLM to generate the code internally. Sentry do something similar with their Agent mode in their [MCP server](https://x.com/zeeg/status/1983292413176340796?s=20).

| Tool         | Description                                                                    |
| ------------ | ------------------------------------------------------------------------------ |
| `cloudflare` | Describe what you want in natural language, server generates and executes code |

**Token usage:** The ~50k endpoint summary is sent to the internal LLM (gpt-4o-mini), not your main agent. Your agent only sees the final result.

```
Agent                         MCP Server                    OpenAI
  │                               │                            │
  ├──cloudflare({request})───────►│                            │
  │                               ├──generate code────────────►│
  │                               │◄──code─────────────────────│
  │                               │                            │
  │                               │ Execute code against API   │
  │◄──[API response]──────────────│                            │
```

## Setup

```bash
npm install
npm run build:spec   # Generate types from OpenAPI spec
```

### Secrets

```bash
# Required for both modes
wrangler secret put CLOUDFLARE_API_TOKEN

# Required for /agent mode only
wrangler secret put OPENAI_API_KEY
```

### Deploy

```bash
npm run deploy
```

## Usage

### Search + Execute Mode

```javascript
// 1. Search for endpoints
search({
  code: `async () => {
    const results = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        if (op.tags?.some(t => t.toLowerCase() === 'workers')) {
          results.push({ method: method.toUpperCase(), path, summary: op.summary });
        }
      }
    }
    return results;
  }`,
});

// 2. Execute API call
execute({
  code: `async () => {
    const response = await cloudflare.request({
      method: "GET",
      path: \`/accounts/\${accountId}/workers/scripts\`
    });
    return response.result;
  }`,
  account_id: "your-account-id",
});
```

### Agent Mode

```javascript
cloudflare({
  request: "List all my Workers scripts",
  account_id: "your-account-id",
});
```

## Token Comparison

| Content                       | Tokens     |
| ----------------------------- | ---------- |
| Full OpenAPI spec (JSON)      | ~2,352,000 |
| Endpoint summary (TypeScript) | ~43,000    |
| Typical search result         | ~500       |
| API response                  | varies     |

## Architecture

```
src/
├── index.ts      # Routes /agent and /
├── server.ts     # Search + Execute mode
├── agent.ts      # Agent mode (LLM code generation)
├── executor.ts   # Isolated worker code execution
├── truncate.ts   # Response truncation (10k token limit)
└── data/
    ├── types.generated.ts  # Generated endpoint types
    ├── spec.json           # OpenAPI spec for search
    └── products.ts         # Product list
```

Code execution uses Cloudflare's Worker Loader API to run generated code in isolated workers, following the [codemode pattern](https://github.com/cloudflare/agents/tree/main/packages/codemode).
