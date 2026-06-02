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
