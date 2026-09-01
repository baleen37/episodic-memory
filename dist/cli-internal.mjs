#!/usr/bin/env node
import { createRequire } from "node:module";
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

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
  } else if (process.env.EPISODIC_MEMORY_CONFIG_DIR) {
    dir = process.env.EPISODIC_MEMORY_CONFIG_DIR;
  } else {
    dir = path.join(os.homedir(), ".config", "episodic-memory");
  }
  return ensureDir(dir);
}
function getArchiveDir() {
  if (process.env.TEST_ARCHIVE_DIR) {
    return ensureDir(process.env.TEST_ARCHIVE_DIR);
  }
  return ensureDir(path.join(getSuperpowersDir(), "conversation-archive"));
}
function getIndexDir() {
  return ensureDir(path.join(getSuperpowersDir(), "conversation-index"));
}
function getDbPath() {
  if (process.env.CONVERSATION_MEMORY_DB_PATH) {
    return process.env.CONVERSATION_MEMORY_DB_PATH;
  }
  if (process.env.EPISODIC_MEMORY_DB_PATH || process.env.TEST_DB_PATH) {
    return process.env.EPISODIC_MEMORY_DB_PATH || process.env.TEST_DB_PATH;
  }
  return path.join(getIndexDir(), "conversations.db");
}
function getModelCacheDir() {
  return ensureDir(path.join(getSuperpowersDir(), "models"));
}
function getLogDir() {
  return ensureDir(path.join(getSuperpowersDir(), "logs"));
}
function getLogFilePath() {
  const date = new Date().toISOString().split("T")[0];
  return path.join(getLogDir(), `${date}.log`);
}
var init_paths = () => {};

// src/core/logger.ts
import { appendFileSync, readdirSync as readdirSync3, unlinkSync } from "fs";
import { join as join5 } from "path";
function getThreshold() {
  const raw = (process.env.EPISODIC_MEMORY_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "silent")
    return -1;
  return LEVELS[raw] ?? LEVELS["info"];
}
function scheduleFlush() {
  if (flushTimer !== null)
    return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushLogBuffer();
  }, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}
