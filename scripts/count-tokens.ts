import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function countTokens() {
  // Read the generated types file
  const typesPath = join(__dirname, "../src/data/types.generated.ts");
  const typesContent = await readFile(typesPath, "utf-8");

  // Extract just the ENDPOINT_SUMMARY string (it's a JSON-escaped string)
  const match = typesContent.match(/export const ENDPOINT_SUMMARY = "([\s\S]*?)";?\s*$/m);
  let endpointSummary = "";
  if (match) {
    // Unescape the JSON string
    try {
      endpointSummary = JSON.parse(`"${match[1]}"`);
    } catch {
      endpointSummary = match[1];
    }
  }

  // Also get the full types file size
  const typesFileSize = typesContent.length;

  // Also fetch the full OpenAPI spec for comparison
  const specUrl = "https://raw.githubusercontent.com/cloudflare/api-schemas/main/openapi.json";
  const response = await fetch(specUrl);
  const fullSpec = await response.text();

  // Token estimation methods
  // 1. GPT-style: ~4 chars per token (rough estimate)
  // 2. Word-based: ~0.75 words per token
  // 3. Whitespace split for more accurate word count

  function estimateTokens(text: string) {
    const chars = text.length;
    const words = text.split(/\s+/).filter(Boolean).length;
    const lines = text.split("\n").length;

    return {
      chars,
      words,
      lines,
      // Different estimation methods
      tokensCharBased: Math.ceil(chars / 4),
      tokensWordBased: Math.ceil(words / 0.75),
      // cl100k_base (GPT-4) averages ~4 chars/token for code
      tokensEstimate: Math.ceil(chars / 3.5), // slightly more conservative for code/JSON
    };
  }

  console.log("=== Token Count Analysis ===\n");

  console.log("📄 ENDPOINT_SUMMARY (what we send to the model):");
  const summaryStats = estimateTokens(endpointSummary);
  console.log(`   Characters: ${summaryStats.chars.toLocaleString()}`);
  console.log(`   Words: ${summaryStats.words.toLocaleString()}`);
  console.log(`   Lines: ${summaryStats.lines.toLocaleString()}`);
  console.log(`   Estimated tokens: ~${summaryStats.tokensEstimate.toLocaleString()}`);

  console.log("\n📁 types.generated.ts (full file we bundle):");
  const typesStats = estimateTokens(typesContent);
  console.log(`   Characters: ${typesStats.chars.toLocaleString()}`);
  console.log(`   Estimated tokens: ~${typesStats.tokensEstimate.toLocaleString()}`);

  console.log("\n📦 Full OpenAPI Spec (if we included everything):");
  const fullStats = estimateTokens(fullSpec);
  console.log(`   Characters: ${fullStats.chars.toLocaleString()}`);
  console.log(`   Words: ${fullStats.words.toLocaleString()}`);
  console.log(`   Lines: ${fullStats.lines.toLocaleString()}`);
  console.log(`   Estimated tokens: ~${fullStats.tokensEstimate.toLocaleString()}`);

  console.log("\n📊 Comparison:");
  const reduction = ((1 - summaryStats.chars / fullStats.chars) * 100).toFixed(1);
  console.log(`   Summary vs full spec reduction: ${reduction}%`);
  console.log(`   Full spec is ${(fullStats.chars / summaryStats.chars).toFixed(1)}x larger than summary`);

  // Parse spec to count endpoints
  const spec = JSON.parse(fullSpec);
  let endpointCount = 0;
  for (const path of Object.values(spec.paths || {})) {
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if ((path as Record<string, unknown>)[method]) endpointCount++;
    }
  }
  console.log(`\n📍 Total endpoints in spec: ${endpointCount.toLocaleString()}`);

  // v2 analysis - spec.json for code-based search
  const specJsonPath = join(__dirname, "../src/data/spec.json");
  let specJsonSize = 0;
  try {
    const specJsonContent = await readFile(specJsonPath, "utf-8");
    specJsonSize = specJsonContent.length;
  } catch {
    // File might not exist yet
  }

  console.log("\n🔍 v2 Search + Execute approach:");
  console.log("   spec.json (bundled for search): " + (specJsonSize / 1024).toFixed(0) + " KB");
  console.log("   AI writes code to query spec.paths object");
  console.log("   Search results: only what AI code returns");
  console.log("   No endpoint summary sent to model (0 tokens)");
}

countTokens().catch(console.error);
