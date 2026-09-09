#!/usr/bin/env bash
# Builds the control plane image and pushes it to ECR, recording the digest.
#
# Same shape as push-image.sh and for the same reason: a task definition that names a tag does
# not describe what will actually run, because a tag is a mutable pointer. Everything downstream
# references `repo@sha256:...`, and a rollback is putting an older digest back rather than hoping
# a tag moved.
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

repo=$(param "/intellidev/${env_name}/control-plane/repository-uri")
want_arch=$(param "/intellidev/${env_name}/runner/architecture")

# The service requests ARM64. An amd64 image starts and then dies with an exec-format error
# that names neither the architecture nor the image, so it is worth refusing here.
host_arch=$(docker version --format '{{.Server.Arch}}')
case "$want_arch:$host_arch" in
  ARM64:arm64|X86_64:amd64) ;;
  *) fail "environment wants $want_arch but this Docker builds $host_arch.
  Either build on a matching host, or pass --platform to cross-build (slow, emulated)." ;;
esac

sha=$(git rev-parse --short HEAD)
dirty=""
git diff --quiet HEAD -- . || dirty="-dirty"
tag="${sha}${dirty}"

printf 'push: building %s (%s) for %s\n' "$repo" "$tag" "$want_arch"
docker build -f ../docker/control-plane.Dockerfile \
  -t "${repo}:${tag}" -t "${repo}:dev" -t intellidev/control-plane:dev ../..

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

# Without the `sha256:` prefix, because the task definition composes it back on. Storing the
# whole reference would mean the stack either duplicating the prefix or stripping it, and one
# of those is always the wrong guess.
aws ssm put-parameter --overwrite \
  --name "/intellidev/${env_name}/control-plane/image-digest" \
  --type String --value "${digest#sha256:}" \
  --description 'Digest of the control plane image the service must run.' >/dev/null

printf '\npush: ok\n'
printf '  tag      %s\n' "$tag"
printf '  digest   %s\n' "$digest"
printf '  compressed %s MB in ECR\n' "$(( size / 1000000 ))"
printf '  recorded /intellidev/%s/control-plane/image-digest\n' "$env_name"
printf '\n  the service picks this up on the next `pnpm infra:deploy`\n'
