import type { HttpResolver, LensSpec } from "./types.js";

/** Extract the declared method; request strings without one are GETs. */
export function httpRequestMethod(request?: string): string {
  if (!request) return "GET";
  const space = request.indexOf(" ");
  return space === -1 ? "GET" : request.slice(0, space).toUpperCase();
}

/** Methods with defined read-only semantics. Unknown methods fail closed as writes. */
export function isWriteHttpMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

export function httpResolverWrites(resolver: HttpResolver): boolean {
  if (resolver.sources) {
    return Object.values(resolver.sources).some((source) =>
      isWriteHttpMethod(httpRequestMethod(source.request))
    );
  }
  return isWriteHttpMethod(httpRequestMethod(resolver.request));
}

/** Whether invoking this document can cause a side effect. */
export function specWrites(spec: LensSpec): boolean {
  return Boolean(spec.perform?.length) || spec.resolve.some(
    (resolver) => resolver.kind === "http" && httpResolverWrites(resolver)
  );
}
