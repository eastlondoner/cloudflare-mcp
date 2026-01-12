import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createCodeExecutor } from "./executor";
import { truncateResponse } from "./truncate";
import { ENDPOINT_SUMMARY } from "./data/types.generated";

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

async function generateCode(
  openaiApiKey: string,
  request: string,
  accountId: string
): Promise<string> {
  const openai = createOpenAI({ apiKey: openaiApiKey });

  const response = await generateText({
    model: openai("gpt-4o-mini"),
    prompt: `You are a code generating machine. Generate JavaScript code to achieve the user's goal using the Cloudflare API.

<available_types>
${CLOUDFLARE_TYPES}
</available_types>

<available_endpoints>
${ENDPOINT_SUMMARY}
</available_endpoints>

The account ID to use is: ${accountId}

IMPORTANT RULES:
1. Output ONLY the async function, nothing else
2. The function must be an async arrow function: async () => { ... }
3. Use the \`cloudflare\` object to make API requests
4. Use the \`accountId\` variable when needed in paths (it's already defined)
5. Return the result at the end
6. Do not include markdown code blocks or explanations

Example format:
async () => {
  const response = await cloudflare.request({
    method: "GET",
    path: \`/accounts/\${accountId}/workers/scripts\`
  });
  return response.result;
}

USER REQUEST: ${request}`,
  });

  let code = response.text.trim();

  if (code.startsWith("```")) {
    code = code.replace(/^```(?:javascript|js)?\n?/, "").replace(/\n?```$/, "");
  }

  return code.trim();
}

export function createAgentServer(env: Env): McpServer {
  const server = new McpServer({
    name: "cloudflare-api-agent",
    version: "0.1.0",
  });

  const executeCode = createCodeExecutor(env);
  const openaiApiKey = (env as unknown as Record<string, string>).OPENAI_API_KEY;

  server.registerTool(
    "use_cloudflare",
    {
      description: `Execute operations on the Cloudflare API. Describe what you want to do in natural language and provide your account ID.

Examples:
- "List all my zones"
- "Get all DNS records for zone xyz123"
- "List my Workers scripts"
- "Create a KV namespace called 'my-cache'"
- "Get my account details"
- "List all D1 databases"`,
      inputSchema: {
        request: z.string().describe("Natural language description of what you want to do with the Cloudflare API"),
        account_id: z.string().describe("Your Cloudflare account ID (run `npx wrangler whoami` to see available accounts)"),
      },
    },
    async ({ request, account_id }) => {
      try {
        if (!openaiApiKey) {
          throw new Error("OPENAI_API_KEY secret is not set");
        }

        const code = await generateCode(openaiApiKey, request, account_id);
        const result = await executeCode(code, account_id);

        return {
          content: [
            { type: "text", text: truncateResponse(result) },
          ],
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
