---
name: setup
description: This skill provides configuration guidance for the memmem plugin. Invoke explicitly when user requests to configure plugin settings.
version: 1.0.0
---

# Configure Conversation Memory

This skill provides guidance for configuring the memmem plugin,
including LLM settings for memory-record extraction, API key configuration,
project exclusions, and environment variables.

## Config File Location

The memmem plugin uses a configuration file at:

```text
~/.config/memmem/config.json
```

Create this directory and file if it doesn't exist:

```bash
mkdir -p ~/.config/memmem
```

## LLM Provider Configuration

Archive sync does not require an LLM provider configuration.
Memory extraction during indexing does require a configured LLM provider.
Without one, transcript spans are skipped and no memory rows are created for those spans.

### Supported Providers

1. **Gemini** (Google AI) - `gemini-2.0-flash` (default)
2. **Z.AI** (GLM models) - `glm-4.7` (default)

### Gemini Configuration

```json
{
  "provider": "gemini",
  "apiKey": "your-gemini-api-key",
  "model": "gemini-2.0-flash"
}
```

**Getting a Gemini API key:**

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Create a new API key
3. Add it to your config.json

### Z.AI Configuration

```json
{
  "provider": "zai",
  "apiKey": "your-zai-api-key",
  "model": "glm-4.7"
}
```

### Configuration Options

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `provider` | string | Yes | - | `gemini` or `zai` |
| `apiKey` | string | Single-key mode only | - | API key for the provider |
| `providers` | array | Round-robin mode only | - | Non-empty list of `{ apiKey, model? }` entries |
| `model` | string | No | Provider-specific | Model name (see below) |

Use top-level `provider` with either a single `apiKey`, or a non-empty `providers[]` list to rotate across multiple keys/models.

**Default models:**

- Gemini: `gemini-2.0-flash`
- Z.AI: `glm-4.7`

## Project Exclusions

Exclude a conversation directory from indexing by placing a `.no-memmem` marker file in that directory:

```bash
touch /path/to/conversation/dir/.no-memmem
```

During sync, memmem skips directories containing `.no-memmem` and removes any already archived/indexed content for that subtree.

For single-conversation inline exclusion markers such as `DO NOT INDEX THIS CHAT`, see the README exclusion section.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CONVERSATION_MEMORY_CONFIG_DIR` | Override config directory location |
| `CONVERSATION_MEMORY_DB_PATH` | Override database path |
| `CONVERSATION_MEMORY_DEBUG` | Set to `true` for debug logging |
| `TEST_ARCHIVE_DIR` | Override archive directory (testing only) |
| `TEST_DB_PATH` | Test database path (testing only) |

## Verify Configuration

Test your configuration:

```bash
# Sync transcripts and extract memory records when a provider is configured
memmem sync

# Enable debug logging
CONVERSATION_MEMORY_DEBUG=true memmem sync

# Verify index health
memmem verify

# Check logs
tail -f ~/.config/memmem/logs/$(date +%Y-%m-%d).log
```

## Troubleshooting

### Invalid API Key

**Symptoms:** Authentication failed, invalid API key errors

**Solution:**

- Verify API key is correct in config.json
- Check API key hasn't expired
- Ensure API key has sufficient balance

### Network Errors

**Symptoms:** Timeout, connection errors

**Solution:**

- Check internet connection
- Configure proxy if behind corporate firewall
- Verify provider service status

### Model Not Found

**Symptoms:** "model not found" or "invalid model"

**Solution:**

- Verify model name spelling
- Check provider documentation for available models
- Use default model (omit `model` field)

### No Memory Records Generated

**Symptoms:** Archive sync works, but indexed memory search has no results or logs show skipped spans.

**Solution:**

- Verify config.json exists at `~/.config/memmem/config.json`
- Check config.json has valid JSON syntax
- Ensure `provider` is present with either `apiKey` or a non-empty `providers[]` list
- Re-run `memmem sync` after configuring the provider so extraction can create memory rows

## Example Configurations

See [examples/](./examples/) directory for complete working examples:

- `examples/gemini-config.json` - Gemini configuration
- `examples/zai-config.json` - Z.AI configuration

## Further Reading

- [README.md](../../../README.md) - Main plugin documentation
- [skills/remembering-conversations/SKILL.md](../remembering-conversations/SKILL.md) - Using conversation search
