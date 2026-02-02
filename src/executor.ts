import spec from "./data/spec.json";

interface CodeExecutorEntrypoint {
  evaluate(
    apiToken: string
  ): Promise<{ result: unknown; err?: string; stack?: string }>;
}

interface SearchExecutorEntrypoint {
  evaluate(): Promise<{ result: unknown; err?: string; stack?: string }>;
}

// Simple hash function for cache keys
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

// Simple LRU cache for workers to prevent memory exhaustion
class WorkerCache<T> {
  private cache = new Map<string, T>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): void {
    // If key exists, delete it first to update position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    // Evict oldest if at capacity
    while (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }
}

export function createCodeExecutor(env: Env) {
  const apiBase = env.CLOUDFLARE_API_BASE;
  // LRU cache limits total workers to prevent memory exhaustion
  const workerCache = new WorkerCache<ReturnType<typeof env.LOADER.get>>(20);

  return async (
    code: string,
    accountId: string,
    apiToken: string
  ): Promise<unknown> => {
    // Cache key includes both accountId and code hash to reuse workers for identical requests
    const codeHash = simpleHash(code);
    const cacheKey = `${accountId}:${codeHash}`;
    let worker = workerCache.get(cacheKey);

    if (!worker) {
      const workerId = `cloudflare-api-${cacheKey}`;
      worker = env.LOADER.get(workerId, () => ({
      compatibilityDate: "2026-01-12",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      modules: {
        "worker.js": `
import { WorkerEntrypoint } from "cloudflare:workers";

const apiBase = ${JSON.stringify(apiBase)};
const accountId = ${JSON.stringify(accountId)};

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate(apiToken) {
    const cloudflare = {
      async request(options) {
        const { method, path, query, body, contentType, rawBody } = options;

        const url = new URL(apiBase + path);
        if (query) {
          for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
              url.searchParams.set(key, String(value));
            }
          }
        }

        const headers = {
          "Authorization": "Bearer " + apiToken,
        };

        if (contentType) {
          headers["Content-Type"] = contentType;
        } else if (body && !rawBody) {
          headers["Content-Type"] = "application/json";
        }

        let requestBody;
        if (rawBody) {
          requestBody = body;
        } else if (body) {
          requestBody = JSON.stringify(body);
        }

        const response = await fetch(url.toString(), {
          method,
          headers,
          body: requestBody,
        });

        const responseContentType = response.headers.get("content-type") || "";

        // Handle non-JSON responses (e.g., KV values)
        if (!responseContentType.includes("application/json")) {
          const text = await response.text();
          if (!response.ok) {
            throw new Error("Cloudflare API error: " + response.status + " " + text);
          }
          return { success: true, result: text };
        }

        const data = await response.json();

        if (!data.success) {
          const errors = data.errors.map(e => e.code + ": " + e.message).join(", ");
          throw new Error("Cloudflare API error: " + errors);
        }

        return data;
      }
    };

    try {
      const result = await (${code})();
      return { result, err: undefined };
    } catch (err) {
      return { result: undefined, err: err.message, stack: err.stack };
    }
  }
}
        `,
        },
      }));
      workerCache.set(cacheKey, worker);
    }

    const entrypoint =
      worker.getEntrypoint() as unknown as CodeExecutorEntrypoint;
    const response = await entrypoint.evaluate(apiToken);

    if (response.err) {
      throw new Error(response.err);
    }

    return response.result;
  };
}

export function createSearchExecutor(env: Env) {
  const specJson = JSON.stringify(spec);
  // LRU cache for search workers - smaller limit since each includes the 44MB spec
  const workerCache = new WorkerCache<ReturnType<typeof env.LOADER.get>>(5);

  return async (code: string): Promise<unknown> => {
    // Cache by code hash to reuse workers for identical queries
    const codeHash = simpleHash(code);
    let worker = workerCache.get(codeHash);

    if (!worker) {
      const workerId = `cloudflare-search-${codeHash}`;
      worker = env.LOADER.get(workerId, () => ({
      compatibilityDate: "2026-01-12",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      modules: {
        "worker.js": `
import { WorkerEntrypoint } from "cloudflare:workers";

const spec = ${specJson};

export default class SearchExecutor extends WorkerEntrypoint {
  async evaluate() {
    try {
      const result = await (${code})();
      return { result, err: undefined };
    } catch (err) {
      return { result: undefined, err: err.message, stack: err.stack };
    }
  }
}
        `,
        },
      }));
      workerCache.set(codeHash, worker);
    }

    const entrypoint =
      worker.getEntrypoint() as unknown as SearchExecutorEntrypoint;
    const response = await entrypoint.evaluate();

    if (response.err) {
      throw new Error(response.err);
    }

    return response.result;
  };
}