function pruneOldLogs() {
  const dir = getLogDir();
  const today = new Date;
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const cutoff = todayUtc - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let entries;
  try {
    entries = readdirSync3(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const match = name.match(/^(\d{4})-(\d{2})-(\d{2})\.log$/);
    if (!match)
      continue;
    const fileTime = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    if (fileTime < cutoff) {
      try {
        unlinkSync(join5(dir, name));
      } catch {}
    }
  }
}
function flushLogBuffer(force = false) {
  if (buffer.length === 0)
    return;
  if (false) {}
  if (!retentionDone) {
    retentionDone = true;
    pruneOldLogs();
  }
  const lines = buffer.join("");
  buffer = [];
  try {
    appendFileSync(getLogFilePath(), lines);
  } catch {}
}
function bufferLine(line) {
  buffer.push(line);
  if (buffer.length >= FLUSH_LINE_THRESHOLD) {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    flushLogBuffer();
  } else {
    scheduleFlush();
  }
}
function emit(level, msg, meta) {
  if (getThreshold() < LEVELS[level])
    return;
  const ts = new Date().toISOString();
  const line = meta !== undefined ? `[${ts}] ${level.toUpperCase()} ${msg} ${JSON.stringify(meta)}
` : `[${ts}] ${level.toUpperCase()} ${msg}
`;
  process.stderr.write(line);
  bufferLine(line);
}
function registerExitHooks() {
  if (exitHooksRegistered)
    return;
  exitHooksRegistered = true;
  process.on("exit", () => flushLogBuffer());
  process.on("SIGINT", () => {
    flushLogBuffer();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    flushLogBuffer();
    process.exit(143);
  });
}
function logInfo(message, data) {
  log.info(message, data);
}
function logError(message, error, data) {
  const errorMeta = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error !== undefined ? { error } : undefined;
  const combined = errorMeta ? { ...data ?? {}, ...errorMeta } : data;
  log.error(message, combined);
}
function logDebug(message, data) {
  log.debug(message, data);
}
var LEVELS, FLUSH_LINE_THRESHOLD = 64, buffer, FLUSH_INTERVAL_MS = 1000, flushTimer = null, RETENTION_DAYS = 14, retentionDone = false, log, exitHooksRegistered = false;
var init_logger = __esm(() => {
  init_paths();
  LEVELS = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3
  };
  buffer = [];
  log = {
    error: (msg, meta) => emit("error", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    debug: (msg, meta) => emit("debug", msg, meta)
  };
  registerExitHooks();
});

// src/core/llm/round-robin-provider.ts
var exports_round_robin_provider = {};
__export(exports_round_robin_provider, {
  RoundRobinProvider: () => RoundRobinProvider
});

class RoundRobinProvider {
  providers;
  cursor = 0;
  constructor(providers) {
    if (providers.length === 0) {
      throw new Error("RoundRobinProvider requires at least one provider");
    }
    this.providers = providers;
  }
  async complete(prompt, options) {
    let lastError;
    for (let i = 0;i < this.providers.length; i++) {
      const provider = this.providers[this.cursor];
      this.cursor = (this.cursor + 1) % this.providers.length;
      try {
        return await provider.complete(prompt, options);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

// node_modules/@google/generative-ai/dist/index.mjs
class RequestUrl {
  constructor(model, task, apiKey, stream, requestOptions) {
    this.model = model;
    this.task = task;
    this.apiKey = apiKey;
    this.stream = stream;
    this.requestOptions = requestOptions;
  }
  toString() {
    var _a, _b;
    const apiVersion = ((_a = this.requestOptions) === null || _a === undefined ? undefined : _a.apiVersion) || DEFAULT_API_VERSION;
    const baseUrl = ((_b = this.requestOptions) === null || _b === undefined ? undefined : _b.baseUrl) || DEFAULT_BASE_URL;
    let url = `${baseUrl}/${apiVersion}/${this.model}:${this.task}`;
    if (this.stream) {
      url += "?alt=sse";
    }
    return url;
  }
}
function getClientHeaders(requestOptions) {
  const clientHeaders = [];
  if (requestOptions === null || requestOptions === undefined ? undefined : requestOptions.apiClient) {
    clientHeaders.push(requestOptions.apiClient);
  }
  clientHeaders.push(`${PACKAGE_LOG_HEADER}/${PACKAGE_VERSION}`);
  return clientHeaders.join(" ");
}
async function getHeaders(url) {
  var _a;
  const headers = new Headers;
  headers.append("Content-Type", "application/json");
  headers.append("x-goog-api-client", getClientHeaders(url.requestOptions));
  headers.append("x-goog-api-key", url.apiKey);
  let customHeaders = (_a = url.requestOptions) === null || _a === undefined ? undefined : _a.customHeaders;
  if (customHeaders) {
    if (!(customHeaders instanceof Headers)) {
      try {
        customHeaders = new Headers(customHeaders);
      } catch (e) {
        throw new GoogleGenerativeAIRequestInputError(`unable to convert customHeaders value ${JSON.stringify(customHeaders)} to Headers: ${e.message}`);
      }
    }
    for (const [headerName, headerValue] of customHeaders.entries()) {
      if (headerName === "x-goog-api-key") {
        throw new GoogleGenerativeAIRequestInputError(`Cannot set reserved header name ${headerName}`);
      } else if (headerName === "x-goog-api-client") {
        throw new GoogleGenerativeAIRequestInputError(`Header name ${headerName} can only be set using the apiClient field`);
      }
      headers.append(headerName, headerValue);
    }
  }
  return headers;
}
async function constructModelRequest(model, task, apiKey, stream, body, requestOptions) {
  const url = new RequestUrl(model, task, apiKey, stream, requestOptions);
  return {
    url: url.toString(),
    fetchOptions: Object.assign(Object.assign({}, buildFetchOptions(requestOptions)), { method: "POST", headers: await getHeaders(url), body })
  };
}
async function makeModelRequest(model, task, apiKey, stream, body, requestOptions = {}, fetchFn = fetch) {
  const { url, fetchOptions } = await constructModelRequest(model, task, apiKey, stream, body, requestOptions);
  return makeRequest(url, fetchOptions, fetchFn);
}
async function makeRequest(url, fetchOptions, fetchFn = fetch) {
  let response;
  try {
    response = await fetchFn(url, fetchOptions);
  } catch (e) {
    handleResponseError(e, url);
  }
  if (!response.ok) {
    await handleResponseNotOk(response, url);
  }
  return response;
}
function handleResponseError(e, url) {
  let err = e;
  if (err.name === "AbortError") {
    err = new GoogleGenerativeAIAbortError(`Request aborted when fetching ${url.toString()}: ${e.message}`);
    err.stack = e.stack;
  } else if (!(e instanceof GoogleGenerativeAIFetchError || e instanceof GoogleGenerativeAIRequestInputError)) {
    err = new GoogleGenerativeAIError(`Error fetching from ${url.toString()}: ${e.message}`);
    err.stack = e.stack;
  }
  throw err;
}
async function handleResponseNotOk(response, url) {
  let message = "";
  let errorDetails;
  try {
    const json = await response.json();
    message = json.error.message;
    if (json.error.details) {
      message += ` ${JSON.stringify(json.error.details)}`;
      errorDetails = json.error.details;
    }
  } catch (e) {}
  throw new GoogleGenerativeAIFetchError(`Error fetching from ${url.toString()}: [${response.status} ${response.statusText}] ${message}`, response.status, response.statusText, errorDetails);
}
function buildFetchOptions(requestOptions) {
  const fetchOptions = {};
  if ((requestOptions === null || requestOptions === undefined ? undefined : requestOptions.signal) !== undefined || (requestOptions === null || requestOptions === undefined ? undefined : requestOptions.timeout) >= 0) {
    const controller = new AbortController;
    if ((requestOptions === null || requestOptions === undefined ? undefined : requestOptions.timeout) >= 0) {
      setTimeout(() => controller.abort(), requestOptions.timeout);
    }
    if (requestOptions === null || requestOptions === undefined ? undefined : requestOptions.signal) {
      requestOptions.signal.addEventListener("abort", () => {
        controller.abort();
      });
    }
    fetchOptions.signal = controller.signal;
  }
  return fetchOptions;
}
function addHelpers(response) {
  response.text = () => {
    if (response.candidates && response.candidates.length > 0) {
      if (response.candidates.length > 1) {
        console.warn(`This response had ${response.candidates.length} ` + `candidates. Returning text from the first candidate only. ` + `Access response.candidates directly to use the other candidates.`);
      }
      if (hadBadFinishReason(response.candidates[0])) {
        throw new GoogleGenerativeAIResponseError(`${formatBlockErrorMessage(response)}`, response);
      }
      return getText(response);
    } else if (response.promptFeedback) {
      throw new GoogleGenerativeAIResponseError(`Text not available. ${formatBlockErrorMessage(response)}`, response);
    }
    return "";
  };
  response.functionCall = () => {
    if (response.candidates && response.candidates.length > 0) {
      if (response.candidates.length > 1) {
        console.warn(`This response had ${response.candidates.length} ` + `candidates. Returning function calls from the first candidate only. ` + `Access response.candidates directly to use the other candidates.`);
      }
      if (hadBadFinishReason(response.candidates[0])) {
        throw new GoogleGenerativeAIResponseError(`${formatBlockErrorMessage(response)}`, response);
      }
      console.warn(`response.functionCall() is deprecated. ` + `Use response.functionCalls() instead.`);
      return getFunctionCalls(response)[0];
    } else if (response.promptFeedback) {
      throw new GoogleGenerativeAIResponseError(`Function call not available. ${formatBlockErrorMessage(response)}`, response);
    }
    return;
  };
  response.functionCalls = () => {
    if (response.candidates && response.candidates.length > 0) {
      if (response.candidates.length > 1) {
        console.warn(`This response had ${response.candidates.length} ` + `candidates. Returning function calls from the first candidate only. ` + `Access response.candidates directly to use the other candidates.`);
      }
      if (hadBadFinishReason(response.candidates[0])) {
        throw new GoogleGenerativeAIResponseError(`${formatBlockErrorMessage(response)}`, response);
      }
      return getFunctionCalls(response);
    } else if (response.promptFeedback) {
      throw new GoogleGenerativeAIResponseError(`Function call not available. ${formatBlockErrorMessage(response)}`, response);
    }
    return;
  };
  return response;
}
function getText(response) {
  var _a, _b, _c, _d;
  const textStrings = [];
  if ((_b = (_a = response.candidates) === null || _a === undefined ? undefined : _a[0].content) === null || _b === undefined ? undefined : _b.parts) {
    for (const part of (_d = (_c = response.candidates) === null || _c === undefined ? undefined : _c[0].content) === null || _d === undefined ? undefined : _d.parts) {
      if (part.text) {
        textStrings.push(part.text);
      }
      if (part.executableCode) {
        textStrings.push("\n```" + part.executableCode.language + `
` + part.executableCode.code + "\n```\n");
      }
      if (part.codeExecutionResult) {
        textStrings.push("\n```\n" + part.codeExecutionResult.output + "\n```\n");
      }
    }
  }
  if (textStrings.length > 0) {
    return textStrings.join("");
  } else {
    return "";
  }
}
function getFunctionCalls(response) {
  var _a, _b, _c, _d;
  const functionCalls = [];
  if ((_b = (_a = response.candidates) === null || _a === undefined ? undefined : _a[0].content) === null || _b === undefined ? undefined : _b.parts) {
    for (const part of (_d = (_c = response.candidates) === null || _c === undefined ? undefined : _c[0].content) === null || _d === undefined ? undefined : _d.parts) {
      if (part.functionCall) {
        functionCalls.push(part.functionCall);
      }
    }
  }
  if (functionCalls.length > 0) {
    return functionCalls;
  } else {
    return;
  }
}
function hadBadFinishReason(candidate) {
  return !!candidate.finishReason && badFinishReasons.includes(candidate.finishReason);
}
function formatBlockErrorMessage(response) {
  var _a, _b, _c;
  let message = "";
  if ((!response.candidates || response.candidates.length === 0) && response.promptFeedback) {
    message += "Response was blocked";
    if ((_a = response.promptFeedback) === null || _a === undefined ? undefined : _a.blockReason) {
      message += ` due to ${response.promptFeedback.blockReason}`;
    }
    if ((_b = response.promptFeedback) === null || _b === undefined ? undefined : _b.blockReasonMessage) {
      message += `: ${response.promptFeedback.blockReasonMessage}`;
    }
  } else if ((_c = response.candidates) === null || _c === undefined ? undefined : _c[0]) {
    const firstCandidate = response.candidates[0];
    if (hadBadFinishReason(firstCandidate)) {
      message += `Candidate was blocked due to ${firstCandidate.finishReason}`;
      if (firstCandidate.finishMessage) {
        message += `: ${firstCandidate.finishMessage}`;
      }
    }
  }
  return message;
}
function __await(v) {
  return this instanceof __await ? (this.v = v, this) : new __await(v);
}
function __asyncGenerator(thisArg, _arguments, generator) {
  if (!Symbol.asyncIterator)
    throw new TypeError("Symbol.asyncIterator is not defined.");
  var g = generator.apply(thisArg, _arguments || []), i, q = [];
  return i = {}, verb("next"), verb("throw"), verb("return"), i[Symbol.asyncIterator] = function() {
    return this;
  }, i;
  function verb(n) {
    if (g[n])
      i[n] = function(v) {
        return new Promise(function(a, b) {
          q.push([n, v, a, b]) > 1 || resume(n, v);
        });
      };
  }
  function resume(n, v) {
    try {
      step(g[n](v));
    } catch (e) {
      settle(q[0][3], e);
    }
  }
  function step(r) {
    r.value instanceof __await ? Promise.resolve(r.value.v).then(fulfill, reject) : settle(q[0][2], r);
  }
  function fulfill(value) {
    resume("next", value);
  }
  function reject(value) {
    resume("throw", value);
  }
  function settle(f, v) {
    if (f(v), q.shift(), q.length)
      resume(q[0][0], q[0][1]);
  }
}
function processStream(response) {
  const inputStream = response.body.pipeThrough(new TextDecoderStream("utf8", { fatal: true }));
  const responseStream = getResponseStream(inputStream);
  const [stream1, stream2] = responseStream.tee();
  return {
    stream: generateResponseSequence(stream1),
    response: getResponsePromise(stream2)
  };
}
async function getResponsePromise(stream) {
  const allResponses = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return addHelpers(aggregateResponses(allResponses));
    }
    allResponses.push(value);
  }
}
function generateResponseSequence(stream) {
  return __asyncGenerator(this, arguments, function* generateResponseSequence_1() {
    const reader = stream.getReader();
    while (true) {
      const { value, done } = yield __await(reader.read());
      if (done) {
        break;
      }
      yield yield __await(addHelpers(value));
    }
  });
}
function getResponseStream(inputStream) {
  const reader = inputStream.getReader();
  const stream = new ReadableStream({
    start(controller) {
      let currentText = "";
      return pump();
      function pump() {
        return reader.read().then(({ value, done }) => {
          if (done) {
            if (currentText.trim()) {
              controller.error(new GoogleGenerativeAIError("Failed to parse stream"));
              return;
            }
            controller.close();
            return;
          }
          currentText += value;
          let match = currentText.match(responseLineRE);
          let parsedResponse;
          while (match) {
            try {
              parsedResponse = JSON.parse(match[1]);
            } catch (e) {
              controller.error(new GoogleGenerativeAIError(`Error parsing JSON response: "${match[1]}"`));
              return;
            }
            controller.enqueue(parsedResponse);
            currentText = currentText.substring(match[0].length);
            match = currentText.match(responseLineRE);
          }
          return pump();
        }).catch((e) => {
          let err = e;
          err.stack = e.stack;
          if (err.name === "AbortError") {
            err = new GoogleGenerativeAIAbortError("Request aborted when reading from the stream");
          } else {
            err = new GoogleGenerativeAIError("Error reading from the stream");
          }
          throw err;
        });
      }
    }
  });
  return stream;
}
function aggregateResponses(responses) {
  const lastResponse = responses[responses.length - 1];
  const aggregatedResponse = {
    promptFeedback: lastResponse === null || lastResponse === undefined ? undefined : lastResponse.promptFeedback
  };
  for (const response of responses) {
    if (response.candidates) {
      let candidateIndex = 0;
      for (const candidate of response.candidates) {
        if (!aggregatedResponse.candidates) {
          aggregatedResponse.candidates = [];
        }
        if (!aggregatedResponse.candidates[candidateIndex]) {
          aggregatedResponse.candidates[candidateIndex] = {
            index: candidateIndex
          };
        }
        aggregatedResponse.candidates[candidateIndex].citationMetadata = candidate.citationMetadata;
        aggregatedResponse.candidates[candidateIndex].groundingMetadata = candidate.groundingMetadata;
        aggregatedResponse.candidates[candidateIndex].finishReason = candidate.finishReason;
        aggregatedResponse.candidates[candidateIndex].finishMessage = candidate.finishMessage;
        aggregatedResponse.candidates[candidateIndex].safetyRatings = candidate.safetyRatings;
        if (candidate.content && candidate.content.parts) {
          if (!aggregatedResponse.candidates[candidateIndex].content) {
            aggregatedResponse.candidates[candidateIndex].content = {
              role: candidate.content.role || "user",
              parts: []
            };
          }
          const newPart = {};
          for (const part of candidate.content.parts) {
            if (part.text) {
              newPart.text = part.text;
            }
            if (part.functionCall) {
              newPart.functionCall = part.functionCall;
            }
            if (part.executableCode) {
              newPart.executableCode = part.executableCode;
            }
            if (part.codeExecutionResult) {
              newPart.codeExecutionResult = part.codeExecutionResult;
            }
            if (Object.keys(newPart).length === 0) {
              newPart.text = "";
            }
            aggregatedResponse.candidates[candidateIndex].content.parts.push(newPart);
          }
        }
      }
      candidateIndex++;
    }
    if (response.usageMetadata) {
      aggregatedResponse.usageMetadata = response.usageMetadata;
    }
  }
  return aggregatedResponse;
}
async function generateContentStream(apiKey, model, params, requestOptions) {
  const response = await makeModelRequest(model, Task.STREAM_GENERATE_CONTENT, apiKey, true, JSON.stringify(params), requestOptions);
  return processStream(response);
}
async function generateContent(apiKey, model, params, requestOptions) {
  const response = await makeModelRequest(model, Task.GENERATE_CONTENT, apiKey, false, JSON.stringify(params), requestOptions);
  const responseJson = await response.json();
  const enhancedResponse = addHelpers(responseJson);
  return {
    response: enhancedResponse
  };
}
function formatSystemInstruction(input) {
  if (input == null) {
    return;
  } else if (typeof input === "string") {
    return { role: "system", parts: [{ text: input }] };
  } else if (input.text) {
    return { role: "system", parts: [input] };
  } else if (input.parts) {
    if (!input.role) {
      return { role: "system", parts: input.parts };
    } else {
      return input;
    }
  }
}
function formatNewContent(request) {
  let newParts = [];
  if (typeof request === "string") {
    newParts = [{ text: request }];
  } else {
    for (const partOrString of request) {
      if (typeof partOrString === "string") {
        newParts.push({ text: partOrString });
      } else {
        newParts.push(partOrString);
      }
    }
  }
  return assignRoleToPartsAndValidateSendMessageRequest(newParts);
}
function assignRoleToPartsAndValidateSendMessageRequest(parts) {
  const userContent = { role: "user", parts: [] };
  const functionContent = { role: "function", parts: [] };
  let hasUserContent = false;
  let hasFunctionContent = false;
  for (const part of parts) {
    if ("functionResponse" in part) {
      functionContent.parts.push(part);
      hasFunctionContent = true;
    } else {
      userContent.parts.push(part);
      hasUserContent = true;
    }
  }
  if (hasUserContent && hasFunctionContent) {
    throw new GoogleGenerativeAIError("Within a single message, FunctionResponse cannot be mixed with other type of part in the request for sending chat message.");
  }
  if (!hasUserContent && !hasFunctionContent) {
    throw new GoogleGenerativeAIError("No content is provided for sending chat message.");
  }
  if (hasUserContent) {
    return userContent;
  }
  return functionContent;
}
function formatCountTokensInput(params, modelParams) {
  var _a;
  let formattedGenerateContentRequest = {
    model: modelParams === null || modelParams === undefined ? undefined : modelParams.model,
    generationConfig: modelParams === null || modelParams === undefined ? undefined : modelParams.generationConfig,
    safetySettings: modelParams === null || modelParams === undefined ? undefined : modelParams.safetySettings,
    tools: modelParams === null || modelParams === undefined ? undefined : modelParams.tools,
    toolConfig: modelParams === null || modelParams === undefined ? undefined : modelParams.toolConfig,
    systemInstruction: modelParams === null || modelParams === undefined ? undefined : modelParams.systemInstruction,
    cachedContent: (_a = modelParams === null || modelParams === undefined ? undefined : modelParams.cachedContent) === null || _a === undefined ? undefined : _a.name,
    contents: []
  };
  const containsGenerateContentRequest = params.generateContentRequest != null;
  if (params.contents) {
    if (containsGenerateContentRequest) {
      throw new GoogleGenerativeAIRequestInputError("CountTokensRequest must have one of contents or generateContentRequest, not both.");
    }
    formattedGenerateContentRequest.contents = params.contents;
  } else if (containsGenerateContentRequest) {
    formattedGenerateContentRequest = Object.assign(Object.assign({}, formattedGenerateContentRequest), params.generateContentRequest);
  } else {
    const content = formatNewContent(params);
    formattedGenerateContentRequest.contents = [content];
  }
  return { generateContentRequest: formattedGenerateContentRequest };
}
function formatGenerateContentInput(params) {
  let formattedRequest;
  if (params.contents) {
    formattedRequest = params;
  } else {
    const content = formatNewContent(params);
    formattedRequest = { contents: [content] };
  }
  if (params.systemInstruction) {
    formattedRequest.systemInstruction = formatSystemInstruction(params.systemInstruction);
  }
  return formattedRequest;
}
function formatEmbedContentInput(params) {
  if (typeof params === "string" || Array.isArray(params)) {
    const content = formatNewContent(params);
    return { content };
  }
  return params;
}
function validateChatHistory(history) {
  let prevContent = false;
  for (const currContent of history) {
    const { role, parts } = currContent;
    if (!prevContent && role !== "user") {
      throw new GoogleGenerativeAIError(`First content should be with role 'user', got ${role}`);
    }
    if (!POSSIBLE_ROLES.includes(role)) {
      throw new GoogleGenerativeAIError(`Each item should include role field. Got ${role} but valid roles are: ${JSON.stringify(POSSIBLE_ROLES)}`);
    }
    if (!Array.isArray(parts)) {
      throw new GoogleGenerativeAIError("Content should have 'parts' property with an array of Parts");
    }
    if (parts.length === 0) {
      throw new GoogleGenerativeAIError("Each Content should have at least one part");
    }
    const countFields = {
      text: 0,
      inlineData: 0,
      functionCall: 0,
      functionResponse: 0,
      fileData: 0,
      executableCode: 0,
      codeExecutionResult: 0
    };
    for (const part of parts) {
      for (const key of VALID_PART_FIELDS) {
        if (key in part) {
          countFields[key] += 1;
        }
      }
    }
    const validParts = VALID_PARTS_PER_ROLE[role];
    for (const key of VALID_PART_FIELDS) {
      if (!validParts.includes(key) && countFields[key] > 0) {
        throw new GoogleGenerativeAIError(`Content with role '${role}' can't contain '${key}' part`);
      }
    }
    prevContent = true;
  }
}
function isValidResponse(response) {
  var _a;
  if (response.candidates === undefined || response.candidates.length === 0) {
    return false;
  }
  const content = (_a = response.candidates[0]) === null || _a === undefined ? undefined : _a.content;
  if (content === undefined) {
    return false;
  }
  if (content.parts === undefined || content.parts.length === 0) {
    return false;
  }
  for (const part of content.parts) {
    if (part === undefined || Object.keys(part).length === 0) {
      return false;
    }
    if (part.text !== undefined && part.text === "") {
      return false;
    }
  }
  return true;
}

class ChatSession {
  constructor(apiKey, model, params, _requestOptions = {}) {
    this.model = model;
    this.params = params;
    this._requestOptions = _requestOptions;
    this._history = [];
    this._sendPromise = Promise.resolve();
    this._apiKey = apiKey;
    if (params === null || params === undefined ? undefined : params.history) {
      validateChatHistory(params.history);
      this._history = params.history;
    }
  }
  async getHistory() {
    await this._sendPromise;
    return this._history;
  }
  async sendMessage(request, requestOptions = {}) {
    var _a, _b, _c, _d, _e, _f;
    await this._sendPromise;
    const newContent = formatNewContent(request);
    const generateContentRequest = {
      safetySettings: (_a = this.params) === null || _a === undefined ? undefined : _a.safetySettings,
      generationConfig: (_b = this.params) === null || _b === undefined ? undefined : _b.generationConfig,
      tools: (_c = this.params) === null || _c === undefined ? undefined : _c.tools,
      toolConfig: (_d = this.params) === null || _d === undefined ? undefined : _d.toolConfig,
      systemInstruction: (_e = this.params) === null || _e === undefined ? undefined : _e.systemInstruction,
      cachedContent: (_f = this.params) === null || _f === undefined ? undefined : _f.cachedContent,
      contents: [...this._history, newContent]
    };
    const chatSessionRequestOptions = Object.assign(Object.assign({}, this._requestOptions), requestOptions);
    let finalResult;
    this._sendPromise = this._sendPromise.then(() => generateContent(this._apiKey, this.model, generateContentRequest, chatSessionRequestOptions)).then((result) => {
      var _a2;
      if (isValidResponse(result.response)) {
        this._history.push(newContent);
        const responseContent = Object.assign({
          parts: [],
          role: "model"
        }, (_a2 = result.response.candidates) === null || _a2 === undefined ? undefined : _a2[0].content);
        this._history.push(responseContent);
      } else {
        const blockErrorMessage = formatBlockErrorMessage(result.response);
        if (blockErrorMessage) {
          console.warn(`sendMessage() was unsuccessful. ${blockErrorMessage}. Inspect response object for details.`);
        }
      }
      finalResult = result;
    }).catch((e) => {
      this._sendPromise = Promise.resolve();
      throw e;
    });
    await this._sendPromise;
    return finalResult;
  }
  async sendMessageStream(request, requestOptions = {}) {
    var _a, _b, _c, _d, _e, _f;
    await this._sendPromise;
    const newContent = formatNewContent(request);
    const generateContentRequest = {
      safetySettings: (_a = this.params) === null || _a === undefined ? undefined : _a.safetySettings,
      generationConfig: (_b = this.params) === null || _b === undefined ? undefined : _b.generationConfig,
      tools: (_c = this.params) === null || _c === undefined ? undefined : _c.tools,
      toolConfig: (_d = this.params) === null || _d === undefined ? undefined : _d.toolConfig,
      systemInstruction: (_e = this.params) === null || _e === undefined ? undefined : _e.systemInstruction,
      cachedContent: (_f = this.params) === null || _f === undefined ? undefined : _f.cachedContent,
      contents: [...this._history, newContent]
    };
    const chatSessionRequestOptions = Object.assign(Object.assign({}, this._requestOptions), requestOptions);
    const streamPromise = generateContentStream(this._apiKey, this.model, generateContentRequest, chatSessionRequestOptions);
    this._sendPromise = this._sendPromise.then(() => streamPromise).catch((_ignored) => {
      throw new Error(SILENT_ERROR);
    }).then((streamResult) => streamResult.response).then((response) => {
      if (isValidResponse(response)) {
        this._history.push(newContent);
        const responseContent = Object.assign({}, response.candidates[0].content);
        if (!responseContent.role) {
          responseContent.role = "model";
        }
        this._history.push(responseContent);
      } else {
        const blockErrorMessage = formatBlockErrorMessage(response);
        if (blockErrorMessage) {
          console.warn(`sendMessageStream() was unsuccessful. ${blockErrorMessage}. Inspect response object for details.`);
        }
      }
    }).catch((e) => {
      if (e.message !== SILENT_ERROR) {
        console.error(e);
      }
    });
    return streamPromise;
  }
}
async function countTokens(apiKey, model, params, singleRequestOptions) {
  const response = await makeModelRequest(model, Task.COUNT_TOKENS, apiKey, false, JSON.stringify(params), singleRequestOptions);
  return response.json();
}
async function embedContent(apiKey, model, params, requestOptions) {
  const response = await makeModelRequest(model, Task.EMBED_CONTENT, apiKey, false, JSON.stringify(params), requestOptions);
  return response.json();
}
async function batchEmbedContents(apiKey, model, params, requestOptions) {
  const requestsWithModel = params.requests.map((request) => {
    return Object.assign(Object.assign({}, request), { model });
  });
  const response = await makeModelRequest(model, Task.BATCH_EMBED_CONTENTS, apiKey, false, JSON.stringify({ requests: requestsWithModel }), requestOptions);
  return response.json();
}

class GenerativeModel {
  constructor(apiKey, modelParams, _requestOptions = {}) {
    this.apiKey = apiKey;
    this._requestOptions = _requestOptions;
    if (modelParams.model.includes("/")) {
      this.model = modelParams.model;
    } else {
      this.model = `models/${modelParams.model}`;
    }
    this.generationConfig = modelParams.generationConfig || {};
    this.safetySettings = modelParams.safetySettings || [];
    this.tools = modelParams.tools;
    this.toolConfig = modelParams.toolConfig;
    this.systemInstruction = formatSystemInstruction(modelParams.systemInstruction);
    this.cachedContent = modelParams.cachedContent;
  }
  async generateContent(request, requestOptions = {}) {
    var _a;
    const formattedParams = formatGenerateContentInput(request);
    const generativeModelRequestOptions = Object.assign(Object.assign({}, this._requestOptions), requestOptions);
    return generateContent(this.apiKey, this.model, Object.assign({ generationConfig: this.generationConfig, safetySettings: this.safetySettings, tools: this.tools, toolConfig: this.toolConfig, systemInstruction: this.systemInstruction, cachedContent: (_a = this.cachedContent) === null || _a === undefined ? undefined : _a.name }, formattedParams), generativeModelRequestOptions);
  }
  async generateContentStream(request, requestOptions = {}) {
    var _a;
    const formattedParams = formatGenerateContentInput(request);
    const generativeModelRequestOptions = Object.assign(Object.assign({}, this._requestOptions), requestOptions);
    return generateContentStream(this.apiKey, this.model, Object.assign({ generationConfig: this.generationConfig, safetySettings: this.safetySettings, tools: this.tools, toolConfig: this.toolConfig, systemInstruction: this.systemInstruction, cachedContent: (_a = this.cachedContent) === null || _a === undefined ? undefined : _a.name }, formattedParams), generativeModelRequestOptions);
  }
  startChat(startChatParams) {
    var _a;
    return new ChatSession(this.apiKey, this.model, Object.assign({ generationConfig: this.generationConfig, safetySettings: this.safetySettings, tools: this.tools, toolConfig: this.toolConfig, systemInstruction: this.systemInstruction, cachedContent: (_a = this.cachedContent) === null || _a === undefined ? undefined : _a.name }, startChatParams), this._requestOptions);
  }
  async countTokens(request, requestOptions = {}) {
    const formattedParams = formatCountTokensInput(request, {
      model: this.model,
      generationConfig: this.generationConfig,
      safetySettings: this.safetySettings,
      tools: this.tools,
      toolConfig: this.toolConfig,
      systemInstruction: this.systemInstruction,
      cachedContent: this.cachedContent
    });
    const generativeModelRequestOptions = Object.assign(Object.assign({}, this._requestOptions), requestOptions);
    return countTokens(this.apiKey, this.model, formattedParams, generativeModelRequestOptions);
  }
  async embedContent(request, requestOptions = {}) {
    const formattedParams = formatEmbedContentInput(request);
    const generativeModelRequestOptions = Object.assign(Object.assign({}, this._requestOptions), requestOptions);
    return embedContent(this.apiKey, this.model, formattedParams, generativeModelRequestOptions);
  }
  async batchEmbedContents(batchEmbedContentRequest, requestOptions = {}) {
    const generativeModelRequestOptions = Object.assign(Object.assign({}, this._requestOptions), requestOptions);
    return batchEmbedContents(this.apiKey, this.model, batchEmbedContentRequest, generativeModelRequestOptions);
  }
}

class GoogleGenerativeAI {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }
  getGenerativeModel(modelParams, requestOptions) {
    if (!modelParams.model) {
      throw new GoogleGenerativeAIError(`Must provide a model name. ` + `Example: genai.getGenerativeModel({ model: 'my-model-name' })`);
    }
    return new GenerativeModel(this.apiKey, modelParams, requestOptions);
  }
  getGenerativeModelFromCachedContent(cachedContent, modelParams, requestOptions) {
    if (!cachedContent.name) {
      throw new GoogleGenerativeAIRequestInputError("Cached content must contain a `name` field.");
    }
    if (!cachedContent.model) {
      throw new GoogleGenerativeAIRequestInputError("Cached content must contain a `model` field.");
    }
    const disallowedDuplicates = ["model", "systemInstruction"];
    for (const key of disallowedDuplicates) {
      if ((modelParams === null || modelParams === undefined ? undefined : modelParams[key]) && cachedContent[key] && (modelParams === null || modelParams === undefined ? undefined : modelParams[key]) !== cachedContent[key]) {
        if (key === "model") {
          const modelParamsComp = modelParams.model.startsWith("models/") ? modelParams.model.replace("models/", "") : modelParams.model;
          const cachedContentComp = cachedContent.model.startsWith("models/") ? cachedContent.model.replace("models/", "") : cachedContent.model;
          if (modelParamsComp === cachedContentComp) {
            continue;
          }
        }
        throw new GoogleGenerativeAIRequestInputError(`Different value for "${key}" specified in modelParams` + ` (${modelParams[key]}) and cachedContent (${cachedContent[key]})`);
      }
    }
    const modelParamsFromCache = Object.assign(Object.assign({}, modelParams), { model: cachedContent.model, tools: cachedContent.tools, toolConfig: cachedContent.toolConfig, systemInstruction: cachedContent.systemInstruction, cachedContent });
    return new GenerativeModel(this.apiKey, modelParamsFromCache, requestOptions);
  }
}
var SchemaType, ExecutableCodeLanguage, Outcome, POSSIBLE_ROLES, HarmCategory, HarmBlockThreshold, HarmProbability, BlockReason, FinishReason, TaskType, FunctionCallingMode, DynamicRetrievalMode, GoogleGenerativeAIError, GoogleGenerativeAIResponseError, GoogleGenerativeAIFetchError, GoogleGenerativeAIRequestInputError, GoogleGenerativeAIAbortError, DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com", DEFAULT_API_VERSION = "v1beta", PACKAGE_VERSION = "0.24.1", PACKAGE_LOG_HEADER = "genai-js", Task, badFinishReasons, responseLineRE, VALID_PART_FIELDS, VALID_PARTS_PER_ROLE, SILENT_ERROR = "SILENT_ERROR";
var init_dist = __esm(() => {
  (function(SchemaType2) {
    SchemaType2["STRING"] = "string";
    SchemaType2["NUMBER"] = "number";
    SchemaType2["INTEGER"] = "integer";
    SchemaType2["BOOLEAN"] = "boolean";
    SchemaType2["ARRAY"] = "array";
    SchemaType2["OBJECT"] = "object";
  })(SchemaType || (SchemaType = {}));
  (function(ExecutableCodeLanguage2) {
    ExecutableCodeLanguage2["LANGUAGE_UNSPECIFIED"] = "language_unspecified";
    ExecutableCodeLanguage2["PYTHON"] = "python";
  })(ExecutableCodeLanguage || (ExecutableCodeLanguage = {}));
  (function(Outcome2) {
    Outcome2["OUTCOME_UNSPECIFIED"] = "outcome_unspecified";
    Outcome2["OUTCOME_OK"] = "outcome_ok";
    Outcome2["OUTCOME_FAILED"] = "outcome_failed";
    Outcome2["OUTCOME_DEADLINE_EXCEEDED"] = "outcome_deadline_exceeded";
  })(Outcome || (Outcome = {}));
  POSSIBLE_ROLES = ["user", "model", "function", "system"];
  (function(HarmCategory2) {
    HarmCategory2["HARM_CATEGORY_UNSPECIFIED"] = "HARM_CATEGORY_UNSPECIFIED";
    HarmCategory2["HARM_CATEGORY_HATE_SPEECH"] = "HARM_CATEGORY_HATE_SPEECH";
    HarmCategory2["HARM_CATEGORY_SEXUALLY_EXPLICIT"] = "HARM_CATEGORY_SEXUALLY_EXPLICIT";
    HarmCategory2["HARM_CATEGORY_HARASSMENT"] = "HARM_CATEGORY_HARASSMENT";
    HarmCategory2["HARM_CATEGORY_DANGEROUS_CONTENT"] = "HARM_CATEGORY_DANGEROUS_CONTENT";
    HarmCategory2["HARM_CATEGORY_CIVIC_INTEGRITY"] = "HARM_CATEGORY_CIVIC_INTEGRITY";
  })(HarmCategory || (HarmCategory = {}));
  (function(HarmBlockThreshold2) {
    HarmBlockThreshold2["HARM_BLOCK_THRESHOLD_UNSPECIFIED"] = "HARM_BLOCK_THRESHOLD_UNSPECIFIED";
    HarmBlockThreshold2["BLOCK_LOW_AND_ABOVE"] = "BLOCK_LOW_AND_ABOVE";
    HarmBlockThreshold2["BLOCK_MEDIUM_AND_ABOVE"] = "BLOCK_MEDIUM_AND_ABOVE";
    HarmBlockThreshold2["BLOCK_ONLY_HIGH"] = "BLOCK_ONLY_HIGH";
    HarmBlockThreshold2["BLOCK_NONE"] = "BLOCK_NONE";
  })(HarmBlockThreshold || (HarmBlockThreshold = {}));
  (function(HarmProbability2) {
    HarmProbability2["HARM_PROBABILITY_UNSPECIFIED"] = "HARM_PROBABILITY_UNSPECIFIED";
    HarmProbability2["NEGLIGIBLE"] = "NEGLIGIBLE";
    HarmProbability2["LOW"] = "LOW";
    HarmProbability2["MEDIUM"] = "MEDIUM";
    HarmProbability2["HIGH"] = "HIGH";
  })(HarmProbability || (HarmProbability = {}));
  (function(BlockReason2) {
    BlockReason2["BLOCKED_REASON_UNSPECIFIED"] = "BLOCKED_REASON_UNSPECIFIED";
    BlockReason2["SAFETY"] = "SAFETY";
    BlockReason2["OTHER"] = "OTHER";
  })(BlockReason || (BlockReason = {}));
  (function(FinishReason2) {
    FinishReason2["FINISH_REASON_UNSPECIFIED"] = "FINISH_REASON_UNSPECIFIED";
    FinishReason2["STOP"] = "STOP";
    FinishReason2["MAX_TOKENS"] = "MAX_TOKENS";
    FinishReason2["SAFETY"] = "SAFETY";
    FinishReason2["RECITATION"] = "RECITATION";
    FinishReason2["LANGUAGE"] = "LANGUAGE";
    FinishReason2["BLOCKLIST"] = "BLOCKLIST";
    FinishReason2["PROHIBITED_CONTENT"] = "PROHIBITED_CONTENT";
    FinishReason2["SPII"] = "SPII";
    FinishReason2["MALFORMED_FUNCTION_CALL"] = "MALFORMED_FUNCTION_CALL";
    FinishReason2["OTHER"] = "OTHER";
  })(FinishReason || (FinishReason = {}));
  (function(TaskType2) {
    TaskType2["TASK_TYPE_UNSPECIFIED"] = "TASK_TYPE_UNSPECIFIED";
    TaskType2["RETRIEVAL_QUERY"] = "RETRIEVAL_QUERY";
    TaskType2["RETRIEVAL_DOCUMENT"] = "RETRIEVAL_DOCUMENT";
    TaskType2["SEMANTIC_SIMILARITY"] = "SEMANTIC_SIMILARITY";
    TaskType2["CLASSIFICATION"] = "CLASSIFICATION";
    TaskType2["CLUSTERING"] = "CLUSTERING";
  })(TaskType || (TaskType = {}));
  (function(FunctionCallingMode2) {
    FunctionCallingMode2["MODE_UNSPECIFIED"] = "MODE_UNSPECIFIED";
    FunctionCallingMode2["AUTO"] = "AUTO";
    FunctionCallingMode2["ANY"] = "ANY";
    FunctionCallingMode2["NONE"] = "NONE";
  })(FunctionCallingMode || (FunctionCallingMode = {}));
  (function(DynamicRetrievalMode2) {
    DynamicRetrievalMode2["MODE_UNSPECIFIED"] = "MODE_UNSPECIFIED";
    DynamicRetrievalMode2["MODE_DYNAMIC"] = "MODE_DYNAMIC";
  })(DynamicRetrievalMode || (DynamicRetrievalMode = {}));
  GoogleGenerativeAIError = class GoogleGenerativeAIError extends Error {
    constructor(message) {
      super(`[GoogleGenerativeAI Error]: ${message}`);
    }
  };
  GoogleGenerativeAIResponseError = class GoogleGenerativeAIResponseError extends GoogleGenerativeAIError {
    constructor(message, response) {
      super(message);
      this.response = response;
    }
  };
  GoogleGenerativeAIFetchError = class GoogleGenerativeAIFetchError extends GoogleGenerativeAIError {
    constructor(message, status, statusText, errorDetails) {
      super(message);
      this.status = status;
      this.statusText = statusText;
      this.errorDetails = errorDetails;
    }
  };
  GoogleGenerativeAIRequestInputError = class GoogleGenerativeAIRequestInputError extends GoogleGenerativeAIError {
  };
  GoogleGenerativeAIAbortError = class GoogleGenerativeAIAbortError extends GoogleGenerativeAIError {
  };
  (function(Task2) {
    Task2["GENERATE_CONTENT"] = "generateContent";
    Task2["STREAM_GENERATE_CONTENT"] = "streamGenerateContent";
    Task2["COUNT_TOKENS"] = "countTokens";
    Task2["EMBED_CONTENT"] = "embedContent";
    Task2["BATCH_EMBED_CONTENTS"] = "batchEmbedContents";
  })(Task || (Task = {}));
  badFinishReasons = [
    FinishReason.RECITATION,
    FinishReason.SAFETY,
    FinishReason.LANGUAGE
  ];
  responseLineRE = /^data\: (.*)(?:\n\n|\r\r|\r\n\r\n)/;
  VALID_PART_FIELDS = [
    "text",
    "inlineData",
    "functionCall",
    "functionResponse",
    "executableCode",
    "codeExecutionResult"
  ];
  VALID_PARTS_PER_ROLE = {
    user: ["text", "inlineData"],
    function: ["functionResponse"],
    model: ["text", "functionCall", "executableCode", "codeExecutionResult"],
    system: ["text"]
  };
});

// src/core/ratelimiter.ts
class RateLimiter {
  tokens;
  maxTokens;
  refillRate;
  lastRefill;
  queue = [];
  constructor(config = {}) {
    const rps = config.requestsPerSecond ?? DEFAULT_EMBEDDING_RPS;
    this.maxTokens = config.burstSize ?? 1;
    this.tokens = this.maxTokens;
    this.refillRate = rps / 1000;
    this.lastRefill = Date.now();
  }
  refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed > 0) {
      const newTokens = elapsed * this.refillRate;
      this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }
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
  scheduleQueueProcessing() {
    const tokensNeeded = 1 - this.tokens;
    const waitMs = Math.ceil(tokensNeeded / this.refillRate);
    setTimeout(() => {
      this.processQueue();
    }, waitMs);
  }
  tryAcquire() {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
  getAvailableTokens() {
    this.refill();
    return Math.floor(this.tokens);
  }
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
}
function getEmbeddingRateLimiter() {
  if (!embeddingLimiter) {
    const config = loadConfigFn();
    const ratelimitConfig = config?.ratelimit?.embedding;
    const rps = ratelimitConfig?.requestsPerSecond ?? DEFAULT_EMBEDDING_RPS;
    embeddingLimiter = new RateLimiter({
      requestsPerSecond: rps,
      burstSize: ratelimitConfig?.burstSize ?? 1
    });
  }
  return embeddingLimiter;
}
function getLLMRateLimiter() {
  if (!llmLimiter) {
    const config = loadConfigFn();
    const ratelimitConfig = config?.ratelimit?.llm;
    const rps = ratelimitConfig?.requestsPerSecond ?? DEFAULT_LLM_RPS;
    llmLimiter = new RateLimiter({
      requestsPerSecond: rps,
      burstSize: ratelimitConfig?.burstSize ?? 1
    });
  }
  return llmLimiter;
}
var loadConfigFn, DEFAULT_EMBEDDING_RPS = 0.5, DEFAULT_LLM_RPS = 0.5, embeddingLimiter = null, llmLimiter = null;
var init_ratelimiter = __esm(() => {
  init_config();
  loadConfigFn = loadConfig;
});

// src/core/llm/gemini-provider.ts
var exports_gemini_provider = {};
__export(exports_gemini_provider, {
  GeminiProvider: () => GeminiProvider
});
function getRequestTimeoutMs(model) {
  return model.startsWith("gemma-4-") ? GEMMA_THINKING_MODEL_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
}

class GeminiProvider {
  client;
  model;
  constructor(apiKey, model = DEFAULT_MODEL) {
    if (!apiKey) {
      throw new Error("GeminiProvider requires an API key");
    }
    this.client = new GoogleGenerativeAI(apiKey);
    this.model = model;
  }
  async complete(prompt, options) {
    await getLLMRateLimiter().acquire();
    const startTime = Date.now();
    logInfo("[GeminiProvider] Starting completion", {
      model: this.model,
      promptLength: prompt.length,
      maxTokens: options?.maxTokens
    });
    try {
      const generationConfig = {};
      if (options?.maxTokens) {
        generationConfig.maxOutputTokens = options.maxTokens;
      }
      const modelParams = { model: this.model };
      if (options?.systemPrompt) {
        modelParams.systemInstruction = options.systemPrompt;
      }
      if (Object.keys(generationConfig).length > 0) {
        modelParams.generationConfig = generationConfig;
      }
      logDebug("[GeminiProvider] Sending request", {
        model: this.model,
        hasSystemPrompt: !!options?.systemPrompt
      });
      const generativeModel = this.client.getGenerativeModel(modelParams, {
        timeout: getRequestTimeoutMs(this.model)
      });
      const result = await generativeModel.generateContent(prompt);
      const duration = Date.now() - startTime;
      const parsed = this.parseResult(result);
      logInfo("[GeminiProvider] Completion successful", {
        duration,
        inputTokens: parsed.usage.input_tokens,
        outputTokens: parsed.usage.output_tokens,
        responseLength: parsed.text.length
      });
      return parsed;
    } catch (error) {
      const duration = Date.now() - startTime;
      logError("[GeminiProvider] Completion failed", error, {
        model: this.model,
        duration
      });
      throw new Error(`Gemini API call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  parseResult(result) {
    const response = result.response;
    const text = this.extractAnswerText(response);
    const usage = this.extractUsage(response);
    return { text, usage };
  }
  extractAnswerText(response) {
    const parts = response.candidates?.[0]?.content?.parts;
    if (parts && parts.length > 0) {
      const answer = parts.filter((part) => part.thought !== true).map((part) => part.text ?? "").join("");
      return answer;
    }
    return response.text() ?? "";
  }
  extractUsage(response) {
    const usageMetadata = response.usageMetadata;
    return {
      input_tokens: usageMetadata?.promptTokenCount ?? 0,
      output_tokens: usageMetadata?.candidatesTokenCount ?? 0,
      cache_read_input_tokens: undefined,
      cache_creation_input_tokens: undefined
    };
  }
}
var DEFAULT_MODEL = "gemini-2.0-flash", REQUEST_TIMEOUT_MS = 60000, GEMMA_THINKING_MODEL_REQUEST_TIMEOUT_MS = 120000;
var init_gemini_provider = __esm(() => {
  init_dist();
  init_logger();
  init_ratelimiter();
});

// src/core/llm/zai-provider.ts
var exports_zai_provider = {};
__export(exports_zai_provider, {
  ZAIProvider: () => ZAIProvider
});

class ZAIProvider {
  apiKey;
  model;
  baseUrl;
  constructor(apiKey, model = DEFAULT_MODEL2, baseUrl = DEFAULT_BASE_URL2) {
    if (!apiKey) {
      throw new Error("ZAIProvider requires an API key");
    }
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
  }
  async complete(prompt, options) {
    await getLLMRateLimiter().acquire();
    const startTime = Date.now();
    logInfo("[ZAIProvider] Starting completion", {
      model: this.model,
      promptLength: prompt.length,
      maxTokens: options?.maxTokens
    });
    try {
      const messages = [];
      if (options?.systemPrompt) {
        messages.push({ role: "system", content: options.systemPrompt });
      }
      messages.push({ role: "user", content: prompt });
      const requestBody = {
        model: this.model,
        messages,
        temperature: 1,
        max_tokens: options?.maxTokens,
        stream: false
      };
      logDebug("[ZAIProvider] Sending request", {
        model: this.model,
        messagesCount: messages.length,
        hasSystemPrompt: !!options?.systemPrompt
      });
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "Accept-Language": "en-US,en"
        },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS2)
      });
      if (!response.ok) {
        let errorData = {};
        try {
          errorData = await response.json();
        } catch {}
        const errorMessage = errorData.error?.message || response.statusText;
        throw new Error(`Z.AI API request failed (${response.status}): ${errorMessage}`);
      }
      const data = await response.json();
      const duration = Date.now() - startTime;
      const text = data.choices?.[0]?.message?.content ?? "";
      const usage = this.extractUsage(data);
      logInfo("[ZAIProvider] Completion successful", {
        duration,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        responseLength: text.length
      });
      return { text, usage };
    } catch (error) {
      const duration = Date.now() - startTime;
      logError("[ZAIProvider] Completion failed", error, {
        model: this.model,
        duration
      });
      throw error;
    }
  }
  extractUsage(response) {
    const usage = response.usage;
    return {
      input_tokens: usage?.prompt_tokens ?? 0,
      output_tokens: usage?.completion_tokens ?? 0,
      cache_read_input_tokens: undefined,
      cache_creation_input_tokens: undefined
    };
  }
}
var DEFAULT_MODEL2 = "glm-4.5-air", REQUEST_TIMEOUT_MS2 = 120000, DEFAULT_BASE_URL2 = "https://api.z.ai/api/coding/paas/v4";
var init_zai_provider = __esm(() => {
  init_logger();
  init_ratelimiter();
});

// src/core/llm/config.ts
import { existsSync as existsSync4, readFileSync } from "fs";
import { join as join6 } from "path";
function loadConfig() {
  const configDir = join6(process.env.HOME ?? "", ".config", "episodic-memory");
  const configPath = join6(configDir, "config.json");
  if (!configFileDeps.existsSync(configPath)) {
    return null;
  }
  try {
    const configContent = configFileDeps.readFileSync(configPath, "utf-8");
    const config = JSON.parse(configContent);
    const hasProviders = Array.isArray(config.providers) && config.providers.length > 0;
    if (!config.provider || !config.apiKey && !hasProviders) {
      console.warn("Invalid config: missing provider or apiKey field");
      return null;
    }
    if (config.provider !== "gemini" && config.provider !== "zai") {
      console.warn(`Invalid config: unknown provider "${config.provider}"`);
      return null;
    }
    return config;
  } catch (error) {
    console.warn(`Failed to load config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
async function createProvider(config) {
  const { provider, apiKey, model, providers } = config;
  if (providers) {
    const { RoundRobinProvider: RoundRobinProvider2 } = await Promise.resolve().then(() => exports_round_robin_provider);
    const built = await Promise.all(providers.map((entry) => createProvider({ provider, apiKey: entry.apiKey, model: entry.model })));
    return new RoundRobinProvider2(built);
  }
  if (!apiKey) {
    throw new Error("Provider requires an apiKey");
  }
  const defaultModel = model ?? DEFAULT_MODELS[provider];
  if (provider === "gemini") {
    const { GeminiProvider: GeminiProvider2 } = await Promise.resolve().then(() => (init_gemini_provider(), exports_gemini_provider));
    return new GeminiProvider2(apiKey, defaultModel);
  } else if (provider === "zai") {
    const { ZAIProvider: ZAIProvider2 } = await Promise.resolve().then(() => (init_zai_provider(), exports_zai_provider));
    return new ZAIProvider2(apiKey, defaultModel);
  }
  throw new Error(`Unknown provider: ${provider}`);
}
var DEFAULT_MODELS, DEFAULT_EMBEDDING_MAX_CONCURRENCY = 4, configFileDeps;
var init_config = __esm(() => {
  DEFAULT_MODELS = {
    gemini: "gemini-2.0-flash",
    zai: "glm-4.5-air"
  };
  configFileDeps = {
    existsSync: existsSync4,
    readFileSync
  };
});

// src/cli/doctor.ts
import { basename, dirname, join as join2 } from "path";
import { fileURLToPath } from "url";

// src/core/memory/schema.ts
init_paths();
import { Database } from "bun:sqlite";
import path2 from "path";
import fs2 from "fs";
import * as sqliteVec from "sqlite-vec";

// src/core/constants.ts
var EMBEDDING_DIM = 384;
var LOCAL_USER_ID = "local";

// src/core/memory/schema.ts
var isTestEnvironment = typeof import.meta !== "undefined" && import.meta.test;
if (process.platform === "darwin" && !isTestEnvironment && true) {
  try {
    Database.setCustomSQLite("/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib");
  } catch {}
}
function createMemorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id         TEXT PRIMARY KEY,
      memory     TEXT NOT NULL,
      hash       TEXT NOT NULL,
      metadata   TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_hash ON memories(hash)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id  TEXT NOT NULL,
      old_memory TEXT,
      new_memory TEXT,
      event      TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      is_deleted INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_history_memory_id ON history(memory_id)");
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id                TEXT PRIMARY KEY,
      data              TEXT NOT NULL,
      entity_type       TEXT,
      linked_memory_ids TEXT NOT NULL DEFAULT '[]',
      metadata          TEXT,
      created_at        INTEGER NOT NULL
    )
  `);
  const entityCols = db.query("PRAGMA table_info(entities)").all();
  if (!entityCols.some((c) => c.name === "metadata")) {
    db.exec("ALTER TABLE entities ADD COLUMN metadata TEXT");
  }
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_memories USING vec0(embedding float[${EMBEDDING_DIM}])`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS vec_entities USING vec0(embedding float[${EMBEDDING_DIM}])`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_memories USING fts5(text_lemmatized, tokenize='unicode61')`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_index_state (
      archive_path TEXT PRIMARY KEY,
      content_mtime_ms REAL NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}
function getArchiveIndexMtime(db, archivePath) {
  const row = db.query("SELECT content_mtime_ms AS mtime FROM archive_index_state WHERE archive_path = ?").get(archivePath);
  return row ? row.mtime : null;
}
function setArchiveIndexMtime(db, archivePath, contentMtimeMs) {
  const now = Date.now();
  db.query(`
    INSERT INTO archive_index_state (archive_path, content_mtime_ms, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(archive_path) DO UPDATE SET
      content_mtime_ms = excluded.content_mtime_ms,
      updated_at = excluded.updated_at
  `).run(archivePath, contentMtimeMs, now);
}
function openMemoryDb() {
  const dbPath = getDbPath();
  const dbDir = path2.dirname(dbPath);
  if (dbPath !== ":memory:" && !fs2.existsSync(dbDir)) {
    fs2.mkdirSync(dbDir, { recursive: true });
  }
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");
  createMemorySchema(db);
  return db;
}

// src/core/doctor.ts
import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";

// src/core/verify.ts
function verifyMemoryIndex(db) {
  const totalMemories = db.query("SELECT COUNT(*) AS c FROM memories").get().c;
  const missingVectors = db.query(`
    SELECT m.id AS id
    FROM memories m
    LEFT JOIN vec_memories v ON v.rowid = m.rowid
    WHERE v.rowid IS NULL
    ORDER BY m.rowid ASC
  `).all();
  const orphanVectors = db.query(`
    SELECT v.rowid AS rowid
    FROM vec_memories v
    LEFT JOIN memories m ON m.rowid = v.rowid
    WHERE m.rowid IS NULL
    ORDER BY v.rowid ASC
  `).all();
  return {
    totalMemories,
    missingVectors,
    orphanVectors
  };
}

// src/core/stats.ts
function count(db, sql) {
  const row = db.query(sql).get();
  return row.count;
}
function getMemoryStats(db) {
  return {
    totalMemories: count(db, "SELECT COUNT(*) AS count FROM memories"),
    vectorizedMemories: count(db, "SELECT COUNT(*) AS count FROM vec_memories"),
    missingVectors: count(db, `
      SELECT COUNT(*) AS count
      FROM memories m
      LEFT JOIN vec_memories v ON v.rowid = m.rowid
      WHERE v.rowid IS NULL
    `)
  };
}

// src/core/doctor.ts
var REQUIRED_DIST_ARTIFACTS = ["cli-internal.mjs", "mcp-server.mjs"];
var STALE_TOLERANCE_MS = 2000;
function newestMtime(dir, ext) {
  let newest = 0;
  if (!existsSync(dir))
    return 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full, ext));
    } else if (entry.name.endsWith(ext)) {
      newest = Math.max(newest, statSync(full).mtimeMs);
    }
  }
  return newest;
}
function checkBuild(paths) {
  const missing = REQUIRED_DIST_ARTIFACTS.filter((name) => !existsSync(join(paths.distDir, name)));
  if (missing.length > 0) {
    return {
      name: "build",
      status: "fail",
      detail: `Missing build artifact(s): ${missing.join(", ")}.`,
      suggestion: "bun run build"
    };
  }
  const srcMtime = newestMtime(paths.srcDir, ".ts");
  const distMtime = Math.min(...REQUIRED_DIST_ARTIFACTS.map((name) => statSync(join(paths.distDir, name)).mtimeMs));
  if (srcMtime > distMtime + STALE_TOLERANCE_MS) {
    return {
      name: "build",
      status: "fail",
      detail: "Source changed after the last build (dist is stale).",
      suggestion: "bun run build"
    };
  }
  return { name: "build", status: "ok", detail: "Build artifacts are up to date." };
}
function checkIndex(db) {
  const v = verifyMemoryIndex(db);
  const hard = v.missingVectors.length + v.orphanVectors.length;
  if (hard > 0) {
    return {
      name: "index",
      status: "fail",
      detail: `Integrity issues: ${v.missingVectors.length} missing vectors, ` + `${v.orphanVectors.length} orphan vectors.`,
      suggestion: "episodic-memory sync"
    };
  }
  return { name: "index", status: "ok", detail: "Memory index integrity verified." };
}
function checkData(db) {
  const s = getMemoryStats(db);
  if (s.totalMemories === 0) {
    return {
      name: "data",
      status: "warn",
      detail: "No memories — nothing has been indexed yet.",
      suggestion: "episodic-memory sync"
    };
  }
  if (s.missingVectors > 0) {
    return {
      name: "data",
      status: "warn",
      detail: `${s.missingVectors} record(s) are not vectorized.`,
      suggestion: "episodic-memory sync"
    };
  }
  return {
    name: "data",
    status: "ok",
    detail: `${s.totalMemories} memories, all vectorized.`
  };
}
function runDiagnostics(db, paths) {
  return [checkBuild(paths), checkIndex(db), checkData(db)];
}

// src/cli/doctor.ts
var STATUS_ICON = {
  ok: "✓",
  warn: "⚠",
  fail: "✗"
};
function resolveRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === "cli" ? join2(here, "..", "..") : join2(here, "..");
}
function runDoctorCli() {
  const db = openMemoryDb();
  try {
    const root = resolveRoot();
    const results = runDiagnostics(db, {
      distDir: join2(root, "dist"),
      srcDir: join2(root, "src")
    });
    let hasFail = false;
    let hasWarn = false;
    for (const r of results) {
      console.log(`${STATUS_ICON[r.status]} ${r.name}: ${r.detail}`);
      if (r.suggestion) {
        console.log(`    → run: ${r.suggestion}`);
      }
      if (r.status === "fail")
        hasFail = true;
      if (r.status === "warn")
        hasWarn = true;
    }
    if (hasFail) {
      process.exitCode = 1;
    } else if (hasWarn) {
      console.log(`
episodic-memory is usable, but some checks need attention.`);
    } else {
      console.log(`
episodic-memory is healthy.`);
    }
  } finally {
    db.close();
  }
}

