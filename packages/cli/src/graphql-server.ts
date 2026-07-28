/**
 * `lens graphql`: serve the catalog compiled to a GraphQL schema, with
 * GraphiQL at / and the endpoint at /graphql. Queries drive real lens calls
 * through the browser, so the server binds loopback only and refuses
 * cross-origin requests — a page on the open web must not be able to query
 * a signed-in browser through this port. Each operation runs under a lens
 * call budget, and the calls it made are reported in response extensions.
 */
import { createServer } from "node:http";
import { buildLensSchema, createContext } from "@djgrant/lens/graphql";
import { LensStore, type LensClient } from "@djgrant/lens-client";
import { graphql } from "graphql";

export interface GraphQLServeOptions {
  catalogs: string[];
  client: LensClient;
  listen: number;
  maxCalls: number;
  /** serve the GraphiQL page at / (playground); otherwise the endpoint only */
  playground: boolean;
  log: (message: string) => void;
}

const DEFAULT_QUERY = `# The catalog compiled to GraphQL: sites are entities, lenses their
# fields, and each ref field a lens call made only if you select into it.
# Selections drive real browser calls: use \`first\` on arrays to bound
# ref expansion. response.extensions.lenses lists the calls made.
{
  __schema {
    queryType {
      fields { name description }
    }
  }
}
`;

// GraphiQL 5 over esm.sh, per the official CDN example — Monaco editors and
// the explorer plugin, no build step.
const graphiqlHtml = `<!doctype html>
<html>
  <head>
    <title>lens graphql</title>
    <style>body { margin: 0 } #graphiql { height: 100dvh }</style>
    <link rel="stylesheet" href="https://esm.sh/graphiql@5.2.2/dist/style.css" />
    <link rel="stylesheet" href="https://esm.sh/@graphiql/plugin-explorer@5.1.1/dist/style.css" />
    <script type="importmap">
      {
        "imports": {
          "react": "https://esm.sh/react@19.2.5",
          "react/": "https://esm.sh/react@19.2.5/",
          "react-dom": "https://esm.sh/react-dom@19.2.5",
          "react-dom/": "https://esm.sh/react-dom@19.2.5/",
          "graphiql": "https://esm.sh/graphiql@5.2.2?standalone&external=react,react-dom,@graphiql/react,graphql",
          "graphiql/": "https://esm.sh/graphiql@5.2.2/",
          "@graphiql/plugin-explorer": "https://esm.sh/@graphiql/plugin-explorer@5.1.1?standalone&external=react,@graphiql/react,graphql",
          "@graphiql/react": "https://esm.sh/@graphiql/react@0.37.3?standalone&external=react,react-dom,graphql,@graphiql/toolkit,@emotion/is-prop-valid",
          "@graphiql/toolkit": "https://esm.sh/@graphiql/toolkit@0.11.3?standalone&external=graphql",
          "graphql": "https://esm.sh/graphql@16.13.2",
          "@emotion/is-prop-valid": "data:text/javascript,"
        }
      }
    </script>
  </head>
  <body>
    <div id="graphiql">loading…</div>
    <script type="module">
      import React from 'react'
      import ReactDOM from 'react-dom/client'
      import { GraphiQL, HISTORY_PLUGIN } from 'graphiql'
      import { createGraphiQLFetcher } from '@graphiql/toolkit'
      import { explorerPlugin } from '@graphiql/plugin-explorer'
      import 'graphiql/setup-workers/esm.sh'

      ReactDOM.createRoot(document.getElementById('graphiql')).render(
        React.createElement(GraphiQL, {
          fetcher: createGraphiQLFetcher({ url: '/graphql' }),
          plugins: [HISTORY_PLUGIN, explorerPlugin()],
          defaultQuery: ${JSON.stringify(DEFAULT_QUERY)},
          defaultEditorToolsVisibility: true,
        }),
      )
    </script>
  </body>
</html>`;

function sameOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true; // GraphiQL itself, curl, native clients
  try {
    const { hostname, port: originPort } = new URL(origin);
    return (
      (hostname === "localhost" || hostname === "127.0.0.1") &&
      originPort === String(port)
    );
  } catch {
    return false;
  }
}

async function readBody(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export async function serveGraphql(options: GraphQLServeOptions): Promise<void> {
  const { catalogs, client, listen, maxCalls, playground, log } = options;
  const specs = await new LensStore(catalogs).load();
  // an empty catalog would serve a fieldless Query type, which GraphiQL
  // reports opaquely as "Error fetching schema" — fail here instead
  if (specs.length === 0) {
    throw new Error(
      `no lenses found in catalog ${catalogs.join(", ")} — check the path is a directory of lens documents`
    );
  }
  const schema = buildLensSchema(specs);
  log(`compiled ${specs.length} lenses into a GraphQL schema`);

  const server = createServer(async (request, response) => {
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    try {
      if (request.method === "GET" && request.url === "/") {
        if (!playground) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("endpoint-only mode; POST /graphql (lens graphql playground serves a UI)\n");
          return;
        }
        response.writeHead(200, { "content-type": "text/html" });
        response.end(graphiqlHtml);
        return;
      }
      if (request.method === "POST" && request.url === "/graphql") {
        if (!sameOrigin(request.headers.origin, listen)) {
          json(403, { errors: [{ message: "cross-origin requests are not allowed" }] });
          return;
        }
        const body = JSON.parse(await readBody(request)) as {
          query?: string;
          variables?: Record<string, unknown>;
          operationName?: string;
        };
        if (typeof body.query !== "string") {
          json(400, { errors: [{ message: "no query" }] });
          return;
        }
        const context = createContext(client, maxCalls);
        const result = await graphql({
          schema,
          source: body.query,
          variableValues: body.variables,
          operationName: body.operationName,
          contextValue: context,
        });
        json(200, {
          ...result,
          extensions: { ...result.extensions, lenses: context.calls },
        });
        return;
      }
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    } catch (error) {
      json(500, { errors: [{ message: (error as Error).message }] });
    }
  });

  // Lens calls drive a signed-in browser; never listen beyond loopback.
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(listen, "127.0.0.1", resolvePromise);
  });
  process.stdout.write(
    playground
      ? `graphql playground at http://localhost:${listen} (budget: ${maxCalls} calls/query)\n`
      : `graphql endpoint at http://localhost:${listen}/graphql (budget: ${maxCalls} calls/query)\n`
  );

  // Runs until interrupted; close the broker connection cleanly on the way out.
  await new Promise<void>((resolvePromise) => {
    const stop = () => server.close(() => resolvePromise());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
