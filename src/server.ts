import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createCodeExecutor, createSearchExecutor } from "./executor";
import { truncateResponse } from "./truncate";
import { PRODUCTS } from "./data/products";

const CLOUDFLARE_TYPES = `
interface CloudflareRequestOptions {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

interface CloudflareResponse<T = unknown> {
  success: boolean;
  result: T;
  errors: Array<{ code: number; message: string }>;
  messages: Array<{ code: number; message: string }>;
  result_info?: {
    page: number;
    per_page: number;
    total_pages: number;
    count: number;
    total_count: number;
  };
}

declare const cloudflare: {
  request<T = unknown>(options: CloudflareRequestOptions): Promise<CloudflareResponse<T>>;
};

declare const accountId: string;
`;

const SPEC_TYPES = `
interface OperationInfo {
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<{
    name: string;
    in: "path" | "query" | "header";
    required?: boolean;
    schema?: { type?: string; enum?: string[] };
    description?: string;
  }>;
  requestBody?: {
    required?: boolean;
    content?: Record<string, { schema?: unknown }>;
  };
}

interface PathItem {
  get?: OperationInfo;
  post?: OperationInfo;
  put?: OperationInfo;
  patch?: OperationInfo;
  delete?: OperationInfo;
}

declare const spec: {
  paths: Record<string, PathItem>;
};
`;

export function createServer(env: Env): McpServer {
  const server = new McpServer({
    name: "cloudflare-api",
    version: "0.1.0",
  });

  const executeCode = createCodeExecutor(env);
  const executeSearch = createSearchExecutor(env);

  server.registerTool(
    "search",
    {
      description: `Search the Cloudflare OpenAPI spec by writing JavaScript code. You have access to 'spec.paths' which contains all API endpoints.

Products: ${PRODUCTS.slice(0, 30).join(", ")}... (${PRODUCTS.length} total)

Types:
${SPEC_TYPES}

Your code must be an async arrow function that returns the search results.

Example - find endpoints by product (product is first tag):
async () => {
  const results = [];
  for (const [path, methods] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      if (op.tags?.some(t => t.toLowerCase() === 'workers')) {
        results.push({ method: method.toUpperCase(), path, summary: op.summary });
      }
    }
  }
  return results;
}

Example - get endpoint details:
async () => {
  return spec.paths['/accounts/{account_id}/workers/scripts'];
}`,
      inputSchema: {
        code: z.string().describe("JavaScript async arrow function to search the OpenAPI spec"),
      },
    },
    async ({ code }) => {
      try {
        const result = await executeSearch(code);
        return {
          content: [{ type: "text", text: truncateResponse(result) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "execute",
    {
      description: `Execute JavaScript code against the Cloudflare API. First use the 'search' tool to find the right endpoints, then write code using the cloudflare.request() function.

Available in your code:
${CLOUDFLARE_TYPES}

Your code must be an async arrow function that returns the result.

Example:
async () => {
  const response = await cloudflare.request({
    method: "GET",
    path: \`/accounts/\${accountId}/workers/scripts\`
  });
  return response.result;
}`,
      inputSchema: {
        code: z.string().describe("JavaScript async arrow function to execute"),
        account_id: z.string().describe("Your Cloudflare account ID (run `npx wrangler whoami` to see available accounts)"),
      },
    },
    async ({ code, account_id }) => {
      try {
        const result = await executeCode(code, account_id);
        return {
          content: [{ type: "text", text: truncateResponse(result) }],
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Error: ${errorMessage}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}
