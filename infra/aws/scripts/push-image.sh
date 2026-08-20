#!/usr/bin/env bash
# Builds the golden image and pushes it to ECR, recording the digest.
#
# The digest is the whole point. A tag is a mutable pointer, so a task definition that says
# `:dev` can silently change what it runs between two dispatches of the same commit —
# which makes a failure impossible to attribute. Everything downstream references
# `repo@sha256:...`, and rollback is putting an older digest back.
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG=$(pnpm exec tsx bin/config-json.ts)
env_name=$(printf '%s' "$CONFIG" | sed -n 's/.*"env": "\([^"]*\)".*/\1/p')
region=$(printf '%s' "$CONFIG" | sed -n 's/.*"region": "\([^"]*\)".*/\1/p')

fail() { printf 'push: FAIL %s\n' "$1" >&2; exit 1; }
param() {
  aws ssm get-parameter --name "$1" --query 'Parameter.Value' --output text 2>/dev/null \
    || fail "$1 is not in SSM — deploy the registry stack first"
}

repo=$(param "/intellidev/${env_name}/runner/repository-uri")
want_arch=$(param "/intellidev/${env_name}/runner/architecture")

# The image must match the architecture run tasks will request, or the task fails at start
# with an exec-format error that looks nothing like an architecture mismatch.
host_arch=$(docker version --format '{{.Server.Arch}}')
case "$want_arch:$host_arch" in
  ARM64:arm64|X86_64:amd64) ;;
  *) fail "environment wants $want_arch but this Docker builds $host_arch.
  Either build on a matching host, or pass --platform to cross-build (slow, emulated)." ;;
esac

# Tag by commit so a pushed image is traceable to a tree, plus a moving `dev` tag for
# humans reading the console. Neither is ever referenced by a task definition.
sha=$(git rev-parse --short HEAD)
dirty=""
git diff --quiet HEAD -- . || dirty="-dirty"
tag="${sha}${dirty}"

printf 'push: building %s (%s) for %s\n' "$repo" "$tag" "$want_arch"
# Also tagged `intellidev/runner:dev`, which is what INTELLIDEV_IMAGE defaults to locally.
# Without it the local Docker path keeps running whatever was built by hand last, so
# "the local loop still works" would be testing different code than Fargate runs — and the
# whole point of keeping DockerRunner is reproducing a Fargate failure locally.
docker build -f ../docker/Dockerfile \
  -t "${repo}:${tag}" -t "${repo}:dev" -t intellidev/runner:dev ../..

aws ecr get-login-password --region "$region" \
  | docker login --username AWS --password-stdin "${repo%%/*}" >/dev/null \
  || fail 'ecr login failed'

start=$(date +%s)
docker push --quiet "${repo}:${tag}" >/dev/null
docker push --quiet "${repo}:dev" >/dev/null
printf 'push: uploaded in %ss\n' "$(( $(date +%s) - start ))"

digest=$(aws ecr describe-images \
  --repository-name "${repo##*/}" --image-ids "imageTag=${tag}" \
  --query 'imageDetails[0].imageDigest' --output text)
size=$(aws ecr describe-images \
  --repository-name "${repo##*/}" --image-ids "imageTag=${tag}" \
  --query 'imageDetails[0].imageSizeInBytes' --output text)
[ "$digest" != "None" ] || fail 'pushed, but ECR reports no digest'

# Recorded in SSM rather than in CDK: CDK cannot know a digest at synth time, and a
# parameter it owned would be reset to a stale value on the next deploy.
aws ssm put-parameter --overwrite \
  --name "/intellidev/${env_name}/runner/image-digest" \
  --type String --value "$digest" \
  --description 'Digest of the golden image run tasks must use.' >/dev/null

printf '\npush: ok\n'
printf '  tag      %s\n' "$tag"
printf '  digest   %s\n' "$digest"
printf '  compressed %s MB in ECR\n' "$(( size / 1000000 ))"
printf '  recorded /intellidev/%s/runner/image-digest\n' "$env_name"
