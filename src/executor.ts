import spec from "./data/spec.json";

interface CodeExecutorEntrypoint {
  evaluate(): Promise<{ result: unknown; err?: string; stack?: string }>;
}

export function createCodeExecutor(env: Env) {
  const apiToken = (env as unknown as Record<string, unknown>)
    .CLOUDFLARE_API_TOKEN as string | undefined;

  return async (code: string, accountId: string): Promise<unknown> => {
    if (!apiToken) {
      throw new Error(
        "CLOUDFLARE_API_TOKEN secret is not set. Run: wrangler secret put CLOUDFLARE_API_TOKEN"
      );
    }

    const workerId = `cloudflare-api-${crypto.randomUUID()}`;

    const worker = env.LOADER.get(workerId, () => ({
      compatibilityDate: "2026-01-12",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "worker.js",
      modules: {
        "worker.js": `
import { env, WorkerEntrypoint } from "cloudflare:workers";

export default class CodeExecutor extends WorkerEntrypoint {
  async evaluate() {
    try {
      const { apiBase, apiToken, accountId } = env;

      const cloudflare = {
        async request(options) {
          const { method, path, query, body } = options;

          const url = new URL(apiBase + path);
          if (query) {
            for (const [key, value] of Object.entries(query)) {
              if (value !== undefined) {
                url.searchParams.set(key, String(value));
              }
            }
          }

          const response = await fetch(url.toString(), {
            method,
            headers: {
              "Authorization": "Bearer " + apiToken,
              "Content-Type": "application/json",
            },
            body: body ? JSON.stringify(body) : undefined,
          });

          const data = await response.json();

          if (!data.success) {
            const errors = data.errors.map(e => e.code + ": " + e.message).join(", ");
            throw new Error("Cloudflare API error: " + errors);
          }

          return data;
        }
      };

      const result = await (${code})();
      return { result, err: undefined };
    } catch (err) {
      return { result: undefined, err: err.message, stack: err.stack };
    }
  }
}
        `,
      },
      env: {
        apiBase: env.CLOUDFLARE_API_BASE,
        apiToken: apiToken,
        accountId: accountId,
      },
    }));

    const entrypoint = worker.getEntrypoint() as unknown as CodeExecutorEntrypoint;
    const response = await entrypoint.evaluate();

    if (response.err) {
      throw new Error(response.err);
    }

    return response.result;
  };
}

export function createSearchExecutor(env: Env) {
  const specJson = JSON.stringify(spec);

  return async (code: string): Promise<unknown> => {
    const workerId = `cloudflare-search-${crypto.randomUUID()}`;

    const worker = env.LOADER.get(workerId, () => ({
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

    const entrypoint = worker.getEntrypoint() as unknown as CodeExecutorEntrypoint;
    const response = await entrypoint.evaluate();

    if (response.err) {
      throw new Error(response.err);
    }

    return response.result;
  };
}
