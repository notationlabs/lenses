import type { HttpFetchBody } from "@djgrant/lenses-core";

/** Turn the protocol-safe body representation into the host's native BodyInit. */
export function materialiseHttpBody(
  body: HttpFetchBody | undefined,
  headers?: Record<string, string>
): { body?: BodyInit; headers?: Record<string, string> } {
  if (!body) return { headers };
  const nextHeaders = { ...headers };
  const hasContentType = Object.keys(nextHeaders).some(
    (name) => name.toLowerCase() === "content-type"
  );
  if (body.kind === "json") {
    if (!hasContentType) nextHeaders["content-type"] = "application/json";
    return { body: body.value, headers: nextHeaders };
  }
  if (body.kind === "text") {
    if (!hasContentType) nextHeaders["content-type"] = "text/plain;charset=UTF-8";
    return { body: body.value, headers: nextHeaders };
  }
  if (body.kind === "search") {
    return { body: new URLSearchParams(body.entries), headers: nextHeaders };
  }
  const form = new FormData();
  for (const [name, value] of body.entries) form.append(name, value);
  return { body: form, headers: nextHeaders };
}
