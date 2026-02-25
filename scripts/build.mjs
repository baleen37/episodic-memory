#!/usr/bin/env bun
/**
 * Build script for memmem plugin
 * Bundles the MCP server and CLI into standalone files using Bun.build
 */

import { mkdir, copyFile, writeFile } from "fs/promises";
import { join } from "path";

const commonConfig = {
  target: "node",
  format: "esm",
  sourcemap: "none",
  minify: false,
  external: [
    "@huggingface/transformers",
    "bun:sqlite",
    "sharp",
    "onnxruntime-node",
    "sqlite-vec",
  ],
};

async function buildEntry(entrypoint, outfile) {
  const result = await Bun.build({
    ...commonConfig,
    entrypoints: [entrypoint],
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`Failed to build ${outfile}`);
  }

  let built = await result.outputs[0].text();
  if (!built.startsWith("#!/usr/bin/env node")) {
    built = `#!/usr/bin/env node\n${built}`;
  }
  await writeFile(outfile, built);

  console.log(`✓ Built ${outfile}`);
}

async function buildCli() {
  await mkdir("dist", { recursive: true });

  try {
    await buildEntry("src/cli/main.ts", "dist/cli-internal.mjs");
    await buildEntry("src/mcp/server.ts", "dist/mcp-server.mjs");
    await buildEntry("src/mcp/embedding-worker.ts", "dist/embedding-worker.mjs");

    await copyFile(join("src", "cli-graceful.mjs"), join("dist", "cli.mjs"));
    console.log("✓ Copied dist/cli.mjs (graceful wrapper)");

    await mkdir("dist/lib", { recursive: true });
    await copyFile(
      join("scripts", "mcp-server-wrapper.mjs"),
      join("dist", "mcp-wrapper.mjs")
    );
    console.log("✓ Copied dist/mcp-wrapper.mjs");

    await copyFile(
      join("scripts", "lib", "check-dependencies.mjs"),
      join("dist", "lib", "check-dependencies.mjs")
    );
    console.log("✓ Copied dist/lib/check-dependencies.mjs");

    console.log("\n✅ Build complete!");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

buildCli();