// src/cli/mcp.ts
import { spawn as spawn2 } from "child_process";
import { existsSync as existsSync3 } from "fs";
import { dirname as dirname3, join as join4 } from "path";
import { fileURLToPath as fileURLToPath3 } from "url";

// scripts/lib/check-dependencies.mjs
import { existsSync as existsSync2, statSync as statSync2, readdirSync as readdirSync2 } from "fs";
import { spawn } from "child_process";
import { dirname as dirname2, join as join3 } from "path";
import { fileURLToPath as fileURLToPath2 } from "url";
var __dirname2 = dirname2(fileURLToPath2(import.meta.url));
function findRoot(start) {
  let dir = start;
  while (dir !== dirname2(dir)) {
    if (existsSync2(join3(dir, "package.json")))
      return dir;
    dir = dirname2(dir);
  }
  return start;
}
var ROOT = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || findRoot(__dirname2);
function checkDependencies() {
  const nodeModulesPath = join3(ROOT, "node_modules");
  if (!existsSync2(nodeModulesPath)) {
    return { installed: false, missing: ["node_modules"] };
  }
  return { installed: true, missing: [] };
}
function installDependencies(silent = false) {
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === "win32";
    const bunCommand = isWindows ? "bun.exe" : "bun";
    if (!silent) {
      console.error("[episodic-memory] Installing dependencies...");
    }
    let stderrOutput = "";
    const child = spawn(bunCommand, ["install", "--silent"], {
      cwd: ROOT,
      stdio: silent ? "ignore" : ["ignore", "pipe", "pipe"],
      shell: isWindows,
      detached: silent
    });
    if (!silent) {
      child.stdout?.on("data", (data) => {
        process.stderr.write(data);
      });
      child.stderr?.on("data", (data) => {
        stderrOutput += data.toString();
        process.stderr.write(data);
      });
    }
    child.on("exit", (code) => {
      if (code === 0) {
        if (!silent) {
          console.error("[episodic-memory] Dependencies installed.");
        }
        resolve();
      } else {
        const error = new Error(`bun install failed with exit code ${code}`);
        error.stderr = stderrOutput;
        reject(error);
      }
    });
    child.on("error", (err) => {
      reject(err);
    });
    if (silent) {
      child.unref();
    }
  });
}
function analyzeError(error) {
  const stderr = error.stderr || error.message || "";
  if (stderr.includes("EACCES") || stderr.includes("permission denied")) {
    return {
      cause: "Permission denied",
      fix: "Check permissions for the project directory and Bun cache"
    };
  }
  if (stderr.includes("ENOSPC")) {
    return {
      cause: "Disk space full",
      fix: "Free up disk space and retry"
    };
  }
  if (/ETIMEDOUT|ECONNRESET|ENOTFOUND/i.test(stderr)) {
    return {
      cause: "Network error",
      fix: "Check internet connection and retry"
    };
  }
  return {
    cause: error.message || "Unknown error",
    fix: `Manual fallback: cd "${ROOT}" && bun install`
  };
}

