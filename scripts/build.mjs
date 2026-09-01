#!/usr/bin/env bun
/**
 * Build script for episodic-memory plugin
 * Bundles the MCP server and CLI into standalone files using Bun.build
 */

import { mkdir, writeFile, chmod } from "fs/promises";
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
  await mkdir("bin", { recursive: true });

  try {
    await buildEntry("src/cli/main.ts", "dist/cli-internal.mjs");
    await buildEntry("src/mcp/server.ts", "dist/mcp-server.mjs");

    // bin/episodic-memory = graceful wrapper executable (bun shebang).
    const graceful = await Bun.file(join("src", "cli-graceful.mjs")).text();
    await writeFile(join("bin", "episodic-memory"), graceful);
    await chmod(join("bin", "episodic-memory"), 0o755);
    console.log("✓ Built bin/episodic-memory (graceful executable)");

    console.log("\n✅ Build complete!");
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

buildCli();
