import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packageJsonPath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };

if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
  throw new Error("package.json precisa conter uma versao valida.");
}

export const MCP_SERVER_VERSION = packageJson.version.trim();
