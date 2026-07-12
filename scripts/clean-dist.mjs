import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(root, "dist");

if (!dist.startsWith(`${root}/`)) {
  throw new Error("Refusing to clean outside the project root.");
}

rmSync(dist, { recursive: true, force: true });
