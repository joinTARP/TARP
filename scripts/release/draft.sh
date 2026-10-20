#!/usr/bin/env bash
set -euo pipefail

assets_directory=${1:?请指定发布附件目录}
release_tag=${GITHUB_REF_NAME:?缺少发布 tag}
release_repo=${GITHUB_REPOSITORY:?缺少仓库名称}
release_version=${release_tag#*-v}

shopt -s nullglob
release_assets=("$assets_directory"/*)
if [[ ${#release_assets[@]} -eq 0 ]]; then
  echo "发布附件目录为空，拒绝创建草稿。" >&2
  exit 1
fi

if is_draft=$(gh release view "$release_tag" --repo "$release_repo" --json isDraft --jq '.isDraft' 2>/dev/null); then
  if [[ "$is_draft" != "true" ]]; then
    echo "版本 $release_tag 已公开发布，拒绝替换附件；请使用新版本 tag。" >&2
    exit 1
  fi
else
  release_flags=(--draft)
  if [[ "${release_version%%+*}" == *-* ]]; then
    release_flags+=(--prerelease)
  fi
  gh release create "$release_tag" --repo "$release_repo" --verify-tag \
    --title "TARP $release_tag" --generate-notes "${release_flags[@]}"
fi

gh release upload "$release_tag" "${release_assets[@]}" --repo "$release_repo" --clobber
printf 'Release 草稿：https://github.com/%s/releases/tag/%s\n' "$release_repo" "$release_tag" >> "$GITHUB_STEP_SUMMARY"
