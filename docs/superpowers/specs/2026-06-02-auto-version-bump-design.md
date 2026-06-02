# Auto Version Bump on Main Merge — Design

Date: 2026-06-02

## Problem

main에 PR이 머지되어도 버전이 자동으로 올라가지 않는다. 커밋은 Conventional
Commits 형식(`feat:`, `fix:`, `chore:` 등)으로 작성되어 있고, `on-release.yml`은
GitHub Release가 published 되면 외부 baleen-marketplace로 `update_versions`
이벤트를 보내는 **마켓플레이스 디스패치** 역할을 이미 한다. 그러나
"버전 계산 → 태그 → Release 발행"이라는 **릴리스 발행** 시작점이 없어서, 예를
들어 `v1.1.2` 이후 `feat(logger)`(#30)가 머지됐는데도 버전은 `1.1.2`에 머물러
있다.

## 용어

세 워크플로우의 역할을 다음 이름으로 구분한다.

- **릴리스 발행** (`release.yml`, 신규): 버전 계산 → 메타데이터 갱신 → git
  태그 → GitHub Release published.
- **마켓플레이스 디스패치** (`on-release.yml`, 기존): Release published를 받아
  외부 `baleen37/baleen-marketplace` repo로 `update_versions` repository_dispatch를
  전송한다. **여기서 memmem 쪽 체인은 끝난다** — dispatch를 받은 마켓플레이스
  repo가 자체적으로 버전 동기화를 처리하며, memmem repo로 되돌아오는 호출은 없다.
- **메타데이터 정렬** (`update-versions.yml`, 기존): memmem repo로 직접 들어오는
  `repository_dispatch: update_versions` 또는 수동 `workflow_dispatch`를 받아
  plugin.json ×2와 marketplace.json을 package.json 버전에 맞춰 정렬하는 **독립
  진입점**이다. 마켓플레이스 디스패치 체인의 일부가 아니며, 그동안 사실상
  매시간 cron으로만 실행돼 왔다.

## Goal

main 머지 시 **릴리스 발행**이 자동으로:
1. Conventional Commits 기반 다음 버전 계산
2. 버전 메타데이터 파일 4개 갱신
3. git 태그 + GitHub Release published

이후는 기존 **마켓플레이스 디스패치**(`on-release.yml`)가 Release를 받아 외부
`baleen37/baleen-marketplace` repo로 `update_versions`를 보내고 거기서 끝난다.
이 디스패치 체인은 변경 없이 유지된다.

## 비범위 (Out of Scope)

- npm publish는 하지 않는다. 현재 배포 경로는 GitHub Release → 마켓플레이스이며
  npm 레지스트리 배포 흔적이 없다. `@semantic-release/npm`은 `npmPublish: false`로
  package.json 버전만 갱신하는 용도로만 쓴다.

## 동작 흐름

```
PR을 main에 머지 (커밋: feat/fix/...)
  └─> release.yml 트리거 (push: main)
        └─> semantic-release 실행
              1. Conventional Commits 분석 → 다음 버전 계산
                 (fix→patch, feat→minor, BREAKING CHANGE→major)
              2. package.json + .claude-plugin/plugin.json
                 + .codex-plugin/plugin.json + .claude-plugin/marketplace.json 갱신
              3. 변경 커밋(chore(release): ... [skip ci]) + 태그(vX.Y.Z) 푸시
              4. GitHub Release published (자동 생성 체인지로그 포함)
                    └─> 기존 on-release.yml 트리거
                          └─> baleen37/baleen-marketplace로 dispatch → [거기서 끝]
```

## 구성 요소

### 1. `release.config.cjs`

semantic-release 설정. 플러그인 체인:

- `@semantic-release/commit-analyzer` — 커밋 분석, 버전 결정
- `@semantic-release/release-notes-generator` — 릴리스 노트 생성
- `@semantic-release/npm` (`npmPublish: false`) — package.json 버전만 갱신
- `@semantic-release/git` — 4개 파일을 버전 갱신 후 함께 커밋,
  메시지에 `[skip ci]` 포함
- `@semantic-release/github` — 태그 + GitHub Release published

`@semantic-release/git`의 `assets`:
- `package.json`
- `.claude-plugin/plugin.json`
- `.codex-plugin/plugin.json`
- `.claude-plugin/marketplace.json`

단, `@semantic-release/npm`은 package.json만 갱신하므로, plugin.json ×2와
marketplace.json은 별도로 버전을 써줘야 한다. → `@semantic-release/exec`로
`prepare` 단계에서 jq 갱신을 수행하거나, 갱신 스크립트를 호출한다.
(기존 `update-versions.yml`의 jq 로직을 스크립트로 추출해 재사용한다.)

### 2. `.github/workflows/release.yml` (신규)

- 트리거: `push: branches: [main]`
- 환경: Node (semantic-release는 Node 도구) — `actions/setup-node`
  + jq(우분투 기본 제공)
- `npx semantic-release` 실행
- 권한: `contents: write`, `issues: write`, `pull-requests: write`
- 인증: `GITHUB_TOKEN`

### 3. 버전 갱신 스크립트 (재사용)

기존 `update-versions.yml`의 "Align standalone plugin metadata" 단계의 jq
로직을 `scripts/sync-plugin-versions.sh` 같은 스크립트로 추출한다. semantic-release의
`prepare` 단계(`@semantic-release/exec`)에서 호출하여 plugin.json ×2와
marketplace.json을 package.json 버전에 맞춘다.

## 기존 워크플로우와의 관계

- **`on-release.yml`** (마켓플레이스 디스패치): 변경 없음. Release published를
  받아 `baleen37/baleen-marketplace`로 dispatch. ✅
- **`update-versions.yml`** (메타데이터 정렬): `schedule: cron` 트리거만 제거한다.
  이제 semantic-release가 릴리스 시 한 커밋에서 4개 파일을 모두 갱신하므로 매시간
  cron 정렬은 역할이 겹쳐 불필요하다. `workflow_dispatch`(수동)와
  `repository_dispatch: update_versions`(독립 진입점)는 유지하고, 파일 내
  align/verify/commit 로직도 그대로 둔다.

  주의: 이 워크플로우는 마켓플레이스 디스패치 체인의 일부가 **아니다** — 별개의
  독립 진입점이며, 그동안 사실상 cron으로만 실행돼 왔다. cron을 빼면 자동 실행은
  사라지고 수동/외부 dispatch로만 남는다. semantic-release가 정렬을 대신하므로
  의도된 결과지만, 이 워크플로우가 거의 휴면 상태가 된다는 점을 인지한다. (완전
  삭제는 외부에서 이 repo로 직접 dispatch할 가능성을 닫으므로 이번 범위에서 제외.)

## 리스크 / 트레이드오프

1. **무한 루프 방지**: semantic-release의 release 커밋이 다시 `push: main`을
   트리거하면 워크플로우가 한 번 더 (빈) 실행된다. 커밋 메시지에 `[skip ci]`를
   넣어 막는다. 커밋 타입은 `chore`이므로 새 릴리스 자체는 유발하지 않는다.
2. **push 권한**: main이 보호 브랜치라면 `GITHUB_TOKEN`이 직접 push 가능해야
   한다. 브랜치 보호 규칙을 확인한다. 불가하면 PAT 또는 GitHub App 토큰 필요.
3. **버전/태그 정합성**: package.json=`1.1.2`, 최신 태그=`v1.1.2`로 일치.
   semantic-release는 태그 기준으로 계산하므로 첫 실행 시 `v1.1.2` 이후 머지된
   `feat`를 보고 `1.2.0`을 만든다. ✅ 정상.

## 검증 기준

- [ ] `release.yml`이 main push에서 트리거된다.
- [ ] semantic-release가 v1.1.2 이후 feat 커밋을 보고 1.2.0을 계산한다.
- [ ] 4개 메타데이터 파일이 모두 새 버전으로 갱신된다.
- [ ] 태그 vX.Y.Z와 GitHub Release가 생성된다.
- [ ] release 커밋이 `[skip ci]`로 워크플로우 재트리거 시 새 릴리스를 만들지 않는다.
- [ ] on-release.yml이 새 Release에서 트리거된다.
- [ ] update-versions.yml에서 `schedule: cron`이 제거되고 workflow_dispatch /
      repository_dispatch는 유지된다.
