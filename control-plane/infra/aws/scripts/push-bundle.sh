#!/usr/bin/env bash
# Publishes a project bundle to S3, content-addressed by digest.
#
# The bundle is prompts, skills and context — everything a run reads that is not the repo
# itself. It used to be a read-only bind mount, which Fargate cannot do; now it is an
# immutable object and the spec pins its digest.
#
# Content-addressed on purpose: the key *is* the digest, so publishing identical content
# twice is a no-op and a run in flight can never have its bundle change underneath it.
# Rolling back is pointing the recorded digest at an earlier object.
set -euo pipefail
cd "$(dirname "$0")/.."

project="local"
source_dir="../../examples/bundle"
while [ $# -gt 0 ]; do
  case "$1" in
    --project) project="$2"; shift 2 ;;
    --dir) source_dir="$2"; shift 2 ;;
    *) printf 'usage: push-bundle.sh [--project <id>] [--dir <path>]\n' >&2; exit 2 ;;
  esac
done

CONFIG=$(pnpm exec tsx bin/config-json.ts)
env_name=$(printf '%s' "$CONFIG" | sed -n 's/.*"env": "\([^"]*\)".*/\1/p')

fail() { printf 'bundle: FAIL %s\n' "$1" >&2; exit 1; }

bucket=$(aws ssm get-parameter --name "/intellidev/${env_name}/artifacts/bucket" \
  --query 'Parameter.Value' --output text 2>/dev/null) \
  || fail 'artifacts/bucket is not in SSM — deploy the artifacts stack first'

[ -d "$source_dir/prompts" ] || fail "$source_dir has no prompts/ directory"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archive="$work/bundle.tar.gz"

# Reproducible, and it has to be earned rather than assumed: tar records each file's mtime
# and gzip stamps its own header, so the naive `tar -czf` gives a different digest every
# time even when nothing changed. Since the key *is* the digest, that would mean a new S3
# object per push and a churning recorded reference for identical content.
#
# Three things make it deterministic: a staging copy with every mtime pinned, an explicitly
# sorted member list (directory order is filesystem-dependent), and `gzip -n` to drop the
# timestamp from the gzip header. Owner ids are zeroed because they are the publishing
# machine's, not anything the bundle should carry.
stage="$work/stage"
mkdir -p "$stage"
tar -cf - -C "$source_dir" . | tar -xf - -C "$stage"
find "$stage" -exec touch -t 197001010000 {} +
(cd "$stage" && find . -type f | LC_ALL=C sort > "$work/members")
COPYFILE_DISABLE=1 tar -cf - --uid 0 --gid 0 --numeric-owner \
  -C "$stage" -T "$work/members" | gzip -n > "$archive"

digest="sha256:$(shasum -a 256 "$archive" | cut -d' ' -f1)"
key="bundles/${project}/${digest#sha256:}.tar.gz"
bytes=$(wc -c < "$archive" | tr -d ' ')

printf 'bundle: %s (%s bytes) → s3://%s/%s\n' "$project" "$bytes" "$bucket" "$key"
aws s3api put-object --bucket "$bucket" --key "$key" --body "$archive" \
  --server-side-encryption AES256 \
  --content-type application/gzip >/dev/null

# Verify the round trip rather than trusting the upload. A truncated PUT that returned 200
# would otherwise only surface as a digest mismatch inside a run, minutes later.
check=$(mktemp)
aws s3api get-object --bucket "$bucket" --key "$key" "$check" >/dev/null
got="sha256:$(shasum -a 256 "$check" | cut -d' ' -f1)"
rm -f "$check"
[ "$got" = "$digest" ] || fail "uploaded object hashes to $got, expected $digest"

# Recorded per project, which is what stops two projects sharing one bundle.
aws ssm put-parameter --overwrite --name "/intellidev/${env_name}/bundle/${project}/key" \
  --type String --value "$key" >/dev/null
aws ssm put-parameter --overwrite --name "/intellidev/${env_name}/bundle/${project}/digest" \
  --type String --value "$digest" >/dev/null

printf '\nbundle: ok\n'
printf '  project  %s\n' "$project"
printf '  digest   %s\n' "$digest"
printf '  verified round trip from S3\n'
printf '  recorded /intellidev/%s/bundle/%s/{key,digest}\n' "$env_name" "$project"
