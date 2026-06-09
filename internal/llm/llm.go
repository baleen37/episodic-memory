// Package llm is the LLM provider layer used by the indexer's extractor.
//
// Ports src/core/llm/ (types.ts, config.ts, extractor.ts, gemini-provider.ts,
// zai-provider.ts, round-robin-provider.ts, index.ts). Everything sits behind
// an LLMProvider interface; loadConfig() returns nil when unconfigured, and
// createProvider() supports single-provider and providers[] round-robin modes.
//
// TODO(phase2): port the provider interface, config loading, and the bounded,
// idempotent, schema-validated, failure-tolerant extractor.
package llm
