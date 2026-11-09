# Agents and MCP

Give an AI agent your lenses by adding the `lens-mcp` server to its MCP config. Agents with a shell can use the `lens` CLI through a [skill file](#cli-agents) instead.

## Set up the MCP server

Install the package globally, because the agent host runs `lens-mcp` as its own process:

```sh
npm install -g @notation/lenses
```

Add the server to the agent's MCP config:

```json
{
  "mcpServers": {
    "lenses": {
      "command": "lens-mcp",
      "env": {
        "LENS_CATALOG": "/Users/me/lenses/examples,git:github.com/notationlabs/lenses#main/examples"
      }
    }
  }
}
```

`LENS_CATALOG` is a comma-separated list of [catalogs](./catalogs.md). Use absolute paths, because the agent host picks the server's working directory.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `lens_list` | none | Every lens with its `name`, `description`, `params`, `effects` and `exceptions` |
| `lens_call` | `lens`, `params`, and options | The same JSON `lens call` prints |
| `lens_observe` | `target` URL or `tab` | A text snapshot of the page and its JSON requests, for [writing new lenses](./authoring.md) |

The agent picks a lens by its description. Asked "how much of my Claude limit have I used?", it finds `@djgrant/claude/usage` and calls it:

```json
{ "lens": "claude/usage" }
```

`lens_call` options match the CLI flags: `allowWrites`, `tab`, `noCache`, `outDir` and `authLeaseMs`. Most agent hosts show `allowWrites: true` to the user when asking them to approve the call.

**An `error` result arrives as an MCP tool error, and its text is only the error's `message`.** The agent does not see `code` or `issues`.

## When the user is signed out

```json
{
  "kind": "outcome",
  "name": "needs_auth",
  "value": { "$lens": "@djgrant/claude/login" },
  "hint": "Ask the user to sign in to claude.ai in the open tab, then retry this call."
}
```

If the agent host sends a progress token, the broker first shows a sign-in tab and waits up to two minutes for the user before it returns this. Otherwise it returns at once. `authLeaseMs` overrides the wait.

The agent should:

1. Tell the user which site needs a sign-in, and pass on the `hint`.
2. Call the lens named in `value`, if there is one.
3. Call `claude/usage` again once the user says they have signed in.

Retrying in a loop does not help. Every retry returns the same outcome until the user signs in.

## When the lens asks the agent to read the page

If a lens's other resolvers fail and its last one is `llm`, the call returns an `agent_extract` outcome instead of calling a model. Its `value` holds:

- `prompt`: the lens author's instructions, such as "Return a single object {plan, limits, usage_credits}".
- `url` and `title` of the page.
- `text`: a text snapshot of the page.
- `gathered`: fields that earlier resolvers already found.

The agent follows `prompt` over `text`, and returns an object in the lens's declared shape that keeps the `gathered` fields.

## CLI agents

`lens skill` prints a skill file that teaches an agent to use the `lens` CLI. Save it for Claude Code:

```sh
mkdir -p .claude/skills/lenses && lens skill > .claude/skills/lenses/SKILL.md
```

It covers calling lenses, following `$lens` references, handling `needs_auth` and `agent_extract`, and writing lenses with `lens observe` and `lens eval`. An agent that has the MCP server can still use the skill for its guidance on writing lenses.

## Embedding the server

`createLensMcpServer` from `@notation/lenses/mcp` builds the same server around a client you configure. It returns an `McpServer` from `@modelcontextprotocol/server` with no transport attached:

```ts
import { createLensClient } from "@notation/lenses";
import { createLensMcpServer } from "@notation/lenses/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";

const client = createLensClient({ catalog: ["/Users/me/lenses/examples"] });
await createLensMcpServer(client).connect(new StdioServerTransport());
```