// src/cli/mcp.ts
var __dirname3 = dirname3(fileURLToPath3(import.meta.url));
function findRoot2(start) {
  let dir = start;
  while (dir !== dirname3(dir)) {
    if (existsSync3(join4(dir, "package.json")))
      return dir;
    dir = dirname3(dir);
  }
  return start;
}
var PLUGIN_ROOT = process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || findRoot2(__dirname3);
async function ensureDependencies() {
  const { installed } = checkDependencies();
  if (!installed) {
    console.error("[episodic-memory] Installing dependencies (first run only)...");
    await installDependencies(false);
  }
}
async function runMcpCli() {
  try {
    await ensureDependencies();
  } catch (error) {
    const analysis = analyzeError(error);
    console.error("[episodic-memory] ERROR: setup failed.");
    console.error(`Cause: ${analysis.cause}`);
    console.error(`Fix: ${analysis.fix}`);
    process.exit(1);
  }
  const mcpServerPath = join4(PLUGIN_ROOT, "dist", "mcp-server.mjs");
  if (!existsSync3(mcpServerPath)) {
    console.error(`[episodic-memory] ERROR: MCP server not found at ${mcpServerPath}`);
    console.error("Please run: bun run build");
    process.exit(1);
  }
  const child = spawn2("bun", [mcpServerPath], { stdio: "inherit", shell: false });
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.stdin.on("close", () => child.kill("SIGTERM"));
  child.on("exit", (code, signal) => {
    if (signal)
      process.kill(process.pid, signal);
    else
      process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    console.error(`[episodic-memory] ERROR: Failed to start MCP server: ${err.message}`);
    process.exit(1);
  });
}

// src/core/embeddings-model.ts
init_logger();
init_paths();
var embeddingPipeline = null;
var loadingPromise = null;
var PREFIX = {
  passage: "passage: ",
  query: "query: "
};
var MAX_CONTENT_CHARS = 8000;
var MODEL_ID = "Xenova/multilingual-e5-small";
async function loadPipeline() {
  const { pipeline, env } = await import("@huggingface/transformers");
  log.info(`Loading embedding model ${MODEL_ID} (first run downloads ~150MB, may take 1-2 min)...`);
  env.cacheDir = getModelCacheDir();
  const start = Date.now();
  const result = await pipeline("feature-extraction", MODEL_ID, { dtype: "fp16" });
  const ms = Date.now() - start;
  log.info(`Embedding model loaded in ${(ms / 1000).toFixed(1)}s`, { dim: EMBEDDING_DIM, ms });
  return result;
}
async function initModel() {
  if (embeddingPipeline)
    return;
  if (!loadingPromise) {
    loadingPromise = loadPipeline();
  }
  embeddingPipeline = await loadingPromise;
}
function sliceBatchOutput(data, rows) {
  if (rows === 0)
    return [];
  const expected = rows * EMBEDDING_DIM;
  if (data.length !== expected) {
    throw new Error(`batch embedding size mismatch: expected ${rows} texts worth of floats (${expected}), got ${data.length}`);
  }
  const out = [];
  for (let r = 0;r < rows; r++) {
    const start = r * EMBEDDING_DIM;
    out.push(Array.from(Array.prototype.slice.call(data, start, start + EMBEDDING_DIM)));
  }
  return out;
}
async function generateEmbeddingsFromModel(kind, texts) {
  if (texts.length === 0)
    return [];
  if (!embeddingPipeline) {
    await initModel();
  }
  if (!embeddingPipeline)
    return [];
  const inputs = texts.map((t) => PREFIX[kind] + t.substring(0, MAX_CONTENT_CHARS));
  const output = await embeddingPipeline(inputs, {
    pooling: "mean",
    normalize: true
  });
  return sliceBatchOutput(output.data, texts.length);
}
async function generateEmbeddingFromModel(kind, text) {
  if (!embeddingPipeline) {
    await initModel();
  }
  if (!embeddingPipeline)
    return null;
  const truncated = text.substring(0, MAX_CONTENT_CHARS);
  const input = PREFIX[kind] + truncated;
  const output = await embeddingPipeline(input, {
    pooling: "mean",
    normalize: true
  });
  return Array.from(output.data);
}

// src/core/semaphore.ts
class Semaphore {
  available;
  waiters = [];
  constructor(maxConcurrent) {
    const floored = Math.floor(maxConcurrent);
    this.available = Number.isFinite(floored) ? Math.max(1, floored) : 1;
  }
  acquire() {
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }
  release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }
}
async function withSemaphore(sem, fn) {
  await sem.acquire();
  try {
    return await fn();
  } finally {
    sem.release();
  }
}

// src/core/embeddings.ts
init_config();
init_ratelimiter();

class EmbeddingError extends Error {
  constructor(message) {
    super(message);
    this.name = "EmbeddingError";
  }
}
var generateFn = generateEmbeddingFromModel;
var generateBatchFn = generateEmbeddingsFromModel;
var loadConfigFn2 = loadConfig;
var semaphore = null;
function getSemaphore() {
  if (!semaphore) {
    const configured = loadConfigFn2()?.embedding?.maxConcurrency;
    const cap = typeof configured === "number" && Number.isFinite(configured) && configured >= 1 ? configured : DEFAULT_EMBEDDING_MAX_CONCURRENCY;
    semaphore = new Semaphore(cap);
  }
  return semaphore;
}
function hasExplicitEmbeddingRateLimit() {
  return loadConfigFn2()?.ratelimit?.embedding !== undefined;
}
function isEmbeddingsDisabled() {
  return process.env.EPISODIC_MEMORY_DISABLE_EMBEDDINGS === "true";
}
async function embedQuery(text) {
  return run("query", text);
}
async function embedPassageBatch(texts) {
  if (isEmbeddingsDisabled())
    return [];
  if (texts.length === 0)
    return [];
  return withSemaphore(getSemaphore(), async () => {
    if (hasExplicitEmbeddingRateLimit())
      await getEmbeddingRateLimiter().acquire();
    let vectors;
    try {
      vectors = await generateBatchFn("passage", texts);
    } catch (err) {
      throw new EmbeddingError(`batch embedding failed: ${err.message}`);
    }
    if (vectors.length !== texts.length) {
      throw new EmbeddingError(`batch embedding returned ${vectors.length} vectors for ${texts.length} texts`);
    }
    return vectors;
  });
}
async function run(kind, text) {
  if (isEmbeddingsDisabled())
    return null;
  return withSemaphore(getSemaphore(), async () => {
    if (hasExplicitEmbeddingRateLimit())
      await getEmbeddingRateLimiter().acquire();
    let vector;
    try {
      vector = await generateFn(kind, text);
    } catch (err) {
      throw new EmbeddingError(`embedding failed (${kind}): ${err.message}`);
    }
    if (!vector) {
      throw new EmbeddingError(`embedding failed (${kind}): model returned no vector`);
    }
    return vector;
  });
}

// src/core/memory/search.ts
init_logger();

// src/core/memory/filters.ts
var SCOPING_KEYS = ["user_id", "agent_id", "run_id"];
function assertScoped(filters) {
  const hasScope = SCOPING_KEYS.some((key) => filters[key] !== undefined);
  if (!hasScope) {
    throw new Error("filters must include at least one of: user_id, agent_id, run_id");
  }
}
function field(key) {
  if (!/^[A-Za-z0-9_]+$/.test(key)) {
    throw new Error(`Invalid metadata filter key: ${key}`);
  }
  return `json_extract(metadata, '$.${key}')`;
}
function escapeLike(value) {
  return value.replace(/[\\%_]/g, (m) => `\\${m}`);
}
function escapeGlob(value) {
  return value.replace(/[\[*?]/g, (m) => `[${m}]`);
}
function operatorClause(key, op, params) {
  const parts = [];
  const col = field(key);
  if ("eq" in op) {
    parts.push(`${col} = ?`);
    params.push(op.eq);
  }
  if ("ne" in op) {
    parts.push(`${col} != ?`);
    params.push(op.ne);
  }
  if (op.in) {
    parts.push(`${col} IN (${op.in.map(() => "?").join(", ")})`);
    params.push(...op.in);
  }
  if (op.nin) {
    parts.push(`${col} NOT IN (${op.nin.map(() => "?").join(", ")})`);
    params.push(...op.nin);
  }
  if ("gt" in op) {
    parts.push(`${col} > ?`);
    params.push(op.gt);
  }
  if ("gte" in op) {
    parts.push(`${col} >= ?`);
    params.push(op.gte);
  }
  if ("lt" in op) {
    parts.push(`${col} < ?`);
    params.push(op.lt);
  }
  if ("lte" in op) {
    parts.push(`${col} <= ?`);
    params.push(op.lte);
  }
  if (op.contains !== undefined) {
    parts.push(`${col} GLOB ?`);
    params.push(`*${escapeGlob(op.contains)}*`);
  }
  if (op.icontains !== undefined) {
    parts.push(`${col} LIKE ? ESCAPE '\\'`);
    params.push(`%${escapeLike(op.icontains)}%`);
  }
  return parts.length > 1 ? `(${parts.join(" AND ")})` : parts[0] ?? "1=1";
}
function buildFilterSql(filters) {
  const params = [];
  const clause = build(filters, params);
  return { clause, params };
}
function build(filters, params) {
  const parts = [];
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined)
      continue;
    if (key === "AND") {
      const sub = value.map((f) => build(f, params)).filter(Boolean);
      if (sub.length)
        parts.push(`(${sub.join(" AND ")})`);
      continue;
    }
    if (key === "OR") {
      const sub = value.map((f) => build(f, params)).filter(Boolean);
      if (sub.length)
        parts.push(`(${sub.join(" OR ")})`);
      continue;
    }
    if (key === "NOT") {
      const sub = build(value, params);
      if (sub)
        parts.push(`NOT (${sub})`);
      continue;
    }
    if (value === "*") {
      parts.push(`${field(key)} IS NOT NULL`);
      continue;
    }
    if (Array.isArray(value)) {
      parts.push(`${field(key)} IN (${value.map(() => "?").join(", ")})`);
      params.push(...value);
      continue;
    }
    if (value !== null && typeof value === "object") {
      parts.push(operatorClause(key, value, params));
      continue;
    }
    parts.push(`${field(key)} = ?`);
    params.push(value);
  }
  return parts.join(" AND ");
}

