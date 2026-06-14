# initDatabase() 프로덕션 wipe 가드 설계

날짜: 2026-06-14

## 문제

`src/core/db.ts`의 `createDatabase(wipe=true)`는 실제 파일 DB와 `-wal`/`-shm` 파일을 `fs.unlinkSync`로 삭제한다(line 106-113). `initDatabase()`는 `createDatabase(true)`의 공개 래퍼로 테스트 전용이지만 모듈에서 export되어 누구나 호출할 수 있다. 프로덕션 코드에 실수로 `initDatabase()`가 한 줄 들어가면 전체 메모리 DB(`~/.config/memmem/conversation-index/conversations.db`)가 소실된다. 현재 이를 막는 코드 레벨 가드가 없다(프로젝트 메모리 `initdatabase-wipes-real-db.md`에 기록된 함정).

## 결정

프로덕션 환경(테스트 아님)에서 wipe를 시도하면 `Error`를 throw해 unlink 전에 즉시 중단한다. 데이터 손실을 조용히 허용하지 않고, 실수 호출을 조기에 크게 터뜨려 호출처를 고치게 한다.

## 가드 위치 및 조건

`createDatabase`의 wipe 블록 진입 직전에 가드를 둔다. wipe라는 위험한 동작에 직결되므로 가장 정밀하다.

가드 발화 조건:
- `wipe === true` (위험 경로일 때만 — `openDatabase`는 영향 없음)
- 그리고 테스트 환경이 아님

테스트 환경 판정은 기존 `db.ts:10-11`에서 이미 쓰는 동일 조합을 재사용한다: `import.meta.test`(`bun test`가 설정) 또는 `process.env.NODE_ENV === 'test'`.

`dbPath === ':memory:'`는 이미 wipe 블록 자체를 건너뛰므로(line 106 조건) in-memory 테스트는 가드와 무관하게 영향 없다. 파일 경로로 wipe하는 테스트(`TEST_DB_PATH=/tmp/...`)도 있을 수 있으므로 `:memory:` 여부가 아니라 테스트 환경 플래그로 판정해야 한다.

## 테스트 가능성: 조건 함수 추출

`bun test` 안에서는 `import.meta.test`가 항상 true라 "프로덕션에서 throw" 경로를 직접 탈 수 없다. 가드 발화를 깔끔히 단위 테스트하기 위해 조건을 작은 순수 함수로 추출한다.

```ts
// db.ts
export function isWipeAllowed(isTestEnv: boolean, nodeEnv: string | undefined): boolean {
  return isTestEnv || nodeEnv === 'test';
}
```

`createDatabase`는 이 함수를 호출해 판정한다:

```ts
if (wipe && dbPath !== ':memory:') {
  if (!isWipeAllowed(isTestEnvironment, process.env.NODE_ENV)) {
    throw new Error(
      'initDatabase() wipes the database and is for tests only. Use openDatabase() in production.'
    );
  }
  for (const suffix of ['', '-wal', '-shm']) {
    const filePath = `${dbPath}${suffix}`;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}
```

순수 함수 `isWipeAllowed`는 인자만 받으므로 양쪽 분기를 모두 단위 테스트할 수 있다.

## 테스트 전략

1. **가드 조건 단위 테스트** (`db.test.ts`에 추가): `isWipeAllowed(true, undefined) === true`, `isWipeAllowed(false, 'test') === true`, `isWipeAllowed(false, 'production') === false`, `isWipeAllowed(false, undefined) === false`.
2. **회귀**: 기존 `db.test.ts`의 `initDatabase()` 사용 테스트가 모두 통과해야 한다. 이들은 `:memory:` 또는 test env에서 돌므로 가드를 정상 통과한다.

## 범위 밖 (YAGNI)

- `initDatabase`를 별도 테스트 헬퍼 모듈로 분리: 변경 범위가 크고 여러 import 수정이 필요해 불필요. 인라인 가드로 충분.
- 마이그레이션 전략 보강, supersede 추적(P2/P3): 별도 작업.
- 빌드 산출물(`dist/`, `bin/`) 재빌드/커밋: db.ts는 CLI/MCP 번들 양쪽에 포함되므로 구현 후 재빌드하고 변경된 번들을 커밋한다([[marketplace-needs-committed-build]] 제약).
