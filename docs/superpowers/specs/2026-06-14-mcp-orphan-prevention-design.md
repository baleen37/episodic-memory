# MCP 서버 고아 프로세스 방지 설계

날짜: 2026-06-14

## 문제

`claude`(Claude Code) 세션이 정상 종료 시그널 없이 사라지면 — 크래시, `kill -9`, 터미널 강제 종료 — memmem MCP 서버가 영구 고아 프로세스로 남는다.

프로세스 구조:

```
claude → bin/memmem mcp (부모, src/cli/mcp.ts) → bun dist/mcp-server.mjs (자식, src/mcp/server.ts)
```

현재 종료 처리:

- 자식(`server.ts`): `StdioServerTransport.connect`만 호출. stdin EOF나 부모 사망을 감지하는 핸들러 없음.
- 부모(`mcp.ts`): `SIGTERM`/`SIGINT`를 자식에게 전파(line 61-62). 자식 exit 시 부모도 종료(line 63-66).

정상 종료(`/exit`, Ctrl-D → SIGINT/SIGTERM)는 처리되지만, 시그널 없는 비정상 종료는 처리되지 않아 부모·자식 둘 다 살아남는다.

2026-06-14 실측(`ps -eo pid,ppid,stat,etime`): 현재 떠 있는 MCP 쌍 6개는 전부 살아있는 `claude` 세션에 붙어 있어 정상이었다(좀비/고아 아님). 따라서 본 작업은 "지금 터지는 버그 수정"이 아니라 "비정상 종료 시 고아 방지" 견고성 개선이다.

## 핵심 메커니즘: stdin EOF

부모(claude)가 죽으면, 자식이 상속한 stdin 파이프의 쓰기 끝이 닫혀 stdin에서 EOF / `'close'` 이벤트가 발생한다. 이는 시그널 전달과 무관하게 항상 일어나므로 "클라이언트가 떠났다"는 가장 신뢰할 수 있는 신호다. MCP stdio 서버의 표준 종료 신호이기도 하다.

## 변경 1 — 자식 (`src/mcp/server.ts`)

`main()`에서 transport 연결 후 stdin 종료를 감지해 자체 종료한다.

```ts
async function main() {
  console.error('Conversation Memory MCP server running via stdio');
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // 클라이언트(부모 claude)가 stdin을 닫으면 더 받을 요청이 없으므로 종료.
  // claude 크래시/강제 종료 시 고아로 남는 것을 방지.
  process.stdin.on('close', () => process.exit(0));
}
```

`StdioServerTransport`가 stdin을 소비하므로 EOF 시 `'close'`가 발생한다. `process.exit(0)`로 즉시 종료.

## 변경 2 — 부모 (`src/cli/mcp.ts`)

`stdio: 'inherit'`라 부모도 같은 stdin을 본다. 부모도 stdin close 시 자식을 정리한다.

```ts
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
process.stdin.on('close', () => {       // 추가
  child.kill('SIGTERM');
});
```

이중 안전망: `inherit` 구조에서 부모가 stdin을 명시적으로 읽지 않아 부모 쪽 `'close'`가 발화하지 않을 수 있다. 그 경우 자식(변경 1)이 먼저 종료되고, 기존 `child.on('exit')` 핸들러(line 63-66)가 부모를 종료시킨다. 어느 한쪽 경로만 동작해도 전체가 정리된다.

## 테스트 전략

`server.ts`/`mcp.ts`는 entrypoint라 직접 단위 테스트가 까다롭다. 기존 테스트 파일(`src/mcp/server.test.ts`, `src/cli/main.test.ts`)이 있으므로 그 컨벤션을 따른다.

1. 수동/스크립트 통합 테스트: `bun dist/mcp-server.mjs`를 파이프로 띄우고 stdin을 닫아 프로세스가 스스로 종료되는지 `ps`로 확인.
2. 회귀 방지: 기존 SIGTERM/SIGINT 정상 종료 경로가 여전히 동작하는지 확인.
3. 가능하면 `process.stdin.on('close', ...)` 등록 여부를 검증하는 단위 테스트를 추가(핸들러가 걸렸는지 확인 수준).

## 범위 밖 (YAGNI)

- ppid 폴링, SIGHUP 핸들러, stale 프로세스 자동 청소 커맨드: stdin EOF 하나로 근본 해결되므로 불필요.
- `initDatabase()` 프로덕션 노출 가드(P1): 별도 작업.
- 빌드 산출물(`dist/`, `bin/`) 재빌드 및 커밋: 구현 후 별도로 처리 — marketplace 훅이 커밋된 빌드를 요구하므로 잊지 말 것.