// src/core/memory/scoring.ts
var ENTITY_BOOST_WEIGHT = 0.5;
function lemmatizeForBm25(text) {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}
function buildFtsMatchQuery(lemmatized) {
  const terms = lemmatized.split(" ").filter(Boolean);
  if (terms.length === 0)
    return "";
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
}
function getBm25Params(query, lemmatized) {
  const lemma = lemmatized ?? lemmatizeForBm25(query);
  const numTerms = lemma ? lemma.split(" ").length : 1;
  if (numTerms <= 3)
    return [5, 0.7];
  if (numTerms <= 6)
    return [7, 0.6];
  if (numTerms <= 9)
    return [9, 0.5];
  if (numTerms <= 15)
    return [10, 0.5];
  return [12, 0.5];
}
function normalizeBm25(rawScore, midpoint, steepness) {
  return 1 / (1 + Math.exp(-steepness * (rawScore - midpoint)));
}
function scoreAndRank(args) {
  const { semanticResults, bm25Scores, entityBoosts, threshold, topK, explain = false } = args;
  const hasBm25 = Object.keys(bm25Scores).length > 0;
  const hasEntity = Object.keys(entityBoosts).length > 0;
  let maxPossible = 1;
  if (hasBm25)
    maxPossible += 1;
  if (hasEntity)
    maxPossible += ENTITY_BOOST_WEIGHT;
  const scored = [];
  for (const result of semanticResults) {
    if (result.id === null || result.id === undefined)
      continue;
    const semanticScore = result.score || 0;
    if (semanticScore < threshold)
      continue;
    const memIdStr = String(result.id);
    const bm25Score = bm25Scores[memIdStr] ?? 0;
    const entityBoost = entityBoosts[memIdStr] ?? 0;
    const rawCombined = semanticScore + bm25Score + entityBoost;
    const combined = Math.min(rawCombined / maxPossible, 1);
    const scoredResult = {
      id: memIdStr,
      score: combined,
      payload: result.payload
    };
    if (explain) {
      scoredResult.score_details = {
        semantic_score: semanticScore,
        bm25_score: bm25Score,
        entity_boost: entityBoost,
        raw_score: rawCombined,
        max_possible_score: maxPossible,
        final_score: combined,
        threshold
      };
    }
    scored.push(scoredResult);
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

// src/core/memory/search.ts
var MAX_KNN_K = 4096;
var PROMOTED_PAYLOAD_KEYS = [
  "user_id",
  "agent_id",
  "run_id",
  "actor_id",
  "role",
  "attributed_to",
  "expiration_date"
];
function validateThreshold(threshold) {
  if (typeof threshold !== "number" || Number.isNaN(threshold)) {
    throw new Error("threshold must be a valid number");
  }
  if (threshold < 0 || threshold > 1) {
    throw new Error(`Invalid threshold: ${threshold}. Must be between 0 and 1 (inclusive).`);
  }
}
async function searchMemories(args) {
  const { db, query, filters, limit = 20, explain = false } = args;
  const threshold = args.threshold ?? 0.1;
  validateThreshold(threshold);
  assertScoped(filters);
  const queryLemmatized = lemmatizeForBm25(query);
  let embedding;
  try {
    embedding = await embedQuery(query);
  } catch (err) {
    if (!(err instanceof EmbeddingError))
      throw err;
    log.warn("search embedding failed; returning no results", { error: err.message });
    return { results: [] };
  }
  if (!embedding)
    return { results: [] };
  const internalLimit = Math.max(limit * 4, 60);
  const { clause, params } = buildFilterSql(filters);
  const filterClause = clause ? `AND ${clause}` : "";
  const vectorCount = db.query("SELECT COUNT(*) AS c FROM vec_memories").get().c;
  if (vectorCount === 0)
    return { results: [] };
  const maxK = Math.min(vectorCount, MAX_KNN_K);
  const semanticQuery = db.query(`
    SELECT m.id AS id, m.memory AS memory, m.hash AS hash, m.metadata AS metadata,
           m.created_at AS created_at, m.updated_at AS updated_at,
           m.rowid AS rowid, vec.distance AS distance
    FROM vec_memories vec
    INNER JOIN memories m ON m.rowid = vec.rowid
    WHERE vec.embedding MATCH ? AND vec.k = ?
      ${filterClause}
    ORDER BY vec.distance ASC
    LIMIT ?
  `);
  let k = Math.min(maxK, Math.max(internalLimit, 1));
  let semanticRows;
  for (;; ) {
    semanticRows = semanticQuery.all(Buffer.from(new Float32Array(embedding).buffer), k, ...params, internalLimit);
    if (semanticRows.length >= internalLimit || k >= maxK)
      break;
    k = Math.min(maxK, k * 2);
  }
  const byRowid = new Map(semanticRows.map((r) => [r.rowid, r]));
  const bm25Scores = {};
  if (queryLemmatized) {
    const [midpoint, steepness] = getBm25Params(query, queryLemmatized);
    try {
      const keywordRows = db.query(`
        SELECT rowid, bm25(fts_memories) AS raw
        FROM fts_memories WHERE fts_memories MATCH ?
        ORDER BY raw LIMIT ?
      `).all(buildFtsMatchQuery(queryLemmatized), internalLimit);
      for (const row of keywordRows) {
        const semantic = byRowid.get(row.rowid);
        if (!semantic)
          continue;
        const rawScore = -row.raw;
        if (rawScore > 0) {
          bm25Scores[semantic.id] = normalizeBm25(rawScore, midpoint, steepness);
        }
      }
    } catch {}
  }
  const entityBoosts = {};
  const candidates = semanticRows.map((row) => ({
    id: row.id,
    score: 1 - row.distance,
    payload: {
      data: row.memory,
      hash: row.hash,
      metadata: row.metadata,
      created_at: row.created_at,
      updated_at: row.updated_at
    }
  }));
  const scored = scoreAndRank({
    semanticResults: candidates,
    bm25Scores,
    entityBoosts,
    threshold,
    topK: limit,
    explain
  });
  const results = [];
  for (const item of scored) {
    const payload = item.payload;
    if (!payload || !payload.data)
      continue;
    const metadata = JSON.parse(payload.metadata || "{}");
    const result = {
      id: item.id,
      memory: payload.data,
      hash: payload.hash,
      metadata,
      score: item.score,
      created_at: payload.created_at,
      updated_at: payload.updated_at
    };
    for (const key of PROMOTED_PAYLOAD_KEYS) {
      if (metadata[key] !== undefined) {
        result[key] = metadata[key];
      }
    }
    if (item.score_details)
      result.score_details = item.score_details;
    results.push(result);
  }
  return { results };
}

// src/cli/search.ts
async function runSearchCli(args) {
  if (args.after || args.before) {
    throw new Error("--after/--before are not yet supported in the mem0 v2 surface");
  }
  const db = openMemoryDb();
  try {
    const filters = { user_id: LOCAL_USER_ID };
    if (args.sourceKind)
      filters.agent_id = args.sourceKind;
    const { results } = await searchMemories({
      db,
      query: args.query,
      filters,
      limit: args.limit
    });
    for (const result of results) {
      console.log(`## ${result.memory}`);
      console.log(`Score: ${Math.round(result.score * 100)}%`);
      console.log("");
    }
  } finally {
    db.close();
  }
}

// src/cli/stats.ts
function runStatsCli() {
  const db = openMemoryDb();
  try {
    const stats = getMemoryStats(db);
    console.log(`Total memories: ${stats.totalMemories}`);
    console.log(`Vectorized: ${stats.vectorizedMemories}`);
    console.log(`Missing vectors: ${stats.missingVectors}`);
  } finally {
    db.close();
  }
}

// src/cli/sync.ts
import { copyFileSync, existsSync as existsSync7, mkdirSync as mkdirSync2, readdirSync as readdirSync4, readFileSync as readFileSync3, renameSync, rmSync as rmSync2, statSync as statSync4, unlinkSync as unlinkSync2 } from "fs";
import path6 from "path";

// src/core/memory/add.ts
import { randomUUID as randomUUID2 } from "crypto";

// src/core/memory/prompts.ts
var ADDITIVE_EXTRACTION_PROMPT = `
# ROLE

You are a Memory Extractor — a precise, evidence-bound processor responsible for extracting rich, contextual memories from conversations. Your sole operation is ADD: identify every piece of memorable information and produce self-contained, contextually rich factual statements.

You extract from BOTH user and assistant messages. User messages reveal personal facts, preferences, plans, and experiences. Assistant messages contain recommendations, plans, suggestions, and actionable information the user may later reference.

Accuracy and completeness are critical. Every piece of memorable information must be captured — a missed extraction means lost context that degrades future personalization. When a conversation covers multiple topics, extract each one separately. Do not let a dominant topic cause you to miss secondary information.

# INPUTS

## New Messages

The current conversation turn(s) with "role" (user/assistant) and "content".

Both roles contain extractable information:
- **User messages**: Personal facts, preferences, plans, experiences, things done / never done before, opinions, requests, implicit preferences revealed through questions
- **Assistant messages**: Specific recommendations given, plans or schedules created, information researched, solutions provided, agreements reached

Attribute correctly: use "User" for user-stated facts. For assistant-generated content, frame in terms of the user's context (e.g., "User was recommended X" or "User's plan includes X as discussed in conversation").

Do NOT extract:
- Vague assistant characterizations ("you seem passionate", "that sounds stressful") unless the user explicitly confirms them
- Generic assistant acknowledgments ("Sure!", "Great question!")
- Assistant meta-commentary about its own capabilities


## Summary

A narrative summary of the user's profile from prior conversations. May be empty for new users. Use it to enrich extractions — it holds established context like names, locations, and relationships.


## Recently Extracted Memories

Memories already captured from recent messages in this session (up to 20). This is your primary deduplication reference — do not re-extract information already captured here.


## Existing Memories

Memories currently in the system relevant to this conversation. Formatted as:
[{"id": "uuid-string", "text": "..."}, ...]

Use these ONLY for deduplication and linking — do NOT extract new memories from Existing Memories. Your extractions must come exclusively from New Messages. If new information in New Messages is semantically equivalent to an Existing Memory with no meaningful new context, skip it.

When a new memory is related to an Existing Memory — same topic, overlapping entities, updated/shifted preference, follow-up event, or continuation of a narrative — include the Existing Memory's ID in the new memory's "linked_memory_ids" array. Your ADD output IDs remain sequential ("0", "1", ...) but linked_memory_ids uses the UUIDs from this list.


IMPORTANT: An existing memory about an entity (e.g., "User has a dog named Max") does NOT mean all information about that entity has been captured. New events, activities, experiences, or details about a known entity MUST still be extracted as separate memories and linked back. Only skip extraction when the specific fact or event itself is already captured — not merely because the entity appears in an existing memory. "User has a dog named Max" and "User went on a camping trip with Max where they hiked and swam" are two distinct memories, not duplicates.


## Last k Messages

Recent messages (up to 20) preceding New Messages. Use to resolve references and pronouns in New Messages.


## Observation Date

When the conversation actually took place (e.g., "2023-05-24"). This is your ONLY temporal anchor for resolving time references.

Resolve ALL relative references against Observation Date:
- "yesterday" → day before Observation Date
- "last week" → week preceding Observation Date
- "next month" → month following Observation Date
- "recently" → shortly before Observation Date
- "just finished", "today" → on or near Observation Date

CRITICAL: "User went to Paris last week" is useless 6 months later. "User went to Paris the week of May 15, 2023" is meaningful forever. Always ground relative references to specific dates.


## Current Date

Today's system date. May be years after Observation Date. Do NOT use this to resolve temporal references in messages — only Observation Date grounds user and assistant statements.


## Optional Inputs

- **includes**: Topics to focus on
- **excludes**: Topics to skip
- **custom_instructions**: User-defined rules (highest priority)
- **feedback_str**: Adjust extraction based on this feedback


# GUIDELINES

## What to Extract

Extract ALL memorable information from both user and assistant messages. Think broadly:

**From user messages:**
- Personal details, preferences, plans, relationships, professional context
- Health/wellness, opinions, hobbies, emotional states
- Entity attributes (breed, model, color, make, size)
- Implicit preferences revealed through requests 
- **Shared content and reference material** — when a user shares documents, case studies, articles, data, specifications, stat blocks, code, or any structured information, extract the key factual data FROM that content. The user shared it because they want it remembered.
- Firsts and milestones — 'first call-out', 'just started', 'recently joined', etc.
- Specific foods, meals, and who was present (e.g. 'dinner with mom — salads, sandwiches, homemade desserts').
- Inspiration and motivation — what inspired someone to start something, who encouraged them.

**From assistant messages (ONLY when genuinely new):**
- Specific recommendations given (books, restaurants, products, services)
- Plans or schedules created for the user
- Information researched or provided (facts, instructions, solutions)
- Agreements reached during conversation
- **Personal facts, experiences, and details shared by named speakers** — in multi-speaker conversations, the "assistant" role may represent a real person sharing their own life (e.g., "Maria: I just got a new cat named Bailey"). Extract their personal information with the same rigor as user-stated facts, attributed to the speaker by name.

Do NOT extract from assistant messages that merely restate, summarize, or confirm what the user already said. The user's own words are the primary source — if the user said it and the assistant echoed it, extract only once from the user's version. Note: a single assistant message may contain BOTH an echo AND new personal facts — skip the echo portion but still extract the new facts.

Do NOT extract: greetings, filler, vague acknowledgments, or content too generic to be useful.

**When in doubt, extract.** A slightly redundant memory is far less costly than a missing one. The deduplication system downstream will handle true duplicates — your job is to ensure nothing meaningful is lost.

### Casual Topics Are Still Extractable

Conversations about pets, hobbies, childhood memories, funny anecdotes, and personal preferences are NOT "chitchat" to be skipped. In a personal memory system, these casual revelations are often the MOST valuable — someone's pet's name, a childhood activity with a parent, a funny incident, a new hobby. Only skip messages that are PURELY phatic ("Hi!", "Sounds good!", "Thanks!") with zero informational content.

### Extract Incidental Facts, Not Just Requests

When a user asks a question or makes a request, their message often contains INCIDENTAL PERSONAL FACTS stated as context. These facts are just as extractable as the request itself:

- "I've harvested cherry tomatoes from my garden — any companion plant suggestions?" → Extract BOTH "User grows cherry tomatoes in their garden" 
- "I just started 'The Nightingale' by Kristin Hannah — can you recommend similar books?" → Extract BOTH "User started reading 'The Nightingale' by Kristin Hannah on [date]" 
- "As an aspiring stand-up comedian, can you suggest Netflix comedy specials?" → Extract BOTH the career aspiration 
- "My daughter Sara loves painting — where can I find kids' art classes?" → Extract "User has a daughter named Sara who loves painting" 

Do NOT let the request overshadow the facts. A question about companion plants is transient; the fact that the user grows cherry tomatoes is a persistent personal detail worth remembering.

**IMPORTANT — Extract ALL dimensions of a conversation.** A single session may contain career facts, entertainment preferences, scheduled plans, and personal opinions. Extract each dimension as a separate memory. Do not let one dominant topic cause you to miss secondary information.

### Shared Photos and Images

When a message contains a photo description (e.g., "[Shared photo: ...]" or describes sharing/showing an image), extract factual information from BOTH the surrounding conversation text AND the photo description. The photo description provides visual context that may contain important details:

- A photo of a group at a park → extract the activity (e.g., "had a picnic at the park")
- A photo showing a specific object, place, or person → extract what is depicted
- A photo with visible text (signs, posters, book covers) → extract the text content

## Memory Quality Standards

### Contextually Rich, Not Atomic
Capture the full picture — fact AND surrounding context — in a single unified memory, not scattered fragments.

Bad: "User has a dog" | Good: "User has a dog named Poppy and their morning walks together are the highlight of their day"

This applies especially to **transitions and changes**. When the user describes changing, switching, replacing, stopping, or trying something new in place of something else, the memory MUST capture the transition — what the new state is AND what it replaces or changes from. The relationship between old and new is critical context. Without it, the system has an isolated new fact with no understanding of what changed.

Bad: "User prefers oat milk lattes"
Good: "User switched from almond milk to oat milk lattes after developing an almond sensitivity"

Bad: "User is taking online Spanish classes on Wednesdays"
Good: "User switched from in-person French classes to online Spanish classes on Wednesdays after relocating"

When the change is explicitly temporary or a trial, capture that too — "for a month", "trying out", "testing" — these signal the old arrangement may resume.

### Clean Factual Statements
Preserve the FULL meaning including emotional reactions, motivations, and subjective experiences. Remove filler words and conversation mechanics (greetings, "like", "you know"), but KEEP:
- Emotional states: "scared but reassured", "happy and thankful", "liberated and empowered"
- Motivations and reasons: "motivated by her own journey and the support she received"
- Subjective descriptions: "resilient", "therapeutic", "nerve-wracking"

### Self-Contained
Every memory must be understandable on its own. Replace all pronouns with specific names or "User."

### Concise but Complete (15-80 words, up to 100 for detail-rich content)
1-2 sentences per memory (up to 3 for content with multiple proper nouns, specific quantities, or enumerated items). When a topic has too many details, split into multiple focused memories rather than compressing details away. NEVER sacrifice a proper noun, title, date, or specific detail to meet a word count — completeness beats brevity.

### Temporally Grounded
Preserve exact dates, durations, and temporal relationships. Convert relative → absolute using Observation Date (NOT Current Date). NEVER convert absolute → vague. "18 days" stays "18 days", not "some time."

### Numerically Precise
Preserve exact quantities as stated. "416 pages" stays "416 pages", not "about 400 pages."

### Preserve Specific Details — Never Generalize Concrete Information

When information contains specific details — whether quantities, identifiers, descriptions, visual details, quoted text, named objects, proper nouns, or any concrete information — those specifics MUST survive extraction. Replacing a specific detail with a vague category is a critical error.

#### Proper Nouns and Titles Should be Preserved

Book titles, movie titles, game names, song titles, restaurant names, neighborhood names, brand names, character names, and named places are the HIGHEST-VALUE details in a memory. Users search by name — a memory without the name is unfindable. ALWAYS preserve exact proper nouns:

- "watched 'Eternal Sunshine of the Spotless Mind'" → KEEP the full title
- "went to Woodhaven for a road trip" → KEEP "Woodhaven"
- "tried the new restaurant Osteria Francescana" → KEEP "Osteria Francescana", NOT "a new restaurant"
- "reading 'A Court of Thorns and Roses'" → KEEP the title in quotes, NOT "a fantasy book"
- "his favorite character is Aragorn from Lord of the Rings" → KEEP "Aragorn" and "Lord of the Rings"

#### Qualifiers and Specific Attributes Are Essential

Never generalize specific qualifiers. The qualifier is almost always the detail that matters most for recall:

- "promoted to assistant manager" → KEEP "assistant manager", NOT "manager"
- "ordered grilled salmon and roasted vegetables" → KEEP "grilled salmon and roasted vegetables", NOT "healthy meal"
- "started doing aerial yoga" → KEEP "aerial yoga", NOT "yoga" or "a workout class"
- "painted a forest scene in watercolors" → KEEP "a forest scene in watercolors", NOT "started painting"
- "drove a Ferrari 488 GTB" → KEEP "Ferrari 488 GTB", NOT "sports car"
- "scored 3 goals in the semifinal" → KEEP "3 goals in the semifinal", NOT "scored several goals"
- "walks her dogs multiple times a day" → KEEP "multiple times a day", NOT "regularly" or "daily"

If the input is specific, the memory must be equally specific. The concrete details are precisely what distinguishes a useful memory from a useless one. NEVER replace a specific noun, number, title, or description with a vague category or paraphrase — this destroys the information the user actually shared.

### Meaning-Preserving
Capture the EXACT meaning of what was said. Read carefully:
- "Didn't get to bed until 2 AM" = went TO BED at 2 AM (late bedtime), NOT "slept until 2 AM" (late wakeup)
- "Can't stop eating chocolate" = eats a lot of chocolate, NOT has stopped eating chocolate
- "I used to love hiking" = no longer loves hiking, NOT currently loves hiking

Misinterpreting the user's words is worse than not extracting at all.


## Integrity Rules

- **No Fabrication**: Every detail must trace to the inputs. If you can't point to where it came from, don't include it.
- **No Implicit Attribute Inference**: Don't infer gender, age, ethnicity, etc. from names or context. Only record explicitly stated attributes.
- **Correct Attribution**: Distinguish user-stated facts from assistant-provided information. Frame assistant content appropriately.
- **No Echo Extraction**: When an assistant message restates, summarizes, or confirms information the user already provided in the same conversation, do NOT extract it again from the assistant's message. Only extract from assistant messages when they contribute genuinely NEW information not already present in the user's messages — specific recommendations, newly created plans or schedules, researched facts, or solutions the assistant provided that the user did not state themselves. If the user says "I want daily check-ins at 7:30 AM" and the assistant responds "I've set up daily check-ins at 7:30 AM", that is already captured from the user's message — do not extract a second memory from the assistant's echo.
- **No Within-Response Duplication**: Each piece of information must appear exactly ONCE in your output, regardless of how many messages mention it. Before finalizing your output, review your extractions and remove any that are semantically equivalent to another extraction in the same response. Two memories about the same fact phrased differently are redundant — keep the richer one and drop the other.
- **No Meta-Extraction**: Extract the CONTENT of what was shared, not a description of the user's action. When a user shares a document, data, or reference material, extract the actual facts FROM that material.
  - WRONG: "User asked for the introductory paragraph to be shortened" / "User shared a case summary for optimization"
  - RIGHT: "The Bajimaya v Reward Homes case involved construction starting in 2014, contract signed in 2015, with completion due by October 2015" / "The tribunal found Reward Homes breached its contract through poor workmanship, waterproofing defects, and non-compliance with the Building Code of Australia"
  - WRONG: "Assistant created a D&D adventure with enemies"
  - RIGHT: "The Lost Temple of the Djinn adventure includes 4 Mummies (AC 11, 45 HP), 2 Construct Guardians (AC 17, 110 HP), and 6 Skeletal Warriors (AC 12, 22 HP)"
- **No Detail Contamination from Context**: When extracting from New Messages, do NOT import or merge details from Existing Memories or Recent Memories into the new extraction UNLESS the new message explicitly references those details. If the New Message says "I had a great meal" and an Existing Memory says "User's favorite restaurant is Olive Garden," do NOT produce "User had a great meal at Olive Garden" — the new message never mentioned the restaurant. Each extraction must be faithful to its source message only.


## Memory Linking

When extracting a new memory, check if it relates to any Existing Memory. Add related Existing Memory IDs to "linked_memory_ids". Link when:

- **Same entity/topic**: New fact about a person, place, or thing already mentioned
- **Updated preference**: A changed or evolved opinion on something previously captured
- **Continuation**: Follow-up event or next step in a previously captured narrative
- **Contradiction**: New information that conflicts with an existing memory

Do NOT link memories that merely share a vague theme. Links should be specific and meaningful — the linked memories should be about the same specific entity, event, or topic. If no existing memories are related, omit linked_memory_ids or pass an empty array.


# EXAMPLES


## Example 1: Multi-Topic Extraction

Summary: ""
Recently Extracted: []
Existing Memories: []
New Messages:
[{"role": "user", "content": "Hey! I'm Marcus. I just got promoted to Senior Engineer at Shopify last week - been grinding for two years for this. My wife Elena and I celebrated with dinner at Osteria Francescana, it's our go-to spot for special occasions. We're also expecting our first baby in March!"},
 {"role": "assistant", "content": "Congratulations on everything, Marcus! What exciting times."}]
Observation Date: 2025-08-19

Output:
{"memory": [
  {"id": "0", "text": "User's name is Marcus and was promoted to Senior Engineer at Shopify around August 12, 2025 after working toward it for two years"},
  {"id": "1", "text": "Marcus has a wife named Elena and they celebrate special occasions at Osteria Francescana, their go-to restaurant"},
  {"id": "2", "text": "Marcus and his wife Elena are expecting their first baby in March 2026"}
]}

Three distinct topics — career, relationship/dining, family milestone — each get their own memory with full context.


## Example 2: Extracting from Assistant Recommendations

Summary: "User is an aspiring stand-up comedian interested in improving their craft."
Recently Extracted: []
Existing Memories: []
New Messages:
[{"role": "user", "content": "Can you recommend some sports documentaries on Netflix with strong storytelling? I love \\"The Last Dance\\" by Michael Jordan."},
 {"role": "assistant", "content": "Great taste! Here are some Netflix documentaries known for their storytelling: 1) \\"Formula 1: Drive to Survive\\" (behind the scenes of Formula 1 racing) 2) \\"Athlete A\\" (investigative look at USA Gymnastics) 3) \\"The Battered Bastards of Baseball\\" (independent baseball story). All focus on powerful, narrative-driven sports stories."}]
Observation Date: 2023-06-01

Output:
{"memory": [
  {"id": "0", "text": "User enjoys watching sports documentaries on Netflix with strong storytelling, such as 'The Last Dance' featuring Michael Jordan"},
  {"id": "1", "text": "User was recommended the following sports documentaries on Netflix for storytelling: 'Formula 1: Drive to Survive', 'Athlete A', and 'The Battered Bastards of Baseball'"}
]}

The user's viewing preference (Netflix stand-up comedy) is extracted alongside the assistant's specific recommendations. Both are valuable for future personalization.


## Example 3: Nothing to Extract

Summary: "User is a product manager named David."
Existing Memories: [{"id": "0", "text": "David is a product manager at a fintech startup"}]
New Messages:
[{"role": "user", "content": "Hey, good morning!"},
 {"role": "assistant", "content": "Good morning, David! How can I help you today?"}]
Observation Date: 2025-08-19

Output: {"memory": []}

## Example 5: Deduplication — Skip Already Captured

Recently Extracted: ["Marcus was promoted to Senior Engineer at Shopify around August 12, 2025"]
Existing Memories: [{"id": "0", "text": "Marcus was promoted to Senior Engineer at Shopify around August 12, 2025"}]
New Messages:
[{"role": "user", "content": "Still can't believe I got the senior engineer promotion at Shopify!"}]
Observation Date: 2025-08-19

Output: {"memory": []}


## Example 6: Extract ALL Dimensions — Don't Miss Secondary Info

Summary: "User is an aspiring actor."
Recently Extracted: []
Existing Memories: []
New Messages:
[{"role": "user", "content": "As an aspiring actor, I'm looking for advice on improving my craft. Can you recommend some films on Netflix with strong acting performances like Daniel Day-Lewis in 'There Will Be Blood'? I also want to find online resources for acting techniques."},
 {"role": "assistant", "content": "For Netflix films with great acting, check out 'Marriage Story' and 'The Irishman'. For acting techniques, I'd recommend 'An Actor Prepares' by Stanislavski and the MasterClass by Helen Mirren."}]
Observation Date: 2023-06-01

Output:
{"memory": [
  {"id": "0", "text": "User is an aspiring actor seeking to improve their craft through studying films with strong performances and acting technique resources"},
  {"id": "1", "text": "User enjoys watching films on Netflix with outstanding acting, especially performances like Daniel Day-Lewis in 'There Will Be Blood'"},
  {"id": "2", "text": "User was recommended 'Marriage Story' and 'The Irishman' for performance study, 'An Actor Prepares' by Stanislavski, and Helen Mirren's MasterClass for acting techniques"}
]}

Three dimensions: (1) career aspiration, (2) entertainment viewing preference, (3) specific recommendations. Each extracted separately.


## Example 7: Vague Temporal References with Historical Observation Date

Recently Extracted: ["User started reading 'The Hitchhiker's Guide to the Galaxy' on January 16, 2022"]
Existing Memories: [{"id": "0", "text": "User started reading 'The Hitchhiker's Guide to the Galaxy' on January 16, 2022"}]
New Messages:
[{"role": "user", "content": "I've actually listened to Ready Player One as an audiobook recently and enjoyed the pop culture references."}]
Observation Date: 2022-01-16
Current Date: 2026-02-18

Output:
{"memory": [{"id": "0", "text": "User listened to the Ready Player One audiobook around early January 2022 and enjoyed the pop culture references"}]}

"Recently" is grounded to the Observation Date (January 2022), NOT Current Date (February 2026). The Hitchhiker's Guide memory already exists — not re-extracted.


## Example 8: Document / Reference Material — Extract Content, Not Actions

Summary: ""
Recently Extracted: []
Existing Memories: []
New Messages:
[{"role": "user", "content": "I want you to remember this case. If you understand, just say acknowledged. Bajimaya v Reward Homes Pty Ltd [2021] NSWCATAP 297 — The construction began in 2014, contract signed in 2015 with completion due by October 2015. The plaintiff received keys in December 2016 and found defects including incomplete works, poor workmanship, and non-compliance with the building code. The tribunal found the builder breached contract."},
 {"role": "assistant", "content": "Acknowledged."}]
Observation Date: 2024-03-10

Output:
{"memory": [
  {"id": "0", "text": "Bajimaya v Reward Homes Pty Ltd [2021] NSWCATAP 297: construction of the home began in 2014, contract signed in 2015, with completion due by October 2015. Keys were delivered in December 2016."},
  {"id": "1", "text": "In Bajimaya v Reward Homes, the plaintiff found defects including incomplete works, poor workmanship, and non-compliance with the Building Code of Australia after receiving the home in December 2016."},
  {"id": "2", "text": "The tribunal found Reward Homes Pty Ltd breached its contract with Mr. Bajimaya by failing to complete work in a proper and workmanlike manner and failing to comply with plans, specifications, and the Building Code."}
]}

The user shared reference material to be remembered. Extract the actual factual content — dates, parties, findings — NOT "User shared a case summary" or "User asked to remember a case."


## Example 9: Structured Data with Counts and Specifics

Summary: ""
Recently Extracted: []
Existing Memories: []
New Messages:
[{"role": "user", "content": "Here are the enemy stat blocks for our D&D campaign: Mummies (4): AC 11, HP 45, Speed 20 ft, with Curse of the Pharaohs (DC 15 Wisdom) and Mummy Rot (DC 15 Constitution). Construct Guardians (2): AC 17, HP 110, Speed 30 ft, with Immutable Form, Magic Resistance, and Siege Monster. Skeletal Warriors (6): AC 12, HP 22, Speed 30 ft, with Undead Fortitude."},
 {"role": "assistant", "content": "Got it! I've noted all the stat blocks. Ready when you want to start the encounter."}]
Observation Date: 2024-01-15

Output:
{"memory": [
  {"id": "0", "text": "User's D&D campaign encounter includes 4 Mummies (AC 11, 45 HP, Speed 20 ft) with Curse of the Pharaohs (DC 15 Wisdom save) and Mummy Rot (DC 15 Constitution save)"},
  {"id": "1", "text": "User's D&D campaign encounter includes 2 Construct Guardians (AC 17, 110 HP, Speed 30 ft) with Immutable Form, Magic Resistance, and Siege Monster traits"},
  {"id": "2", "text": "User's D&D campaign encounter includes 6 Skeletal Warriors (AC 12, 22 HP, Speed 30 ft) with the Undead Fortitude trait"}
]}

Every count (4 Mummies, 2 Construct Guardians, 6 Skeletal Warriors) and every specific value (AC, HP, DCs, trait names) is preserved. Dropping the counts or stat values would destroy the most queryable information.


## Example 10: Memory Linking — Connecting Related Memories

Summary: ""
Recently Extracted: []
Existing Memories: [{"id": "a1b2c3d4-5678-9abc-def0-111111111111", "text": "User has a dog named Poppy, a golden retriever"}, {"id": "b2c3d4e5-6789-abcd-ef01-222222222222", "text": "User works as a Senior Engineer at Shopify"}]
New Messages:
[{"role": "user", "content": "Poppy had her vet checkup yesterday — she's healthy but needs to lose a few pounds. Also, I'm switching teams at work next month to the payments platform."}]
Observation Date: 2025-03-15

Output:
{"memory": [
  {"id": "0", "text": "User's dog Poppy had a vet checkup around March 14, 2025, is healthy but needs to lose weight", "linked_memory_ids": ["a1b2c3d4-5678-9abc-def0-111111111111"]},
  {"id": "1", "text": "User is switching teams at Shopify to the payments platform in April 2025", "linked_memory_ids": ["b2c3d4e5-6789-abcd-ef01-222222222222"]}
]}

Both new memories link to related existing memories — the vet checkup links to the existing Poppy memory, and the team switch links to the existing Shopify memory. This enables the system to build a graph of related memories.


## Example 11: Long Multi-Topic Conversation — Don't Stop After First Topic

Summary: ""
Recently Extracted: []
Existing Memories: []
New Messages:
[{"role": "user", "content": "I adopted a puppy named Max last weekend! He's a beagle mix."},
 {"role": "assistant", "content": "Congratulations! How's he settling in?"},
 {"role": "user", "content": "Great! Oh, and I also started pottery classes on Tuesdays. Made a mug with my daughter's face on it."},
 {"role": "assistant", "content": "Fun! Sounds like a lot going on."},
 {"role": "user", "content": "Yeah — my sister just moved to Portland too. I'm happy but honestly a bit overwhelmed. My boss gave me a promotion to team lead last week as well."}]
Observation Date: 2025-03-10

Output:
{"memory": [
  {"id": "0", "text": "User adopted a beagle mix puppy named Max around March 1-2, 2025"},
  {"id": "1", "text": "User started taking pottery classes on Tuesdays"},
  {"id": "2", "text": "User made a ceramic mug with their daughter's face on it in pottery class"},
  {"id": "3", "text": "User's sister recently moved to Portland"},
  {"id": "4", "text": "User was promoted to team lead around March 3, 2025, and feels happy but overwhelmed about all the recent changes"}
]}

FIVE topics across 5 messages — each one extracted separately. Do not stop after the first topic (the puppy). The pottery mug detail, the sister's move, and the emotional reaction to the promotion are all distinct, extractable facts.


## Example 12: Multi-Speaker Conversation — Extract From ALL Speakers

Summary: "John has a dog named Max."
Recently Extracted: []
Existing Memories: [{"id": "a1b2c3d4-0000-0000-0000-111111111111", "text": "John has a dog named Max"}]
New Messages:
[{"role": "user", "content": "John: Max and I had a blast on our camping trip last summer. We hiked, swam, and made great memories. It was a really peaceful experience."},
 {"role": "assistant", "content": "Maria: That sounds amazing! I actually just got a new cat named Bailey last week — she's been such a joy already. Camping with pets is so soul-nourishing."},
 {"role": "user", "content": "John: Congrats on Bailey! Here's a picture of my family too — that was from a trip we took for my daughter Sara's birthday last fall."}]
Observation Date: 2023-08-11

Output:
{"memory": [
  {"id": "0", "text": "John and his dog Max went on a camping trip in the summer of 2023 where they hiked, swam, and found it a peaceful experience", "linked_memory_ids": ["a1b2c3d4-0000-0000-0000-111111111111"]},
  {"id": "1", "text": "Maria got a new cat named Bailey around early August 2023 and describes her as a joy"},
  {"id": "2", "text": "John has a daughter named Sara and the family took a trip for her birthday in fall 2022"}
]}

Three key lessons: (1) The existing memory "John has a dog named Max" does NOT mean all Max-related information is captured — the camping trip is a new event with specific activities (hiking, swimming) and must be extracted and linked. (2) Maria is a named speaker in the "assistant" role but shares a genuine personal fact (new cat Bailey) — this MUST be extracted with the same rigor as user facts. Her echo ("that sounds amazing", "camping is soul-nourishing") is correctly skipped, but her personal fact is not. (3) Sara's name and the birthday trip are separate factual details that each deserve their own extraction.


# CRITICAL: Exhaustive Extraction Checklist

Before producing output, mentally scan the ENTIRE conversation — every single message — and verify:
1. Have you extracted at least one memory from every distinct topic or subject change in the conversation?
2. Have you extracted facts from messages in the MIDDLE and END of the conversation, not just the beginning?
3. For conversations with 10+ messages, you should typically extract 5-15 memories. If you have fewer than 3, re-read the conversation — you are almost certainly missing information.
4. Re-read each user message individually: does EVERY specific fact, preference, experience, or event mentioned in that message have a corresponding extraction? If a single message mentions two distinct facts (e.g., an allergy AND a hobby), both must be captured.

A common failure mode is "first topic dominance" — the extractor captures the first major topic thoroughly, then treats subsequent topics as filler. This is WRONG. Every topic mentioned deserves extraction if it contains memorable facts. If a chunk has 8 messages covering 4 different topics, you MUST produce memories for all 4 topics — not just the first or most prominent one.


# OUTPUT FORMAT

Return ONLY valid JSON parsable by json.loads(). No text, reasoning, explanations, or wrappers.

## Structure

{
  "memory": [
    {"id": "0", "text": "First extracted memory", "attributed_to": "user", "linked_memory_ids": ["uuid-of-related-existing-memory"]},
    {"id": "1", "text": "Second extracted memory", "attributed_to": "assistant"}
  ]
}

## Fields

- **id** (string, required): Sequential integers as strings starting at "0".
- **text** (string, required): A contextually rich, self-contained factual statement (15-80 words).
- **attributed_to** (string, required): Who this memory is about. Use "user" for facts stated by or about the user (preferences, plans, personal facts). Use "assistant" for information provided by the assistant (recommendations, confirmations, plans created, information researched).
- **linked_memory_ids** (array of strings, optional): IDs of Existing Memories that this new memory relates to. Use the exact IDs from the Existing Memories list. Omit or pass [] if no existing memories are related.

## Rules

- Extract every piece of memorable information as a separate memory object.
- If nothing is worth extracting, return: {"memory": []}
- No duplicate IDs. Use double quotes. No trailing commas.

`;
var ENTITY_EXTRACTION_SUFFIX = `

# ENTITY EXTRACTION (ADDITIONAL OUTPUT FIELD)

For each memory object, also include an "entities" array listing the named entities that appear in that memory's "text". Each entity is {"type": "...", "text": "..."}.

Entity types:
- **PROPER**: proper nouns — person names, places, brands, products, titles (e.g. "Poppy", "Shopify", "Osteria Francescana")
- **QUOTED**: quoted titles or specific terms (e.g. "The Last Dance")
- **TOPIC**: specific multi-word noun phrases (e.g. "machine learning", "aerial yoga")
- **IDENTIFIER**: technical identifiers — dotted or dashed names, ticket keys, file names (e.g. "scoring.py", "SEARCH-14333")

Rules:
- Extract only entities that literally appear in the memory text.
- Skip generic single nouns ("user", "dog", "work") and dates/numbers.
- Omit the field or pass [] when a memory has no entities.

Example memory object with entities:
{"id": "0", "text": "User has a dog named Poppy and walks her in Woodhaven", "attributed_to": "user", "entities": [{"type": "PROPER", "text": "Poppy"}, {"type": "PROPER", "text": "Woodhaven"}]}
`;
var PAST_MESSAGE_TRUNCATION_LIMIT = 300;
function truncate(text, limit = PAST_MESSAGE_TRUNCATION_LIMIT) {
  return text.length <= limit ? text : text.slice(0, limit);
}
function formatSummary(summary) {
  return summary && summary.trim() ? summary : "";
}
function formatConversationHistory(messages) {
  if (!messages || messages.length === 0)
    return "";
  return messages.map((m) => `${m.role}: ${truncate(m.content)}`).join(`
`);
}
function serializeMemories(memories) {
  if (!memories || memories.length === 0)
    return "[]";
  return JSON.stringify(memories.map((m) => ({ id: m.id, text: m.text })), null, 0).replace(/},"/g, '}, "').replace(/\{"id":/g, '{"id": ').replace(/,"text":/g, ', "text": ');
}
function formatNewMessages(messages) {
  return JSON.stringify(messages.map((m) => ({ role: m.role, content: m.content })));
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}
function generateAdditiveExtractionPrompt(args) {
  const now = new Date;
  const currentDate = args.currentDate ?? isoDate(now);
  const observationDate = args.observationDate ?? currentDate;
  const sections = [
    `## Summary
${formatSummary(args.summary)}`,
    `## Last k Messages
${formatConversationHistory(args.lastKMessages)}`,
    `## Recently Extracted Memories
${serializeMemories(args.recentlyExtractedMemories)}`,
    `## Existing Memories
${serializeMemories(args.existingMemories)}`,
    `## New Messages
${formatNewMessages(args.newMessages)}`,
    `## Observation Date
${observationDate}`,
    `## Current Date
${currentDate}`
  ];
  if (args.customInstructions) {
    sections.push(`## Custom Instructions
${args.customInstructions}`);
  }
  sections.push("# Output:");
  return sections.join(`

`);
}

// src/core/memory/extract.ts
class LLMError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "LLMError";
  }
}
function parseEntities(raw) {
  if (!Array.isArray(raw))
    return [];
  const out = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null)
      continue;
    const row = item;
    if (typeof row.text !== "string" || row.text.trim() === "")
      continue;
    out.push({
      type: typeof row.type === "string" ? row.type : null,
      text: row.text.trim()
    });
  }
  return out;
}
function stripFences(text) {
  const trimmed = text.trim();
  const lines = trimmed.split(`
`);
  const openIdx = lines.findIndex((l) => l.trim().startsWith("```"));
  if (openIdx === -1)
    return trimmed;
  let end = lines.length;
  for (let i = openIdx + 1;i < lines.length; i++) {
    if (lines[i].trim().startsWith("```")) {
      end = i;
      break;
    }
  }
  return lines.slice(openIdx + 1, end).join(`
`).trim();
}
function parseExtractionResponse(raw) {
  let parsed;
  try {
    parsed = JSON.parse(stripFences(raw));
  } catch (error) {
    throw new LLMError("extraction response was not valid JSON", { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null || !("memory" in parsed)) {
    throw new LLMError('extraction response missing "memory" key');
  }
  const list = parsed.memory;
  if (!Array.isArray(list)) {
    throw new LLMError('extraction response "memory" was not an array');
  }
  const out = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null)
      continue;
    const row = item;
    if (typeof row.text !== "string" || row.text.trim() === "")
      continue;
    if (row.attributed_to !== "user" && row.attributed_to !== "assistant")
      continue;
    out.push({
      id: String(row.id ?? out.length),
      text: row.text.trim(),
      attributed_to: row.attributed_to,
      linked_memory_ids: Array.isArray(row.linked_memory_ids) ? row.linked_memory_ids.filter((v) => typeof v === "string") : [],
      entities: parseEntities(row.entities)
    });
  }
  return out;
}
async function extractMemories(provider, args) {
  const prompt = generateAdditiveExtractionPrompt(args);
  let response;
  try {
    response = await provider.complete(prompt, {
      systemPrompt: ADDITIVE_EXTRACTION_PROMPT + ENTITY_EXTRACTION_SUFFIX,
      maxTokens: 4000
    });
  } catch (error) {
    throw new LLMError("extraction provider call failed", { cause: error });
  }
  return parseExtractionResponse(response.text);
}

