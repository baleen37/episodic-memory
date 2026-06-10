#!/usr/bin/env bash
set -euo pipefail

# 릴리스 성공 후 baleen-marketplace로 update_versions 이벤트를 디스패치한다.
# semantic-release의 success 단계(@semantic-release/exec successCmd)에서 호출된다.
#
# GITHUB_TOKEN으로 만든 Release는 GitHub 정책상 다른 워크플로우(release: published)를
# 트리거하지 못하므로, 마켓플레이스 전파를 워크플로우 이벤트 대신 여기서 직접 보낸다.
#
# 필요 환경변수:
#   MARKETPLACE_DISPATCH_TOKEN : baleen-marketplace로 dispatch할 권한이 있는 토큰
#   RELEASE_VERSION            : 디스패치에 실어 보낼 버전 (예: 1.2.0)
# 선택 환경변수:
#   MARKETPLACE_REPOSITORY     : 대상 repo (기본 baleen37/baleen-marketplace)
#   PLUGIN_NAME                : 플러그인 이름 (기본 memmem)

token="${MARKETPLACE_DISPATCH_TOKEN:?MARKETPLACE_DISPATCH_TOKEN is required}"
version="${RELEASE_VERSION:?RELEASE_VERSION is required}"
repository="${MARKETPLACE_REPOSITORY:-baleen37/baleen-marketplace}"
plugin="${PLUGIN_NAME:-memmem}"

payload="$(jq -n \
  --arg event_type "update_versions" \
  --arg plugin "$plugin" \
  --arg version "$version" \
  '{event_type: $event_type, client_payload: {plugin: $plugin, version: $version}}')"

curl -sSf -X POST \
  --retry 3 --retry-connrefused --max-time 30 \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer ${token}" \
  "https://api.github.com/repos/${repository}/dispatches" \
  -d "$payload"
