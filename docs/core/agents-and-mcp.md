# Agents & MCP

Notation Lenses exposes browser lenses to AI agents through the `lens-mcp` stdio server or through a CLI skill file. Both interfaces let agents list available lenses, call them, handle sign-in prompts, and inspect pages.

## Setting up the MCP server

Install `@notation/lenses` globally so your MCP host can spawn `lens-mcp`:

```sh [Terminal]
npm install -g @notation/lenses
```

Configure `lens-mcp` in your agent host with `LENS_CATALOG` pointing to one or more comma-separated catalog sources:

```json [mcp.json]
{
  "mcpServers": {
    "lenses": {
      "command": "lens-mcp",
      "env": {
        "LENS_CATALOG": "/Users/me/lenses/examples,git:github.com/notationlabs/lenses#main/examples",
        "LENS_BROKER_PORT": "4319"
      }
    }
  }
}
```

Use absolute paths in `LENS_CATALOG` because the MCP host chooses the working directory. When `LENS_CATALOG` is unset, `lens_list` only lists loose lens files in the working directory and `lens_call` requires a file path or URL.

`LENS_BROKER_PORT` is optional and overrides the default persistent browser broker port.

## MCP tools

The server registers three tools over stdio:

| Tool | Purpose |
| :--- | :--- |
| `lens_list` | Lists catalog lenses and loose lens files in the working directory |
| `lens_call` | Calls a lens by name, file path, or URL and returns its result |
| `lens_observe` | Captures a page snapshot and network request index for authoring |

When `lens_call` receives an error result, the MCP response sets `isError` to `true` and returns the full error object serialized as JSON text.

`lens_call` accepts optional execution flags matching the CLI:

| Option | Effect |
| :--- | :--- |
| `allowWrites` | Permits write steps and mutating HTTP requests |
| `tab` | Reuses a tab ID returned by a prior call |
| `noCache` | Bypasses cached results and skips caching this call |
| `outDir` | Sets the absolute output directory for file-returning lenses |
| `authLeaseMs` | Overrides the sign-in wait duration in milliseconds |

## Sign-in outcomes and progressToken

When a lens hits a login wall, `lens_call` returns a `needs_auth` outcome with recovery guidance:

```json [Outcome response]
{
  "kind": "outcome",
  "name": "needs_auth",
  "value": {
    "$lens": "@djgrant/claude/login"
  },
  "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call."
}
```

Wait behavior depends on whether the MCP client sends a request `progressToken`:

| Client metadata | Default wait |
| :--- | :--- |
| `progressToken` set | Waits up to `120000ms` while emitting progress notifications every `10000ms` |
| `progressToken` omitted | Returns the `needs_auth` outcome immediately with a `0` wait |

Passing `authLeaseMs` explicitly overrides both defaults up to 600000 ms.

When `needs_auth` returns, the agent passes `hint` to the user, calls any follow-up lens in `value` if present, and retries once sign-in finishes.

## Agent extraction fallback

When earlier resolvers miss and a lens ends with an `llm` resolver, Lenses returns an `agent_extract` outcome instead of invoking an external model:

| Field | Contents |
| :--- | :--- |
| `prompt` | Extraction instructions declared by the lens author |
| `url` | Current page URL |
| `title` | Current page title |
| `text` | Plain-text snapshot of the page |
| `gathered` | Partial fields already collected by earlier resolvers |

The calling agent completes the extraction using `prompt` and `text` while preserving any fields already present in `gathered`.

## CLI agents with lens skill

Agents with shell access can use the `lens` CLI directly instead of running an MCP server. Print the built-in skill markdown to a workspace skill file:

```sh [Terminal]
mkdir -p .claude/skills/lenses && lens skill > .claude/skills/lenses/SKILL.md
```

The generated file teaches agents how to call lenses, follow `$lens` references, handle outcomes, and author lenses with `lens observe` and `lens eval`.

## Embedding the MCP server

Import `createLensMcpServer` from `@notation/lenses/mcp` to attach the three MCP tools to your own `LensClient` and transport:

```ts [src/mcp.ts]
import { createLensClient } from "@notation/lenses";
import { createLensMcpServer } from "@notation/lenses/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const client = createLensClient({ catalog: ["/Users/me/lenses/examples"] });
await createLensMcpServer(client).connect(new StdioServerTransport());
```

See [MCP Reference](../reference/mcp.md) for server options and tool schemas.
