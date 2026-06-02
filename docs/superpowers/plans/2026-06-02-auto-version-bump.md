# Auto Version Bump on Main Merge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** main에 머지될 때 semantic-release가 Conventional Commits를 분석해 버전을 자동으로 올리고, 4개 메타데이터 파일을 갱신하고, git 태그와 GitHub Release를 발행하도록 만든다.

**Architecture:** 신규 `release.yml` 워크플로우가 `push: main`에서 `semantic-release`를 실행한다. semantic-release는 `release.config.cjs`를 따르며, `prepare` 단계에서 `scripts/sync-plugin-versions.sh`를 호출해 plugin.json ×2 + marketplace.json을 package.json 버전에 맞춘다. 기존 `on-release.yml`(마켓플레이스 디스패치)은 Release published를 받아 그대로 동작한다. 더 이상 필요 없는 `update-versions.yml`과 그 전용 테스트는 삭제한다.

**Tech Stack:** semantic-release (Node), GitHub Actions, jq, bash, bun (기존 테스트 러너)

---

## File Structure

| 파일 | 동작 | 책임 |
| ---- | ---- | ---- |
| `scripts/sync-plugin-versions.sh` | Create | package.json 버전을 읽어 plugin.json ×2 + marketplace.json에 기록 |
| `scripts/sync-plugin-versions.test.sh` | Create | 위 스크립트가 4개 파일 버전을 정렬하는지 검증 |
| `release.config.cjs` | Create | semantic-release 플러그인 체인 설정 |
| `.github/workflows/release.yml` | Create | main push → semantic-release 실행 |
| `.github/workflows/update-versions.yml` | Delete | cron 정렬기, semantic-release가 대체 |
| `scripts/verify-update-versions-workflow.test.sh` | Delete | 위 워크플로우 전용 테스트 |
| `package.json` | Modify | semantic-release devDependencies 추가 |

---

## Task 1: 버전 정렬 스크립트 추출

기존 `update-versions.yml`의 "Align standalone plugin metadata" 단계 jq 로직을
독립 실행 가능한 스크립트로 옮긴다. semantic-release `prepare`에서 호출되고,
삭제될 워크플로우의 정렬 책임을 흡수한다.

**Files:**
- Create: `scripts/sync-plugin-versions.sh`
- Test: `scripts/sync-plugin-versions.test.sh`

- [ ] **Step 1: Write the failing test**

`scripts/sync-plugin-versions.test.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Arrange: 임시 작업 디렉터리에 버전이 어긋난 메타데이터 파일들을 만든다.
workdir="$(mktemp -d)"
trap 'rm -rf "$workdir"' EXIT

mkdir -p "$workdir/.claude-plugin" "$workdir/.codex-plugin"
echo '{"version":"9.9.9","name":"memmem"}' > "$workdir/package.json"
echo '{"version":"0.0.0","name":"memmem"}' > "$workdir/.claude-plugin/plugin.json"
echo '{"version":"0.0.0","name":"memmem"}' > "$workdir/.codex-plugin/plugin.json"
echo '{"plugins":[{"name":"memmem","version":"0.0.0"}]}' > "$workdir/.claude-plugin/marketplace.json"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Act: 스크립트를 임시 디렉터리에서 실행한다.
( cd "$workdir" && bash "$SCRIPT_DIR/sync-plugin-versions.sh" )

# Assert: 세 파일이 모두 package.json 버전(9.9.9)에 정렬됐다.
fail=0
check() {
  local label="$1" actual="$2"
  if [[ "$actual" != "9.9.9" ]]; then
    echo "FAIL: $label expected 9.9.9 got $actual"
    fail=1
  fi
}
check "claude plugin.json" "$(jq -r '.version' "$workdir/.claude-plugin/plugin.json")"
check "codex plugin.json"  "$(jq -r '.version' "$workdir/.codex-plugin/plugin.json")"
check "marketplace.json"   "$(jq -r '.plugins[0].version' "$workdir/.claude-plugin/marketplace.json")"

if [[ "$fail" -ne 0 ]]; then
  echo "sync-plugin-versions.test.sh FAILED"
  exit 1
fi
echo "sync-plugin-versions.test.sh PASSED"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/sync-plugin-versions.test.sh`
Expected: FAIL — `scripts/sync-plugin-versions.sh` 가 없어서 `bash: ... No such file` 에러로 비정상 종료.

- [ ] **Step 3: Write the script**

`scripts/sync-plugin-versions.sh` (기존 `update-versions.yml` 27-47줄의 jq 로직을 이전):

```bash
#!/usr/bin/env bash
set -euo pipefail

# package.json 버전을 단일 진실원본으로 삼아 나머지 메타데이터 파일에 기록한다.
version="$(jq -r '.version' package.json)"

tmp="$(mktemp)"
jq --arg version "$version" '.version = $version' \
  .claude-plugin/plugin.json > "$tmp"
mv "$tmp" .claude-plugin/plugin.json

tmp="$(mktemp)"
jq --arg version "$version" '.version = $version' \
  .codex-plugin/plugin.json > "$tmp"
mv "$tmp" .codex-plugin/plugin.json

tmp="$(mktemp)"
jq --arg version "$version" '.plugins[0].version = $version' \
  .claude-plugin/marketplace.json > "$tmp"
mv "$tmp" .claude-plugin/marketplace.json
```

