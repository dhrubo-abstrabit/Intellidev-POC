#!/usr/bin/env bash
# Tears down the environment, including the parameters CDK does not own.
#
# `cdk destroy` cannot clean up the image digest, because `push-image.sh` writes it — CDK
# cannot know a digest at synth time, so the parameter is deliberately unmanaged. Without
# this step a destroyed environment leaves a pointer to an image that no longer exists,
# which is worse than leaving nothing: the next deploy's verify would pass on a stale
# digest and fail at RunTask.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG=$(pnpm exec tsx bin/config-json.ts)
env_name=$(printf '%s' "$CONFIG" | sed -n 's/.*"env": "\([^"]*\)".*/\1/p')

pnpm exec cdk destroy --all --force

# Anything still under the prefix after cdk destroy is by definition unmanaged.
orphans=$(aws ssm get-parameters-by-path --path "/intellidev/${env_name}" --recursive \
  --query 'Parameters[].Name' --output text)
if [ -n "$orphans" ]; then
  # shellcheck disable=SC2086
  aws ssm delete-parameters --names $orphans >/dev/null
  printf 'destroy: removed unmanaged parameters:\n'
  printf '  %s\n' $orphans
fi

printf 'destroy: %s is gone\n' "$env_name"
