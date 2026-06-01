# Strict Default Ratelimit Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Set default rate limiting for both embedding and LLM calls to strict 1 request per 2 seconds (0.5 RPS) with no burst by default.

**Architecture:** Keep the existing token-bucket implementation and singleton factories. Change only default constants and default burst fallback logic in `src/core/ratelimiter.ts`, then update tests to drive and verify behavior. Preserve config override behavior when users explicitly set `requestsPerSecond` and/or `burstSize`.

**Tech Stack:** TypeScript, Vitest, Node.js (npm)

---

### Task 1: Add failing tests for new default policy

**Files:**
- Modify: `src/core/ratelimiter.test.ts`
- Test: `src/core/ratelimiter.test.ts`

**Step 1: Write the failing test expectations (default constructor + factory defaults)**

Update these assertions:

```ts
// Configuration: defaults when not specified
const defaultLimiter = new RateLimiter();
expect(defaultLimiter.getAvailableTokens()).toBe(1);

// Config Integration: embedding default
const embeddingLimiter = getEmbeddingRateLimiter();
expect(embeddingLimiter.getAvailableTokens()).toBe(1);

// Config Integration: llm default
const llmLimiter = getLLMRateLimiter();
expect(llmLimiter.getAvailableTokens()).toBe(1);
```

Update test names/comments that currently describe `2x requests per second` default burst so they describe `burst defaults to 1`.

**Step 2: Run test to verify it fails**

Run: `npm test src/core/ratelimiter.test.ts`

Expected: FAIL on default token count assertions (currently expecting old defaults like 10/4/2x burst behavior).

**Step 3: Commit test-only red state**

```bash
git add src/core/ratelimiter.test.ts
git commit -m "test: codify strict default ratelimit behavior"
```

---

### Task 2: Implement minimal production changes

**Files:**
- Modify: `src/core/ratelimiter.ts`
- Test: `src/core/ratelimiter.test.ts`

**Step 1: Change default RPS constants to 0.5**

```ts
const DEFAULT_EMBEDDING_RPS = 0.5;
const DEFAULT_LLM_RPS = 0.5;
```

**Step 2: Change default burst fallback from multiplier to 1**

Apply this in constructor and both factory functions when `burstSize` is omitted:

```ts
this.maxTokens = config.burstSize ?? 1;

// in factories
burstSize: ratelimitConfig?.burstSize ?? 1,
```

Do not change queue/refill algorithm or public API.

**Step 3: Run targeted tests**

Run: `npm test src/core/ratelimiter.test.ts`

Expected: PASS.

**Step 4: Commit implementation**

```bash
git add src/core/ratelimiter.ts src/core/ratelimiter.test.ts
git commit -m "feat: make default ratelimits strict at 0.5 rps"
```

---

### Task 3: Verify no regression in repository tests

**Files:**
- Test: repository test suite

**Step 1: Run full tests**

Run: `npm test`

Expected: PASS with no new failures.

**Step 2: Commit verification state (if additional fixes required)**

If any follow-up change is required to keep tests green, make minimal fix and commit with focused message. If no further changes, skip extra commit.

---

### Task 4: Final quality checks

**Files:**
- Modify (if needed): `src/core/ratelimiter.ts`, `src/core/ratelimiter.test.ts`

**Step 1: Type check**

Run: `npm run typecheck`

Expected: PASS.

**Step 2: Build check**

Run: `npm run build`

Expected: PASS.

**Step 3: Final commit (only if Task 3/4 produced code changes)**

```bash
git add src/core/ratelimiter.ts src/core/ratelimiter.test.ts
git commit -m "chore: align ratelimiter defaults and verification"
```
