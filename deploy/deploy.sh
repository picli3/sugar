#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
export PATH=/usr/sbin:/usr/bin:/sbin:/bin
[[ "$EUID" -eq 0 ]] || { echo 'Deployment requires the restricted root runner.' >&2; exit 2; }
[[ "$#" -eq 1 && "$1" =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected one full commit SHA' >&2; exit 2; }
cd /srv/sugar
sha=${1:-}
# Validate the checker and its parent directories before running it as root.
for protected in /srv /srv/sugar /srv/sugar/security /srv/sugar/security/check-files.py; do
  [[ -e "$protected" && ! -L "$protected" ]] || { echo 'Unsafe deployment permissions.' >&2; exit 2; }
  if [[ "$protected" == *.py ]]; then [[ -f "$protected" ]] || exit 2; else [[ -d "$protected" ]] || exit 2; fi
  owner=$(stat -c %u "$protected" 2>/dev/null) || exit 2
  mode=$(stat -c %a "$protected" 2>/dev/null) || exit 2
  [[ "$owner" -eq 0 ]] && (( (8#$mode & 0022) == 0 )) || { echo 'Unsafe deployment permissions.' >&2; exit 2; }
done
python3 /srv/sugar/security/check-files.py --root /srv/sugar --owner-uid 0
exec 9>>/srv/sugar/.deploy.lock
flock -w 600 9
IFS= read -r -n 4097 registry_token
[[ -n "$registry_token" && ${#registry_token} -le 4096 ]] || exit 2
IFS= read -r -n 4097 release_manifest
[[ ${#release_manifest} -le 4096 ]] || exit 2
# Only a compact, commit-bound descriptor is accepted, never shell assignments.
if ! identities=$(python3 -I -c '
import json, re, sys
try:
    data = json.load(sys.stdin)
    if set(data) != {"version", "commit", "images"} or data["version"] != 2 or data["commit"] != sys.argv[1]:
        raise ValueError()
    if set(data["images"]) != {"api-image", "web-image", "database-image"}:
        raise ValueError()
    ids = [data["images"][name + "-image"]["id"] for name in ("api", "web", "database")]
    if not all(isinstance(value, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value) for value in ids):
        raise ValueError()
    print(" ".join(ids))
except (ValueError, KeyError, TypeError):
    sys.exit(2)
' "$sha" <<< "$release_manifest"); then
  echo 'Invalid release image descriptor.' >&2
  exit 2
fi
read -r expected_api expected_web expected_database <<< "$identities"
unset release_manifest identities
registry_config=$(mktemp -d)
release_file=''
trap 'rm -rf "$registry_config"; if [[ -n "$release_file" ]]; then rm -f "$release_file"; fi' EXIT
export DOCKER_CONFIG="$registry_config"
printf '%s' "$registry_token" | docker login ghcr.io -u picli3 --password-stdin >/dev/null
unset registry_token
previous=''
if [[ -f release.env ]]; then previous=$(sed -n 's/^IMAGE_TAG=//p' release.env); fi
previous_access=''
if [[ -f release.env ]]; then previous_access=$(sed -n 's/^DATABASE_ACCESS=//p' release.env); fi
if [[ -f release.env ]] && { [[ ! "$previous" =~ ^[a-f0-9]{40}$ ]] || [[ -n "$previous_access" && "$previous_access" != runtime-v1 ]]; }; then
  echo 'Invalid previous release state.' >&2
  exit 2
fi
rollback_file=/srv/sugar/legacy-rollback.yaml
if [[ "$previous" =~ ^[a-f0-9]{40}$ && "$previous_access" != runtime-v1 ]]; then
  [[ -f "$rollback_file" && ! -L "$rollback_file" ]] || exit 2
  [[ "$(stat -c %u "$rollback_file")" -eq 0 ]] || exit 2
  rollback_mode=$(stat -c %a "$rollback_file")
  (( (8#$rollback_mode & 0022) == 0 )) || exit 2
fi
export IMAGE_TAG="$sha"
compose() { docker compose --env-file .env -f compose.yaml "$@"; }
compose config --quiet
# Capture the actual local DB identity, including releases without a DB artifact.
# Never guess an earlier image from the new release SHA or a mutable vendor tag.
capture_image() {
  local container image
  container=$(compose ps -a -q "$1") || return 2
  if [[ -n "$container" ]]; then
    image=$(docker inspect --format '{{.Image}}' "$container") || return 2
    [[ "$image" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid previous image identity.' >&2; return 2; }
    docker image inspect "$image" >/dev/null || return 2
    printf '%s' "$image"
  elif [[ "$previous" =~ ^[a-f0-9]{40}$ ]]; then
    echo 'Previous container unavailable; review recovery before upgrading.' >&2
    return 2
  fi
}
previous_database=$(capture_image db)
previous_api=$(capture_image api)
previous_web=$(capture_image web)
export API_IMAGE="ghcr.io/picli3/sugar-api:$sha"
export WEB_IMAGE="ghcr.io/picli3/sugar-web:$sha"
export DATABASE_IMAGE="ghcr.io/picli3/sugar-database:$sha"
compose pull api web db
verify_image() {
  local repository ref local_id digest config
  repository="ghcr.io/picli3/sugar-$1"
  ref="$repository:$sha"
  local_id=$(docker image inspect --format '{{.Id}}' "$ref") || return 2
  [[ "$local_id" =~ ^sha256:[a-f0-9]{64}$ ]] || return 2
  config="$local_id"
  if [[ "$local_id" != "$2" ]]; then
    # The containerd store (Docker 29) exposes a manifest digest as local Id.
    # Bind the pulled local image to its immutable registry digest, then compare
    # its configuration digest with the scanned legacy-store image identity.
    digest=$(docker image inspect --format '{{json .RepoDigests}}' "$ref" | python3 -I -c '
import json,re,sys
try:
    matches = {value for value in json.load(sys.stdin) if re.fullmatch(re.escape(sys.argv[1]) + r"@sha256:[a-f0-9]{64}", value)}
    if len(matches) != 1: raise ValueError()
    print(matches.pop())
except (ValueError, TypeError): sys.exit(2)
' "$repository") || return 2
    config=$(docker manifest inspect "$digest" | python3 -I -c '
import json,re,sys
try:
    data = json.load(sys.stdin)
    value = data["config"]["digest"]
    if data.get("schemaVersion") != 2 or not re.fullmatch(r"sha256:[a-f0-9]{64}", value): raise ValueError()
    print(value)
except (ValueError, KeyError, TypeError): sys.exit(2)
') || return 2
  fi
  [[ "$config" == "$2" ]] || { echo 'Pulled image differs from the scanned release.' >&2; return 2; }
  printf '%s' "$local_id"
}
verified_api=$(verify_image api "$expected_api")
verified_web=$(verify_image web "$expected_web")
verified_database=$(verify_image database "$expected_database")
# Start migration and all services by identity, not mutable registry tags.
export API_IMAGE="$verified_api"
export WEB_IMAGE="$verified_web"
export DATABASE_IMAGE="$verified_database"
mkdir -p backups
if compose ps --status running --services | grep -qx db; then
  compose exec -T db pg_dump -U designer -d hardware_designer -Fc > "backups/$(date -u +%Y%m%dT%H%M%SZ)-before-${sha:0:12}.dump"
fi
record_release() {
  release_file=$(mktemp /srv/sugar/.release.XXXXXX) || return 1
  printf 'IMAGE_TAG=%s\nDATABASE_ACCESS=runtime-v1\nDATABASE_IMAGE=%s\nAPI_IMAGE=%s\nWEB_IMAGE=%s\nAPI_CONFIG=%s\nWEB_CONFIG=%s\nDATABASE_CONFIG=%s\n' "$sha" "$verified_database" "$verified_api" "$verified_web" "$expected_api" "$expected_web" "$expected_database" > "$release_file" || return 1
  mv -f "$release_file" release.env
}
if ! compose stop -t 30 api || ! compose up -d --wait --wait-timeout 180 db || ! compose --profile maintenance run --rm --no-deps migrate || ! compose up -d --wait --wait-timeout 180 || ! curl --fail --silent --retry 6 --retry-delay 2 http://127.0.0.1:18088/api/ready || ! record_release; then
  if [[ -n "$previous_database" ]]; then export DATABASE_IMAGE="$previous_database"; fi
  if [[ -n "$previous_api" ]]; then export API_IMAGE="$previous_api"; fi
  if [[ -n "$previous_web" ]]; then export WEB_IMAGE="$previous_web"; fi
  if [[ "$previous" =~ ^[a-f0-9]{40}$ ]]; then
    export IMAGE_TAG="$previous"
    if [[ "$previous_access" == runtime-v1 ]]; then
      compose up -d --wait --wait-timeout 180
    else
      # The trusted override restores legacy credentials only for the prior image.
      docker compose --env-file .env -f compose.yaml -f "$rollback_file" up -d --wait --wait-timeout 180
    fi
    echo "Restored previous application and DB images: $previous" >&2
  elif [[ -n "$previous_database" ]]; then
    compose up -d --wait --wait-timeout 180 db
  fi
  echo 'Deployment failed. Existing backups retained; no automatic database restore.' >&2
  exit 1
fi
printf '\nDeployed %s\n' "$sha"