// src/core/memory/store.ts
import { createHash, randomUUID } from "crypto";
function md5(text) {
  return createHash("md5").update(text).digest("hex");
}
function getMemoryRowid(db, id) {
  const row = db.query("SELECT rowid AS r FROM memories WHERE id = ?").get(id);
  return row ? row.r : null;
}
function getExistingHashes(db, hashes) {
  if (hashes.length === 0)
    return new Set;
  const placeholders = hashes.map(() => "?").join(",");
  const rows = db.query(`SELECT hash FROM memories WHERE hash IN (${placeholders})`).all(...hashes);
  return new Set(rows.map((r) => r.hash));
}
function insertMemories(db, rows) {
  const result = { inserted: [], skipped: [] };
  if (rows.length === 0)
    return result;
  const hashes = rows.map((r) => md5(r.memory));
  const existing = getExistingHashes(db, hashes);
  const seenInBatch = new Set;
  const now = Date.now();
  const insertMemory = db.query("INSERT INTO memories (id, memory, hash, metadata, created_at, updated_at) VALUES (?,?,?,?,?,?)");
  const insertVec = db.query("INSERT INTO vec_memories(rowid, embedding) VALUES (?, ?)");
  const insertFts = db.query("INSERT INTO fts_memories(rowid, text_lemmatized) VALUES (?, ?)");
  db.transaction(() => {
    for (const [i, row] of rows.entries()) {
      const hash = hashes[i];
      if (existing.has(hash) || seenInBatch.has(hash)) {
        result.skipped.push(row.id);
        continue;
      }
      seenInBatch.add(hash);
      insertMemory.run(row.id, row.memory, hash, JSON.stringify(row.metadata ?? {}), now, now);
      const rowid = getMemoryRowid(db, row.id);
      insertVec.run(rowid, Buffer.from(new Float32Array(row.embedding).buffer));
      insertFts.run(rowid, lemmatizeForBm25(row.memory));
      result.inserted.push(row.id);
    }
  })();
  return result;
}
function recordHistory(db, entries) {
  if (entries.length === 0)
    return;
  const now = Date.now();
  const stmt = db.query("INSERT INTO history (memory_id, old_memory, new_memory, event, created_at, is_deleted) VALUES (?,?,?,?,?,0)");
  db.transaction(() => {
    for (const e of entries)
      stmt.run(e.memory_id, e.old_memory, e.new_memory, e.event, now);
  })();
}
function deleteMemoriesByRunIds(db, runIds) {
  if (runIds.length === 0)
    return 0;
  const placeholders = runIds.map(() => "?").join(",");
  const rows = db.query(`SELECT rowid AS r, id FROM memories WHERE json_extract(metadata, '$.run_id') IN (${placeholders})`).all(...runIds);
  const rowids = rows.map((row) => row.r);
  if (rowids.length === 0)
    return 0;
  const deletedIds = new Set(rows.map((row) => row.id));
  const rowidPlaceholders = rowids.map(() => "?").join(",");
  const deleteVec = db.query(`DELETE FROM vec_memories WHERE rowid IN (${rowidPlaceholders})`);
  const deleteFts = db.query(`DELETE FROM fts_memories WHERE rowid IN (${rowidPlaceholders})`);
  const deleteMemories = db.query(`DELETE FROM memories WHERE rowid IN (${rowidPlaceholders})`);
  db.transaction(() => {
    deleteVec.run(...rowids);
    deleteFts.run(...rowids);
    deleteMemories.run(...rowids);
    removeMemoriesFromEntities(db, deletedIds);
  })();
  return rowids.length;
}
function removeMemoriesFromEntities(db, deletedIds) {
  const entities = db.query("SELECT rowid AS r, linked_memory_ids AS l FROM entities").all();
  const update = db.query("UPDATE entities SET linked_memory_ids = ? WHERE rowid = ?");
  const deleteVec = db.query("DELETE FROM vec_entities WHERE rowid = ?");
  const deleteEntity = db.query("DELETE FROM entities WHERE rowid = ?");
  for (const entity of entities) {
    const linked = JSON.parse(entity.l);
    const remaining = linked.filter((id) => !deletedIds.has(id));
    if (remaining.length === linked.length)
      continue;
    if (remaining.length === 0) {
      deleteVec.run(entity.r);
      deleteEntity.run(entity.r);
    } else {
      update.run(JSON.stringify(remaining), entity.r);
    }
  }
}
function normalizeEntityText(value) {
  return value.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}
