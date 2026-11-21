// Render builds from the repo root's checkout, so ../shared normally exists. Copy it next to the worker so
// the compiled service also runs when only app/worker is deployed as the root directory.
import { cpSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "shared");
const dst = join(here, "..", "shared");
if (existsSync(src)) {
  cpSync(src, dst, { recursive: true });
  console.log("copied app/shared ->", dst);
} else if (!existsSync(dst)) {
  console.error("app/shared not found and no ./shared copy present");
  process.exit(1);
}
