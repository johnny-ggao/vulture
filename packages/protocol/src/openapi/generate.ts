import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildOpenApiV1 } from "./v1";

const outputPath = resolve(import.meta.dir, "../../openapi/v1.json");

async function main() {
  const check = process.argv.includes("--check");
  const content = `${JSON.stringify(buildOpenApiV1(), null, 2)}\n`;

  if (check) {
    const existing = await readFile(outputPath, "utf8").catch(() => null);
    if (existing !== content) {
      console.error(`OpenAPI output is stale: ${outputPath}`);
      console.error("Run: bun run protocol:openapi");
      process.exit(1);
    }
    return;
  }

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, content);
}

await main();
