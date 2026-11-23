# lens-mcp Server

Notation Lenses ships the `lens-mcp` stdio server binary and the `@notation/lenses/mcp` subpath export. Both expose catalog and local-file lenses as Model Context Protocol tools backed by a `LensClient`.

## Stdio binary and environment

Install `@notation/lenses` globally or invoke `lens-mcp` via `npx` in your MCP client configuration.

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

| Environment variable | Behavior |
| :--- | :--- |
| `LENS_CATALOG` | Comma-separated list of catalog sources trimmed on startup |
| `LENS_BROKER_PORT` | Broker WebSocket port overriding the default `4319` |

When `LENS_CATALOG` is unset or empty, `lens-mcp` logs a notice to stderr, `lens_list` reports only loose lens files in the working directory, and `lens_call` requires a file path or URL.

On startup, `lens-mcp` attaches `StdioServerTransport`, logs the broker WebSocket status to stderr without blocking, and closes both the MCP server and `LensClient` when stdin ends.

## Tool reference

Lenses registers three MCP tools on the server instance (`name: "lens-mcp"`, `version: "0.1.0"`).

| Tool | Purpose |
| :--- | :--- |
| `lens_list` | Lists loaded catalog lenses and standalone lens JSON files |
| `lens_call` | Executes a lens by name, file path, or HTTP URL |
| `lens_observe` | Captures a page text snapshot, optional HTML, and network requests |

### `lens_list`

Accepts no input arguments. Returns `{ lenses, fileLensesNote?, fileLenses? }` serialized as JSON text, scanning up to two directory levels under the server working directory for standalone `.json` lens files alongside `client.list()`.

### `lens_call`

Executes one lens through `client.call` and validates parameters with Zod:

| Parameter | Type |
| :--- | :--- |
| `lens` | `string` |
| `params` | `Record<string, unknown> \| undefined` |
| `authLeaseMs` | `number \| undefined` |
| `noCache` | `boolean \| undefined` |
| `allowWrites` | `boolean \| undefined` |
| `tab` | `string \| undefined` |
| `outDir` | `string \| undefined` |

`lens` is required and accepts a scoped name, shortname, file path, or URL. `authLeaseMs` accepts integers from 0 to 600000, and `outDir` must be an absolute path for file-returning lenses.

Wait duration and progress reporting depend on whether the MCP request includes `_meta.progressToken`:

| Request metadata | Sign-in wait and progress |
| :--- | :--- |
| `progressToken` set | Defaults `authLeaseMs` to `120000` and emits `notifications/progress` every `10000` ms |
| `progressToken` omitted | Defaults `authLeaseMs` to `0` and sends no progress notifications |

Each progress notification reports elapsed milliseconds since the call began and clears its interval timer when the call finishes.

### `lens_observe`

Loads a URL or attaches to an existing tab via `client.observe`:

| Parameter | Type |
| :--- | :--- |
| `target` | `string \| undefined` |
| `tab` | `string \| undefined` |
| `waitMs` | `number \| undefined` |
| `html` | `boolean \| undefined` |
| `request` | `number \| string \| undefined` |

`target` must be a valid URL when provided, `waitMs` must be non-negative, and `request` accepts a non-negative integer index or URL substring.

### Result and `isError` mapping

Every tool returns a single `text` content block containing formatted JSON.

| Lens result kind | MCP error flag |
| :--- | :--- |
| `"value"` | Omitted |
| `"outcome"` | Omitted |
| `"error"` | `true` |

Both `lens_call` and `lens_observe` set `isError` to true for error results.

Because outcomes such as `needs_auth` and `agent_extract` are structured flow states rather than tool crashes, agents inspect `kind` in the JSON payload. See [Agents & MCP](../core/agents-and-mcp.md) for outcome handling workflows.

## Programmatic API

Import `createLensMcpServer` from `@notation/lenses/mcp` to attach the three tools to an existing `LensClient` and any MCP server transport.

```ts [@notation/lenses/mcp]
export function createLensMcpServer(
  client: LensClient,
  progressIntervalMs = 10_000
): McpServer;
```

```ts [src/mcp-server.ts]
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createLensClient } from "@notation/lenses";
import { createLensMcpServer } from "@notation/lenses/mcp";

await using client = createLensClient({ catalog: ["./examples"] });
const server = createLensMcpServer(client, 5_000);
await server.connect(new StdioServerTransport());
```

Pass `progressIntervalMs` to change the `notifications/progress` cadence from the `10000` millisecond default.
