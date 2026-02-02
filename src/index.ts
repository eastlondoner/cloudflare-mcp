import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createServer } from "./server";

interface CloudflareResponse<T = unknown> {
  success: boolean;
  result?: T;
  errors?: Array<{ code: number; message: string }>;
}

interface Account {
  id: string;
  name: string;
}

async function verifyToken(token: string): Promise<{ valid: boolean; accountId?: string; error?: string }> {
  const headers = { Authorization: `Bearer ${token}` };

  try {
    // Run user token verification and accounts fetch in parallel
    const [userResponse, accountsResponse] = await Promise.all([
      fetch("https://api.cloudflare.com/client/v4/user/tokens/verify", { headers }),
      fetch("https://api.cloudflare.com/client/v4/accounts", { headers }),
    ]);

    const [userData, accountsData] = await Promise.all([
      userResponse.json() as Promise<CloudflareResponse>,
      accountsResponse.json() as Promise<CloudflareResponse<Account[]>>,
    ]);

    // User token is valid
    if (userData.success) {
      return { valid: true };
    }

    // Try account token path
    if (!accountsData.success || !accountsData.result?.length) {
      const errorMsg = userData.errors?.map(e => e.message).join(", ") || "Invalid token";
      return { valid: false, error: errorMsg };
    }

    if (accountsData.result.length > 1) {
      return { valid: false, error: "Token has access to multiple accounts - use a single-account token" };
    }

    // /accounts succeeded, token is valid - use the account ID
    return { valid: true, accountId: accountsData.result[0].id };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return { valid: false, error: `Failed to verify token: ${message}` };
  }
}

function extractToken(authHeader: string): string | null {
  const match = authHeader.match(/Bearer\s+(\S+)/);
  return match ? match[1] : null;
}

function jsonError(message: string, status: number = 401): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isLocalhostHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "0.0.0.0";
}

function getApiTokenFromEnv(env: Env): string | null {
  // CLOUDFLARE_API_TOKEN is commonly provided via .env in local dev, but may not
  // be present in generated Wrangler types, so we access it safely.
  const token = (env as unknown as Record<string, unknown>)["CLOUDFLARE_API_TOKEN"];
  return typeof token === "string" && token.length > 0 ? token : null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { hostname } = new URL(request.url);
    const authHeader = request.headers.get("Authorization");

    // Try to get token from header first, then fall back to env on localhost
    let token: string | null = null;
    if (authHeader) {
      token = extractToken(authHeader);
      if (!token) {
        return jsonError("Invalid Authorization header format");
      }
    } else if (isLocalhostHostname(hostname)) {
      token = getApiTokenFromEnv(env);
    }

    if (!token) {
      return jsonError("Authorization header required");
    }

    const verification = await verifyToken(token);
    if (!verification.valid) {
      return jsonError(verification.error || "Token verification failed");
    }

    const server = createServer(env, token, verification.accountId);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
      // Help clients reconnect gracefully after SSE stream closes
      retryInterval: 1000,
    });

    await server.connect(transport);
    const response = await transport.handleRequest(request);
    ctx.waitUntil(transport.close());

    return response;
  },
};