var ENTITY_SEMANTIC_MATCH_THRESHOLD = 0.95;
function entitySimilarity(a, b) {
  let sum = 0;
  for (let i = 0;i < b.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return 1 - Math.sqrt(sum);
}
function linkEntities(db, entities, scope) {
  if (entities.length === 0)
    return;
  const scopeEntries = Object.entries(scope).filter(([, v]) => v !== undefined && v !== null);
  const scopeClause = scopeEntries.map(() => "json_extract(metadata, ?) = ?").join(" AND ");
  const scopeParams = scopeEntries.flatMap(([k, v]) => [`$.${k}`, String(v)]);
  const scoped = db.query(`SELECT rowid AS r, data, linked_memory_ids FROM entities${scopeClause ? ` WHERE ${scopeClause}` : ""}`).all(...scopeParams);
  const byNormalized = new Map;
  for (const row of scoped) {
    const normalized = normalizeEntityText(row.data);
    if (normalized && !byNormalized.has(normalized))
      byNormalized.set(normalized, row);
  }
  const selectVec = db.query("SELECT embedding FROM vec_entities WHERE rowid = ?");
  const vectorOf = (rowid) => {
    const row = selectVec.get(rowid);
    if (!row)
      return null;
    const buf = row.embedding;
    return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  };
  const update = db.query("UPDATE entities SET linked_memory_ids = ? WHERE rowid = ?");
  const insert = db.query("INSERT INTO entities (id, data, entity_type, linked_memory_ids, metadata, created_at) VALUES (?,?,?,?,?,?)");
  const selectRowid = db.query("SELECT rowid AS r FROM entities WHERE id = ?");
  const insertVec = db.query("INSERT INTO vec_entities(rowid, embedding) VALUES (?, ?)");
  const now = Date.now();
  const metadataJson = JSON.stringify(Object.fromEntries(scopeEntries));
  db.transaction(() => {
    for (const entity of entities) {
      const normalized = normalizeEntityText(entity.data);
      if (!normalized)
        continue;
      let match = byNormalized.get(normalized) ?? null;
      if (!match) {
        for (const row of scoped) {
          const vec = vectorOf(row.r);
          if (vec && entitySimilarity(entity.embedding, vec) >= ENTITY_SEMANTIC_MATCH_THRESHOLD) {
            match = row;
            break;
          }
        }
      }
      if (match) {
        const merged = Array.from(new Set([
          ...JSON.parse(match.linked_memory_ids),
          ...entity.memory_ids
        ])).sort();
        match.linked_memory_ids = JSON.stringify(merged);
        update.run(match.linked_memory_ids, match.r);
        continue;
      }
      const id = randomUUID();
      insert.run(id, entity.data, entity.entity_type, JSON.stringify([...entity.memory_ids].sort()), metadataJson, now);
      const rowid = selectRowid.get(id).r;
      insertVec.run(rowid, Buffer.from(new Float32Array(entity.embedding).buffer));
    }
  })();
}

// src/core/memory/add.ts
init_logger();
var EXISTING_MEMORY_TOP_K = 10;
var SESSION_CONTEXT_LIMIT = 10;
var MAX_KNN_K2 = 4096;
async function addMemories(args) {
  const { db, provider, messages, filters, metadata = {}, observationDate } = args;
  const lastKMessages = messages.slice(-SESSION_CONTEXT_LIMIT);
  const existingMemories = await retrieveExisting(db, messages, filters);
  const remapped = existingMemories.map((m, i) => ({ id: String(i), text: m.text }));
  const extracted = await extractMemories(provider, {
    newMessages: messages,
    lastKMessages,
    existingMemories: remapped,
    observationDate
  });
  if (extracted.length === 0)
    return { results: [] };
  const embeddings = await embedPassageBatch(extracted.map((m) => m.text));
  if (embeddings.length === 0)
    return { results: [] };
  const rows = [];
  for (const [i, m] of extracted.entries()) {
    rows.push({
      id: randomUUID2(),
      memory: m.text,
      metadata: {
        ...metadata,
        ...filters,
        attributed_to: m.attributed_to
      },
      embedding: embeddings[i]
    });
  }
  const { inserted } = insertMemories(db, rows);
  const insertedSet = new Set(inserted);
  const stored = rows.filter((r) => insertedSet.has(r.id));
  recordHistory(db, stored.map((r) => ({
    memory_id: r.id,
    old_memory: null,
    new_memory: r.memory,
    event: "ADD"
  })));
  try {
    await linkExtractedEntities(db, extracted, rows, insertedSet, filters);
  } catch (err) {
    log.warn("entity linking failed; memories were stored without entity links", {
      error: err.message
    });
  }
  return {
    results: stored.map((r) => ({ id: r.id, memory: r.memory, event: "ADD" }))
  };
}
async function linkExtractedEntities(db, extracted, rows, insertedSet, filters) {
  const globalEntities = new Map;
  for (const [i, m] of extracted.entries()) {
    const row = rows[i];
    if (!insertedSet.has(row.id))
      continue;
    for (const entity of m.entities) {
      const key = normalizeEntityText(entity.text);
      if (!key)
        continue;
      const existing = globalEntities.get(key);
      if (existing)
        existing.memoryIds.add(row.id);
      else
        globalEntities.set(key, { type: entity.type, text: entity.text, memoryIds: new Set([row.id]) });
    }
  }
  if (globalEntities.size === 0)
    return;
  const list = Array.from(globalEntities.values());
  const embeddings = await embedPassageBatch(list.map((e) => e.text));
  if (embeddings.length === 0)
    return;
  const scope = {};
  for (const key of ["user_id", "agent_id", "run_id"]) {
    if (filters[key] !== undefined && filters[key] !== null)
      scope[key] = filters[key];
  }
  const links = list.map((e, i) => ({
    data: e.text,
    entity_type: e.type,
    memory_ids: Array.from(e.memoryIds),
    embedding: embeddings[i]
  }));
  linkEntities(db, links, scope);
}
async function retrieveExisting(db, messages, filters) {
  const vectorCount = db.query("SELECT COUNT(*) AS c FROM vec_memories").get().c;
  if (vectorCount === 0)
    return [];
  const batchText = messages.map((m) => m.content).join(`
`);
  const embedding = await embedQuery(batchText);
  if (!embedding)
    return [];
  const { clause, params } = buildFilterSql(filters);
  const filterClause = clause ? `AND ${clause}` : "";
  const maxK = Math.min(vectorCount, MAX_KNN_K2);
  const existingQuery = db.query(`
    SELECT m.id AS id, m.memory AS text
    FROM vec_memories vec
    INNER JOIN memories m ON m.rowid = vec.rowid
    WHERE vec.embedding MATCH ? AND vec.k = ?
      ${filterClause}
    ORDER BY vec.distance ASC
    LIMIT ?
  `);
  let k = Math.min(maxK, EXISTING_MEMORY_TOP_K);
  let rows;
  for (;; ) {
    rows = existingQuery.all(Buffer.from(new Float32Array(embedding).buffer), k, ...params, EXISTING_MEMORY_TOP_K);
    if (rows.length >= EXISTING_MEMORY_TOP_K || k >= maxK)
      break;
    k = Math.min(maxK, k * 2);
  }
  return rows;
}

// src/core/sync-run.ts
init_logger();
async function indexPendingArchives(args) {
  const { files, provider, extractionBudget, readArchiveFile, markIndexed, indexSpan } = args;
  const result = {
    filesIndexed: 0,
    memoriesAdded: 0,
    skipped: 0,
    failed: 0
  };
  const total = files.length;
  if (total > 0) {
    log.info(`Indexing ${total} archive file${total === 1 ? "" : "s"}...`);
  }
  let remainingBudget = extractionBudget;
  const progressInterval = Math.max(1, Math.floor(total / 20));
  for (const file of files) {
    if (provider && remainingBudget <= 0) {
      log.info("Extraction budget exhausted; deferring remaining files to next sync", {
        remaining: total - result.filesIndexed
      });
      break;
    }
    const content = readArchiveFile(file.archivePath);
    if (content === null) {
      result.skipped++;
      continue;
    }
    const spans = file.adapter.parse(content, {
      archivePath: file.archivePath,
      sourceKind: file.adapter.kind
    });
    if (!provider) {
      result.filesIndexed++;
      logProgress(result.filesIndexed, total, progressInterval);
      continue;
    }
    let hadFailure = false;
    for (const span of spans) {
      remainingBudget--;
      try {
        result.memoriesAdded += await indexSpan(file, span, provider);
      } catch (error) {
        hadFailure = true;
        result.failed++;
        log.warn("Span extraction failed; continuing sync.", {
          archivePath: file.archivePath,
          lineStart: span.lineStart,
          lineEnd: span.lineEnd,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    if (!hadFailure) {
      markIndexed(file.archivePath, file.mtimeMs);
      result.filesIndexed++;
    }
    logProgress(result.filesIndexed, total, progressInterval);
  }
  return result;
}
function logProgress(indexed, total, interval) {
  if (indexed % interval === 0 || indexed === total) {
    log.info(`  ${indexed}/${total} indexed`);
  }
}

// src/core/llm/index.ts
init_gemini_provider();
init_zai_provider();
init_config();

// src/cli/sync.ts
init_logger();

// src/core/lock.ts
init_paths();
init_logger();
import { mkdirSync, readFileSync as readFileSync2, rmSync, statSync as statSync3, writeFileSync } from "fs";
import path3 from "path";
var STALE_MS = 30 * 60 * 1000;
function lockPath() {
  return path3.join(getIndexDir(), "sync.lock");
}
function tryCreate(lockDir) {
  try {
    mkdirSync(lockDir);
    writeFileSync(path3.join(lockDir, "pid"), String(process.pid));
    return true;
  } catch (error) {
    if (error.code === "EEXIST") {
      return false;
    }
    throw error;
  }
}
function readHolderPid(lockDir) {
  try {
    const pid = Number(readFileSync2(path3.join(lockDir, "pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
function isProcessDead(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}
function isAbandoned(lockDir) {
  const pid = readHolderPid(lockDir);
  if (pid !== null) {
    return isProcessDead(pid);
  }
  try {
    return Date.now() - statSync3(lockDir).mtimeMs > STALE_MS;
  } catch {
    return false;
  }
}
function acquireSyncLock() {
  const lockDir = lockPath();
  if (tryCreate(lockDir)) {
    return makeRelease(lockDir);
  }
  if (isAbandoned(lockDir)) {
    log.warn("Reclaiming abandoned sync lock", { lockDir });
    rmSync(lockDir, { recursive: true, force: true });
    if (tryCreate(lockDir)) {
      return makeRelease(lockDir);
    }
  }
  return null;
}
function makeRelease(lockDir) {
  let released = false;
  return () => {
    if (released)
      return;
    released = true;
    rmSync(lockDir, { recursive: true, force: true });
  };
}

// src/cli/sync.ts
init_paths();

// src/core/sources/claude.ts
import { existsSync as existsSync5 } from "fs";
import os2 from "os";
import path4 from "path";

// src/core/sources/jsonl.ts
function asObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function asString(value) {
  return typeof value === "string" ? value : null;
}
function parseTimestamp(value) {
  if (typeof value !== "string")
    return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}
function eachJsonLine(content, fn) {
  const lines = content.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!line.trim())
      continue;
    let item;
    try {
      item = asObject(JSON.parse(line));
    } catch {
      continue;
    }
    if (item)
      fn(item, index + 1);
  }
}

// src/core/sources/claude.ts
function parseClaudeJsonl(content, context) {
  const spans = [];
  let current = null;
  const flushCurrent = () => {
    if (!current)
      return;
    const assistantText = current.assistantTexts.join(`
`);
    const text = formatSpanText(current.userText, assistantText);
    if (text.trim()) {
      const messages = [];
      if (current.userText.trim())
        messages.push({ role: "user", content: current.userText.trim() });
      if (assistantText.trim())
        messages.push({ role: "assistant", content: assistantText.trim() });
      spans.push({
        archivePath: current.archivePath,
        lineStart: current.lineStart,
        lineEnd: current.lineEnd,
        sourceKind: current.sourceKind,
        observedAt: current.observedAt,
        text,
        messages
      });
    }
    current = null;
  };
  eachJsonLine(content, (item, lineNumber) => {
    const message = asObject(item.message);
    const role = asString(message?.role) ?? asString(item.type);
    const messageContent = message && "content" in message ? message.content : undefined;
    if (role === "user") {
      if (isToolResultContent(messageContent)) {
        if (current)
          current.lineEnd = lineNumber;
        return;
      }
      flushCurrent();
      const userText = extractText(messageContent).trim();
      current = {
        archivePath: context.archivePath,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        sourceKind: context.sourceKind,
        observedAt: parseTimestamp(item.timestamp),
        userText,
        assistantTexts: []
      };
      return;
    }
    if (!current)
      return;
    current.lineEnd = lineNumber;
    current.observedAt ??= parseTimestamp(item.timestamp);
    if (role === "assistant") {
      const text = extractText(messageContent).trim();
      if (text)
        current.assistantTexts.push(text);
    }
  });
  flushCurrent();
  return spans;
}
function createClaudeProjectsAdapter() {
  return createClaudeAdapter("claude-code-projects", "projects");
}
function createClaudeTranscriptsAdapter() {
  return createClaudeAdapter("claude-code-transcripts", "transcripts");
}
function createClaudeAdapter(kind, dirname4) {
  return {
    kind,
    roots() {
      const root = path4.join(process.env.CLAUDE_CONFIG_DIR || path4.join(os2.homedir(), ".claude"), dirname4);
      return existsSync5(root) ? [root] : [];
    },
    detect(filePath) {
      return filePath.endsWith(".jsonl");
    },
    parse: parseClaudeJsonl
  };
}
function formatSpanText(userText, assistantText) {
  const parts = [];
  if (userText.trim())
    parts.push(`User: ${userText.trim()}`);
  if (assistantText.trim())
    parts.push(`Assistant: ${assistantText.trim()}`);
  return parts.join(`
`);
}
function extractText(value) {
  if (typeof value === "string")
    return value;
  if (!Array.isArray(value))
    return "";
  return value.map((block) => {
    const object = asObject(block);
    if (!object)
      return "";
    if (typeof object.text === "string")
      return object.text;
    if (typeof object.content === "string")
      return object.content;
    return "";
  }).filter(Boolean).join(`
`);
}
function isToolResultContent(value) {
  if (!Array.isArray(value))
    return false;
  return value.some((block) => asObject(block)?.type === "tool_result");
}

// src/core/sources/codex.ts
import { existsSync as existsSync6 } from "fs";
import os3 from "os";
import path5 from "path";
function parseCodexJsonl(content, context) {
  const spans = [];
  let current = null;
  const flushCurrent = () => {
    if (!current)
      return;
    const assistantText = current.assistantTexts.join(`
`);
    const text = formatSpanText2(current.userText, assistantText);
    if (text.trim()) {
      const messages = [];
      if (current.userText.trim())
        messages.push({ role: "user", content: current.userText.trim() });
      if (assistantText.trim())
        messages.push({ role: "assistant", content: assistantText.trim() });
      spans.push({
        archivePath: context.archivePath,
        lineStart: current.lineStart,
        lineEnd: current.lineEnd,
        sourceKind: context.sourceKind,
        observedAt: current.observedAt,
        text,
        messages
      });
    }
    current = null;
  };
  eachJsonLine(content, (item, lineNumber) => {
    if (item.type !== "response_item")
      return;
    const payload = asObject(item.payload);
    if (!payload)
      return;
    if (payload.type === "message") {
      const role = asString(payload.role);
      if (role === "user") {
        flushCurrent();
        current = {
          lineStart: lineNumber,
          lineEnd: lineNumber,
          observedAt: parseTimestamp(item.timestamp),
          userText: extractText2(payload.content).trim(),
          assistantTexts: []
        };
        return;
      }
      if (role === "assistant" && current) {
        current.lineEnd = lineNumber;
        current.observedAt ??= parseTimestamp(item.timestamp);
        const text = extractText2(payload.content).trim();
        if (text)
          current.assistantTexts.push(text);
      }
      return;
    }
    if (!current)
      return;
    current.lineEnd = lineNumber;
    current.observedAt ??= parseTimestamp(item.timestamp);
  });
  flushCurrent();
  return spans;
}
function createCodexSessionsAdapter() {
  return {
    kind: "codex-sessions",
    roots() {
      const root = path5.join(process.env.CODEX_HOME ?? path5.join(os3.homedir(), ".codex"), "sessions");
      return existsSync6(root) ? [root] : [];
    },
    detect(filePath) {
      return filePath.endsWith(".jsonl");
    },
    parse: parseCodexJsonl
  };
}
function formatSpanText2(userText, assistantText) {
  const parts = [];
  if (userText.trim())
    parts.push(`User: ${userText.trim()}`);
  if (assistantText.trim())
    parts.push(`Assistant: ${assistantText.trim()}`);
  return parts.join(`
`);
}
function extractText2(value) {
  if (typeof value === "string")
    return value;
  if (!Array.isArray(value))
    return "";
  return value.map((block) => {
    const object = asObject(block);
    if (!object)
      return "";
    if (typeof object.text === "string")
      return object.text;
    return "";
  }).filter(Boolean).join(`
`);
}

// src/core/sources/index.ts
function getBuiltInSourceAdapters() {
  return [createClaudeProjectsAdapter(), createClaudeTranscriptsAdapter(), createCodexSessionsAdapter()];
}

// src/cli/sync.ts
var EXTRACTION_BUDGET_PER_SYNC = 12;
function mapSourceToFilters(source) {
  return {
    user_id: LOCAL_USER_ID,
    agent_id: source.sourceKind,
    run_id: path6.basename(source.archivePath, path6.extname(source.archivePath))
  };
}
async function syncArchives(db, options = {}) {
  const archiveDir = getArchiveDir();
  const archiveFiles = new Map;
  const provider = options.provider !== undefined ? options.provider : await loadExtractionProvider();
  const stats = {
    filesScanned: 0,
    filesIndexed: 0,
    memoriesAdded: 0,
    skipped: 0,
    failed: 0
  };
  for (const adapter of getBuiltInSourceAdapters()) {
    for (const root of adapter.roots()) {
      const excludedSourceDirs = [];
      for (const sourcePath of findJsonlFiles(root, adapter, excludedSourceDirs)) {
        const archivePath = path6.join(archiveDir, adapter.kind, path6.relative(root, sourcePath));
        try {
          copyIfNewer(sourcePath, archivePath);
        } catch (error) {
          log.warn("Failed to copy transcript; continuing sync.", {
            sourcePath,
            archivePath,
            error: error instanceof Error ? error.message : String(error)
          });
        }
        if (existsSync7(archivePath)) {
          archiveFiles.set(archivePath, { adapter, archivePath });
        }
      }
      for (const sourceDir of excludedSourceDirs) {
        const archivePathPrefix = path6.join(archiveDir, adapter.kind, path6.relative(root, sourceDir));
        purgeExcludedArchiveSubtree(db, archivePathPrefix, archiveFiles);
      }
    }
    const adapterArchiveRoot = path6.join(archiveDir, adapter.kind);
    if (existsSync7(adapterArchiveRoot)) {
      for (const archivePath of findJsonlFiles(adapterArchiveRoot, adapter)) {
        archiveFiles.set(archivePath, { adapter, archivePath });
      }
    }
  }
  stats.filesScanned = archiveFiles.size;
  const pendingFiles = [];
  for (const file of archiveFiles.values()) {
    const mtimeMs = statSync4(file.archivePath).mtimeMs;
    if (getArchiveIndexMtime(db, file.archivePath) === mtimeMs) {
      stats.skipped++;
      continue;
    }
    pendingFiles.push({ ...file, mtimeMs });
  }
  pendingFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const indexingResult = await indexPendingArchives({
    files: pendingFiles,
    provider,
    extractionBudget: EXTRACTION_BUDGET_PER_SYNC,
    readArchiveFile,
    markIndexed: (archivePath, mtimeMs) => setArchiveIndexMtime(db, archivePath, mtimeMs),
    indexSpan: async (file, span, activeProvider) => {
      const filters = mapSourceToFilters({ sourceKind: file.adapter.kind, archivePath: file.archivePath });
      const result = await addMemories({
        db,
        provider: activeProvider,
        messages: span.messages,
        filters,
        observationDate: span.observedAt ? new Date(span.observedAt).toISOString().slice(0, 10) : undefined
      });
      return result.results.length;
    }
  });
  stats.filesIndexed = indexingResult.filesIndexed;
  stats.memoriesAdded += indexingResult.memoriesAdded;
  stats.skipped += indexingResult.skipped;
  stats.failed += indexingResult.failed;
  return stats;
}
async function runSyncCli() {
  const release = acquireSyncLock();
  if (!release) {
    log.info("sync already running; skipping");
    return;
  }
  const db = openMemoryDb();
  try {
    const result = await syncArchives(db);
    log.info(`Done.`, { ...result });
  } finally {
    db.close();
    release();
  }
}
async function loadExtractionProvider() {
  try {
    const config = loadConfig();
    return config ? await createProvider(config) : null;
  } catch {
    return null;
  }
}
function readArchiveFile(archivePath) {
  try {
    return readFileSync3(archivePath, "utf-8");
  } catch {
    return null;
  }
}
function findJsonlFiles(root, adapter, excludedDirs = []) {
  const files = [];
  if (existsSync7(path6.join(root, ".no-episodic-memory"))) {
    excludedDirs.push(root);
    return files;
  }
  for (const entry of readdirSync4(root, { withFileTypes: true })) {
    const entryPath = path6.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonlFiles(entryPath, adapter, excludedDirs));
    } else if (entry.isFile() && entryPath.endsWith(".jsonl") && adapter.detect(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}
function purgeExcludedArchiveSubtree(db, archivePathPrefix, archiveFiles) {
  for (const archivePath of archiveFiles.keys()) {
    if (isPathAtOrUnder(archivePath, archivePathPrefix)) {
      archiveFiles.delete(archivePath);
    }
  }
  const runIds = collectJsonlRunIds(archivePathPrefix);
  if (runIds.length > 0) {
    deleteMemoriesByRunIds(db, runIds);
  }
  if (existsSync7(archivePathPrefix)) {
    rmSync2(archivePathPrefix, { recursive: true, force: true });
  }
}
function collectJsonlRunIds(archivePathPrefix) {
  if (!existsSync7(archivePathPrefix))
    return [];
  const stat = statSync4(archivePathPrefix);
  if (stat.isFile()) {
    return archivePathPrefix.endsWith(".jsonl") ? [path6.basename(archivePathPrefix, path6.extname(archivePathPrefix))] : [];
  }
  const runIds = [];
  for (const entry of readdirSync4(archivePathPrefix, { withFileTypes: true })) {
    const entryPath = path6.join(archivePathPrefix, entry.name);
    if (entry.isDirectory()) {
      runIds.push(...collectJsonlRunIds(entryPath));
    } else if (entry.isFile() && entryPath.endsWith(".jsonl")) {
      runIds.push(path6.basename(entryPath, path6.extname(entryPath)));
    }
  }
  return runIds;
}
function isPathAtOrUnder(filePath, parentPath) {
  const relative = path6.relative(parentPath, filePath);
  return relative === "" || !relative.startsWith("..") && !path6.isAbsolute(relative);
}
function copyIfNewer(sourcePath, destinationPath) {
  const sourceBefore = statSync4(sourcePath);
  if (existsSync7(destinationPath) && statSync4(destinationPath).mtimeMs >= sourceBefore.mtimeMs) {
    return false;
  }
  mkdirSync2(path6.dirname(destinationPath), { recursive: true });
  const tmpPath = `${destinationPath}.tmp-${process.pid}-${Date.now()}`;
  copyFileSync(sourcePath, tmpPath);
  const sourceAfter = statSync4(sourcePath);
  if (sourceBefore.size !== sourceAfter.size || sourceBefore.mtimeMs !== sourceAfter.mtimeMs) {
    unlinkIfExists(tmpPath);
    return false;
  }
  renameSync(tmpPath, destinationPath);
  return true;
}
function unlinkIfExists(filePath) {
  if (existsSync7(filePath)) {
    unlinkSync2(filePath);
  }
}

// src/cli/verify.ts
function runVerifyCli() {
  const db = openMemoryDb();
  try {
    const result = verifyMemoryIndex(db);
    const issueCount = result.missingVectors.length + result.orphanVectors.length;
    console.log(`Total memories: ${result.totalMemories}`);
    if (issueCount === 0) {
      console.log("No memory index issues found.");
      return;
    }
    console.log(`Memory index issues: ${issueCount}`);
    console.log(`Missing vectors: ${result.missingVectors.length}`);
    console.log(`Orphan vectors: ${result.orphanVectors.length}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

// src/cli/main.ts
function requireOptionValue(args, index, flag) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}
function parsePositiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return parsed;
}
function parseSearchArgs(args) {
  const parsed = { query: "" };
  const queryParts = [];
  for (let i = 1;i < args.length; i++) {
    const arg = args[i];
    if (arg === "--after") {
      parsed.after = requireOptionValue(args, i, arg);
      i++;
    } else if (arg === "--before") {
      parsed.before = requireOptionValue(args, i, arg);
      i++;
    } else if (arg === "--source-kind") {
      parsed.sourceKind = requireOptionValue(args, i, arg);
      i++;
    } else if (arg === "--limit") {
      parsed.limit = parsePositiveInteger(requireOptionValue(args, i, arg), arg);
      i++;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      queryParts.push(arg);
    }
  }
  parsed.query = queryParts.join(" ").trim();
  if (!parsed.query) {
    throw new Error("search requires a query");
  }
  return parsed;
}
function getHelpText() {
  return `
episodic-memory - Event/fact memory for Claude Code and Codex transcripts

USAGE:
  episodic-memory <command>

COMMANDS:
  sync      Copy transcripts and extract memory records
  search    Search indexed memory records
  stats     Print memory index statistics
  verify    Verify memory index integrity
  doctor    Diagnose build, index, and data health
  mcp       Start the MCP server (used by .mcp.json)

SEARCH OPTIONS:
  --limit <number>        Maximum number of results
  --after <YYYY-MM-DD>    Not yet supported; errors (mem0 v2 surface)
  --before <YYYY-MM-DD>   Not yet supported; errors (mem0 v2 surface)
  --source-kind <kind>    Filter by transcript source kind

EXAMPLES:
  episodic-memory search "source of truth" --limit 5

ENVIRONMENT VARIABLES:
  CONVERSATION_MEMORY_CONFIG_DIR   Override config directory
  CONVERSATION_MEMORY_DB_PATH      Override database path
`;
}
function printHelp() {
  console.log(getHelpText());
}
function spawnBackgroundSync() {
  Bun.spawn([process.execPath, process.argv[1], "sync"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore"
  }).unref();
}
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    process.exit(0);
  }
  switch (command) {
    case "sync":
      if (args.includes("--background")) {
        spawnBackgroundSync();
        break;
      }
      await runSyncCli();
      break;
    case "search":
      await runSearchCli(parseSearchArgs(args));
      break;
    case "stats":
      runStatsCli();
      break;
    case "verify":
      runVerifyCli();
      break;
    case "doctor":
      runDoctorCli();
      break;
    case "mcp":
      await runMcpCli();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run with --help for usage information.");
      process.exit(1);
  }
}
if (__require.main == __require.module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
export {
  getHelpText,
  parseSearchArgs
};
