// The loader evaluates this module from a data: URL, so it must not import
// site.ts, whose `new URL(".", import.meta.url)` throws there.
// Category order must match `categories` in vite.config.ts
export { categories } from "./categories";
