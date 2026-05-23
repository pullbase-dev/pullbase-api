import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import esbuildPluginPino from "esbuild-plugin-pino";
import { rm } from "node:fs/promises";

globalThis.require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function buildAll() {
  const distDir = path.resolve(__dirname, "dist");
  await rm(distDir, { recursive: true, force: true });

  await esbuild({
    entryPoints: [path.resolve(__dirname, "src/index.ts")],
    platform: "node",
    bundle: true,
    format: "esm",
    outdir: distDir,
    outExtension: { ".js": ".mjs" },
    logLevel: "info",
    alias: {
      "@pullbase/db": path.resolve(__dirname, "src/lib/db/index.ts"),
      "@pullbase/api-zod": path.resolve(__dirname, "src/lib/api-zod/index.ts"),
      "@pullbase/openai-server": path.resolve(__dirname, "src/lib/openai-server/index.ts"),
      "@pullbase/openai-server/image": path.resolve(__dirname, "src/lib/openai-server/image/index.ts"),
      "@pullbase/openai-server/batch": path.resolve(__dirname, "src/lib/openai-server/batch/index.ts"),
      "@pullbase/openai-server/audio": path.resolve(__dirname, "src/lib/openai-server/audio/index.ts"),
    },
    external: [
      "*.node","sharp","better-sqlite3","sqlite3","canvas","bcrypt","argon2",
      "fsevents","re2","pg-native","bufferutil","utf-8-validate"
    ],
    sourcemap: "linked",
    plugins: [esbuildPluginPino({ transports: ["pino-pretty"] })],
    banner: {
      js: `import { createRequire as __cr } from 'node:module';
import __path from 'node:path';
import __url from 'node:url';
globalThis.require = __cr(import.meta.url);
globalThis.__filename = __url.fileURLToPath(import.meta.url);
globalThis.__dirname = __path.dirname(globalThis.__filename);`
    },
  });
}

buildAll().catch((err) => { console.error(err); process.exit(1); });
