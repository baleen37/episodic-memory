#!/usr/bin/env node
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};

// src/core/llm/config.ts
import { existsSync, readFileSync } from "fs";
import { join } from "path";
function loadConfig() {
  const configDir = join(process.env.HOME ?? "", ".config", "memmem");
  const configPath = join(configDir, "config.json");
  if (!existsSync(configPath)) {
    return null;
  }
  try {
    const configContent = readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent);
    if (!config.provider || !config.apiKey) {
      console.warn("Invalid config: missing provider or apiKey field");
      return null;
    }
    if (config.provider !== "gemini" && config.provider !== "zai") {
      console.warn(`Invalid config: unknown provider "${config.provider}"`);
      return null;
    }
    return config;
  } catch (error) {
    console.warn(
      `Failed to load config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}
var init_config = __esm({
  "src/core/llm/config.ts"() {
    "use strict";
  }
});

// src/core/ratelimiter.ts
function getEmbeddingRateLimiter() {
  if (!embeddingLimiter) {
    const config = loadConfig();
    const ratelimitConfig = config?.ratelimit?.embedding;
    const rps = ratelimitConfig?.requestsPerSecond ?? DEFAULT_EMBEDDING_RPS;
    embeddingLimiter = new RateLimiter({
      requestsPerSecond: rps,
      burstSize: ratelimitConfig?.burstSize ?? 1
    });
  }
  return embeddingLimiter;
}
var DEFAULT_EMBEDDING_RPS, RateLimiter, embeddingLimiter;
var init_ratelimiter = __esm({
  "src/core/ratelimiter.ts"() {
    "use strict";
    init_config();
    DEFAULT_EMBEDDING_RPS = 0.5;
    RateLimiter = class {
      tokens;
      maxTokens;
      refillRate;
      // tokens per millisecond
      lastRefill;
      queue = [];
      /**
       * Creates a new RateLimiter instance.
       *
       * @param config - Configuration options
       */
      constructor(config = {}) {
        const rps = config.requestsPerSecond ?? DEFAULT_EMBEDDING_RPS;
        this.maxTokens = config.burstSize ?? 1;
        this.tokens = this.maxTokens;
        this.refillRate = rps / 1e3;
        this.lastRefill = Date.now();
      }
      /**
       * Refills tokens based on elapsed time.
       * Called internally before token operations.
       */
      refill() {
        const now = Date.now();
        const elapsed = now - this.lastRefill;
        if (elapsed > 0) {
          const newTokens = elapsed * this.refillRate;
          this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
          this.lastRefill = now;
        }
      }
      /**
       * Acquires a token, waiting if necessary.
       *
       * @returns Promise that resolves when a token is available
       */
      acquire() {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          this.queue.push(resolve);
          this.scheduleQueueProcessing();
        });
      }
      /**
       * Schedules processing of the queue if not already scheduled.
       */
      scheduleQueueProcessing() {
        const tokensNeeded = 1 - this.tokens;
        const waitMs = Math.ceil(tokensNeeded / this.refillRate);
        setTimeout(() => {
          this.processQueue();
        }, waitMs);
      }
      /**
       * Tries to acquire a token without waiting.
       *
       * @returns true if token was acquired, false if rate limited
       */
      tryAcquire() {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return true;
        }
        return false;
      }
      /**
       * Gets the current number of available tokens.
       *
       * @returns Number of tokens available (may be fractional)
       */
      getAvailableTokens() {
        this.refill();
        return Math.floor(this.tokens);
      }
      /**
       * Processes queued requests if tokens are available.
       */
      processQueue() {
        this.refill();
        while (this.queue.length > 0 && this.tokens >= 1) {
          const next = this.queue.shift();
          if (next) {
            this.tokens -= 1;
            next();
          }
        }
        if (this.queue.length > 0) {
          this.scheduleQueueProcessing();
        }
      }
    };
    embeddingLimiter = null;
  }
});

// src/core/paths.ts
import os from "os";
import path from "path";
import fs from "fs";
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
function getSuperpowersDir() {
  let dir;
  if (process.env.CONVERSATION_MEMORY_CONFIG_DIR) {
    dir = process.env.CONVERSATION_MEMORY_CONFIG_DIR;
  } else if (process.env.MEMMEM_CONFIG_DIR) {
    dir = process.env.MEMMEM_CONFIG_DIR;
  } else {
    dir = path.join(os.homedir(), ".config", "memmem");
  }
  return ensureDir(dir);
}
var init_paths = __esm({
  "src/core/paths.ts"() {
    "use strict";
  }
});

// src/mcp/embedding-worker.ts
import net from "net";
import path2 from "path";
import fs2 from "fs";

// src/core/embeddings-model.ts
import { pipeline, env } from "@huggingface/transformers";
var embeddingPipeline = null;
async function initModel() {
  if (!embeddingPipeline) {
    console.log("Loading embedding model (first run may take time)...");
    env.cacheDir = "./.cache";
    embeddingPipeline = await pipeline(
      "feature-extraction",
      "Supabase/gte-small",
      { dtype: "fp16" }
    );
    console.log("Embedding model loaded");
  }
}
async function generateEmbeddingFromModel(text) {
  if (!embeddingPipeline) {
    await initModel();
  }
  if (!embeddingPipeline) return null;
  const truncated = text.substring(0, 8e3);
  const output = await embeddingPipeline(truncated, {
    pooling: "mean",
    normalize: true
  });
  return Array.from(output.data);
}

// src/mcp/embedding-worker.ts
init_ratelimiter();
init_paths();
var IDLE_TIMEOUT_MS = 6e4;
function getSocketPath() {
  return path2.join(getSuperpowersDir(), "embedding-worker.sock");
}
function isSocketAlive(sockPath) {
  return new Promise((resolve) => {
    const client = net.createConnection(sockPath);
    client.once("connect", () => {
      client.destroy();
      resolve(true);
    });
    client.once("error", () => resolve(false));
    setTimeout(() => {
      client.destroy();
      resolve(false);
    }, 500);
  });
}
async function startWorker(sockPath) {
  if (await isSocketAlive(sockPath)) return null;
  if (fs2.existsSync(sockPath)) fs2.unlinkSync(sockPath);
  fs2.mkdirSync(path2.dirname(sockPath), { recursive: true });
  await initModel();
  let activeConnections = 0;
  let idleTimer = null;
  function resetIdleTimer(server2) {
    if (idleTimer) clearTimeout(idleTimer);
    if (activeConnections === 0) {
      idleTimer = setTimeout(() => {
        server2.close();
        if (fs2.existsSync(sockPath)) fs2.unlinkSync(sockPath);
        process.exit(0);
      }, IDLE_TIMEOUT_MS);
    }
  }
  const server = net.createServer((socket) => {
    activeConnections++;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    let buffer = "";
    socket.on("data", async (chunk) => {
      buffer += chunk.toString();
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let reqId = "unknown";
        try {
          const req = JSON.parse(line);
          reqId = req.id ?? "unknown";
          if (!req.id || typeof req.text !== "string") throw new Error("invalid request");
          await getEmbeddingRateLimiter().acquire();
          const embedding = await generateEmbeddingFromModel(req.text);
          const resp = embedding ? { id: req.id, embedding } : { id: req.id, error: "embedding returned null" };
          socket.write(JSON.stringify(resp) + "\n");
        } catch (err) {
          socket.write(JSON.stringify({
            id: reqId,
            error: err instanceof Error ? err.message : String(err)
          }) + "\n");
        }
      }
    });
    const cleanup = () => {
      activeConnections = Math.max(0, activeConnections - 1);
      resetIdleTimer(server);
    };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
  });
  return new Promise((resolve, reject) => {
    server.listen(sockPath, () => {
      resetIdleTimer(server);
      resolve(server);
    });
    server.once("error", reject);
  });
}
function shouldRunAsEntrypoint() {
  return process.env.VITEST !== "true";
}
if (shouldRunAsEntrypoint()) {
  const sockPath = getSocketPath();
  startWorker(sockPath).then((server) => {
    if (server === null) process.exit(0);
    process.stdin.unref?.();
  }).catch((err) => {
    console.error("embedding-worker startup failed:", err);
    process.exit(1);
  });
}
export {
  getSocketPath,
  startWorker
};
