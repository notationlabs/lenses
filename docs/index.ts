import type { DocCategory } from "@notation/docs/config";
import { manual } from "./manual/nav";
import { api } from "./api/nav";

// Category order must match `categories` in vite.config.ts
export const categories: DocCategory[] = [manual, api];
