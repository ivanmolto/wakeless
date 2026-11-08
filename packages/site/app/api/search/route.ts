import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// Built-in search, no external service: the index is exported once at build time
// (.next/server/app/api/search.body) and searched in the browser.
export const revalidate = false;

export const { staticGET: GET } = createFromSource(source);