- [ ] **Step 4: Make it executable and run the test**

Run:
```bash
chmod +x scripts/sync-plugin-versions.sh
bash scripts/sync-plugin-versions.test.sh
```
Expected: `sync-plugin-versions.test.sh PASSED`

- [ ] **Step 5: Verify it is idempotent (run on already-aligned repo)**

Run:
```bash
bash scripts/sync-plugin-versions.sh
git diff --quiet .claude-plugin/plugin.json .codex-plugin/plugin.json .claude-plugin/marketplace.json && echo "NO CHANGES (idempotent)"
```
Expected: `NO CHANGES (idempotent)` — 현재 4파일 모두 1.1.2라 변경 없음.

- [ ] **Step 6: Commit**

```bash
git add scripts/sync-plugin-versions.sh scripts/sync-plugin-versions.test.sh
git commit -m "feat(ci): add plugin version sync script"
```

---

## Task 2: semantic-release 설정 추가

**Files:**
- Create: `release.config.cjs`
- Modify: `package.json` (devDependencies)

- [ ] **Step 1: Add semantic-release devDependencies**

`package.json`의 `devDependencies`에 추가 (기존 항목 유지, 알파벳 순):

```json
  "devDependencies": {
    "@semantic-release/exec": "^6.0.3",
    "@semantic-release/git": "^10.0.1",
    "@types/bun": "^1.3.9",
    "bun-types": "^1.3.9",
    "semantic-release": "^24.2.0",
    "typescript": "^5.3.3"
  }
```

(주: `@semantic-release/commit-analyzer`, `release-notes-generator`, `npm`,
`github`은 `semantic-release` 코어에 번들되어 별도 설치 불필요.)

- [ ] **Step 2: Install to update lockfile**

Run: `bun install`
Expected: `bun.lockb` 갱신, 에러 없음. (로컬에는 bun과 dist가 있어 postinstall
빌드 스텝이 통과한다. CI 환경의 postinstall 회피는 Task 3에서 다룬다.)

- [ ] **Step 3: Write release.config.cjs**

`release.config.cjs`:

```js
// semantic-release 설정.
// 동작: main 머지 시 Conventional Commits 분석 → 버전 계산 →
//   package.json 갱신(@semantic-release/npm, publish 안 함) →
//   plugin.json ×2 + marketplace.json 정렬(@semantic-release/exec) →
//   4개 파일 커밋 + 태그(@semantic-release/git) → GitHub Release(@semantic-release/github).
module.exports = {
  branches: ['main'],
  plugins: [
    '@semantic-release/commit-analyzer',
    '@semantic-release/release-notes-generator',
    [
      '@semantic-release/npm',
      { npmPublish: false },
    ],
    [
      '@semantic-release/exec',
      {
        // npm 플러그인이 package.json 버전을 쓴 뒤, 나머지 메타데이터를 정렬한다.
        prepareCmd: 'bash scripts/sync-plugin-versions.sh',
      },
    ],
    [
      '@semantic-release/git',
      {
        assets: [
          'package.json',
          '.claude-plugin/plugin.json',
          '.codex-plugin/plugin.json',
          '.claude-plugin/marketplace.json',
        ],
        // [skip ci]로 release 커밋이 release.yml을 재트리거하지 않게 막는다.
        message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
      },
    ],
    '@semantic-release/github',
  ],
};
```

- [ ] **Step 4: Validate config with a dry run (no write, no push)**

