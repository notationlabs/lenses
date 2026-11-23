import type { DocCategory } from "@notation/docs/config";
import site from "./site";

// Category order must match `categories` in vite.config.ts
export const categories: DocCategory[] = site.categories;
