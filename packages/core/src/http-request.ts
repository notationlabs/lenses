import type { HttpResolver, LensSpec, RequestSpec } from "./types.js";

/** The request's declared method, upper-cased; an omitted request is a GET of the lens URL. */
export function httpRequestMethod(request?: RequestSpec): string {
  return request ? request.method.toUpperCase() : "GET";
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