Run:
```bash
npx semantic-release --dry-run --no-ci --branches main 2>&1 | tail -30
```
Expected: 설정 로드에 성공하고 플러그인 체인이 인식된다. (인증 없이 실행하므로
GitHub 단계에서 토큰 경고/스킵이 날 수 있으나, "Loaded plugin" 류 로그와 다음
버전 계산 시도가 보이면 OK. config 파싱 에러나 "Cannot find module
@semantic-release/..."가 나오면 FAIL.)

- [ ] **Step 5: Commit**

```bash
git add release.config.cjs package.json bun.lockb
git commit -m "feat(ci): configure semantic-release for auto version bump"
```

---

## Task 3: release.yml 워크플로우 추가

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Write release.yml**

`.github/workflows/release.yml`:

```yaml
name: Release

on:
  push:
    branches: [main]

permissions:
  contents: write
  issues: write
  pull-requests: write

jobs:
  release:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout repository
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install semantic-release toolchain
        # package.json devDependencies의 semantic-release 플러그인만 설치한다.
        # --ignore-scripts: postinstall(scripts/conditional-build.sh → `bun run build`)을
        # 건너뛴다. 이 job에는 bun이 없고, 릴리스에 dist 빌드가 필요 없기 때문.
        # (기존 ci.yml도 --ignore-scripts를 사용해 일관됨.)
        run: npm install --ignore-scripts --no-audit --no-fund

      - name: Run semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npx semantic-release
```

주: semantic-release는 Node 도구이므로 워크플로우에서 npm으로 설치/실행한다
(프로젝트 런타임이 bun이어도 무방 — semantic-release는 빌드/테스트가 아니라
릴리스 오케스트레이션만 한다). semantic-release 플러그인은 Task 2에서 package.json
devDependencies에 선언되므로 `npm install`이 그것을 설치한다.

**중요 — postinstall 함정**: `package.json`의 `postinstall`은
`scripts/conditional-build.sh`를 부르고, 그 스크립트는 `dist/`가 없으면
`bun run build`를 실행한다. CI release job에는 bun이 없고 checkout 직후 dist도
없으므로, `--ignore-scripts` 없이 `npm install`하면 `bun: command not found`로
job이 실패한다. 따라서 위 install 스텝은 반드시 `--ignore-scripts`를 쓴다.

`persist-credentials: false`는 semantic-release가 자체적으로 `GITHUB_TOKEN`을
써서 push하도록 두기 위함.

- [ ] **Step 2: Lint the workflow YAML locally**

Run:
```bash
npx --yes yaml-lint .github/workflows/release.yml 2>/dev/null || node -e "require('js-yaml')" 2>/dev/null || python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('YAML OK')"
```
Expected: `YAML OK` (또는 linter가 에러 없이 통과). 구문 오류가 나면 FAIL.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "feat(ci): add release workflow on main push"
```

---

## Task 4: update-versions 워크플로우 제거

semantic-release가 정렬을 대신하므로 cron 정렬기와 전용 테스트를 삭제한다.
사전 grep으로 두 파일이 서로만 참조함을 확인했다.

**Files:**
- Delete: `.github/workflows/update-versions.yml`
- Delete: `scripts/verify-update-versions-workflow.test.sh`

- [ ] **Step 1: Remove the files**

Run:
```bash
git rm .github/workflows/update-versions.yml scripts/verify-update-versions-workflow.test.sh
```

- [ ] **Step 2: Verify no dangling references remain**

Run:
```bash
grep -rn "update-versions\|verify-update-versions-workflow" . \
  --include="*.yml" --include="*.json" --include="*.sh" --include="*.ts" --include="*.md" \
  | grep -v node_modules | grep -v "docs/superpowers"
```
Expected: 출력 없음 (exit 1). docs/superpowers 안의 설계/계획 문서 언급은 무시.
다른 출력이 있으면 그 참조를 먼저 처리해야 하므로 FAIL.

- [ ] **Step 3: Confirm on-release.yml is untouched**

Run: `git status --short .github/workflows/`
Expected: `release.yml`는 추가(A 또는 untracked가 이미 커밋됨), `update-versions.yml`는
삭제(D), `on-release.yml`는 목록에 없음(변경 안 됨).

- [ ] **Step 4: Commit**

```bash
git commit -m "chore(ci): remove update-versions workflow superseded by semantic-release"
```

---

## Task 5: 전체 검증

**Files:** (없음 — 검증만)

- [ ] **Step 1: Run the project test suite**

Run: `bun test`
Expected: 기존 테스트 전부 통과. (이번 변경은 CI 설정/스크립트라 런타임 코드
테스트에 영향 없어야 함.)

- [ ] **Step 2: Run the new script test**

Run: `bash scripts/sync-plugin-versions.test.sh`
Expected: `sync-plugin-versions.test.sh PASSED`

- [ ] **Step 3: Final semantic-release dry run with version preview**

Run:
```bash
GITHUB_TOKEN=dummy npx semantic-release --dry-run --no-ci --branches main 2>&1 | grep -iE "next release|version|analyzing" | head
```
Expected: v1.1.2 이후 머지된 `feat(logger)` 커밋을 근거로 다음 버전을 `1.2.0`으로
계산하는 로그가 보인다. (토큰이 dummy라 실제 publish/push는 없음.)

- [ ] **Step 4: Final commit (if anything uncommitted)**

```bash
git status --short
# 변경 없으면 생략
```

---

## Notes for Implementer

- **첫 실제 실행 시 버전**: 현재 최신 태그 `v1.1.2`, 그 이후 `feat(logger)`(#30)가
  머지되어 있으므로 main에 이 변경이 머지되면 semantic-release가 `1.2.0`을 만든다.
- **브랜치 보호 주의**: main이 보호 브랜치이고 "require PR / no direct push"가
  켜져 있으면 semantic-release의 release 커밋 push가 거부될 수 있다. 그 경우
  `GITHUB_TOKEN` 대신 우회 권한(예: GitHub App 토큰)이 필요하다. 이번 계획은
  기본 `GITHUB_TOKEN`을 전제로 하며, 실패 시 이 노트를 참고해 토큰을 교체한다.
- **루프 방지 확인**: release 커밋 메시지의 `[skip ci]`가 release.yml 재트리거를
  막는지, 첫 실행 후 Actions 로그에서 확인한다.
