#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
project="mimir-docker-$(date +%s)-$$"
config=".local/$project"
export MIMIR_CONFIG_DIR="$config"
export LOCAL_UID="${LOCAL_UID:-$(id -u)}" LOCAL_GID="${LOCAL_GID:-$(id -g)}"
mkdir -p "$config"
log="$config/run.log"
last="$config/last-command.log"
stage=setup
steps=0
compose_ready=false
docker_cli() {
    docker "$@"
}
compose() {
    docker_cli compose --env-file "$config/.env" -p "$project" -f compose.yaml -f compose.test.yaml --profile tools "$@"
}
step() {
    stage=$1; shift
    if "$@" >"$last" 2>&1; then
        cat "$last" >>"$log"
        steps=$((steps+1)); printf 'PASS %s\n' "$stage"
    else
        code=$?; cat "$last" >>"$log"
        printf 'FAIL %s. Log local: %s\n' "$stage" "$log" >&2
        return "$code"
    fi
}
finish() {
    code=$1
    trap - EXIT INT TERM
    failed_stage=$stage
    if [ "$compose_ready" = true ]; then
        if compose --profile dev down >>"$log" 2>&1; then :; else code=1; failed_stage=stop-owned-project; fi
    fi
    passed=false; [ "$code" -ne 0 ] || passed=true
    evidence="docs/evidence/docker-$project.json"
    printf '{"project":"%s","passed":%s,"stepsPassed":%s,"lastStage":"%s","volumeRemoved":false,"runner":"POSIX sh"}\n' "$project" "$passed" "$steps" "$failed_stage" >"$evidence"
    printf 'Evidencia: %s\n' "$evidence"
    exit "$code"
}
trap 'finish $?' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
step setup docker_cli compose -p "$project" -f compose.setup.yaml run --rm setup "/workspace/$config" "$config"
compose_ready=true
step container-build compose --profile dev build api admin verifier dev-web
step clean-database compose up -d --wait db
step first-migration compose run --rm admin migrate
case "$(cat "$last")" in *001_core.sql*) ;; *) exit 1;; esac
step second-migration compose run --rm admin migrate
case "$(cat "$last")" in *'"migrationsApplied":[]'*) ;; *) exit 1;; esac
step unit-and-postgresql compose run --rm --entrypoint node admin tools/checks/tests.mjs all
step api-start compose up -d api
step http-spa-ready compose run --rm --no-deps --entrypoint node admin tools/checks/probe.mjs available
step api-environment compose exec -T api node tools/runtime/audit.mjs
step session-create-real-api compose run --rm --no-deps --entrypoint node admin tools/checks/auth-probe.mjs create
step database-stop compose stop db
step unavailable compose run --rm --no-deps --entrypoint node admin tools/checks/probe.mjs unavailable
step session-database-error-sanitized compose run --rm --no-deps --entrypoint node admin tools/checks/auth-probe.mjs outage
step database-recreate compose up -d --wait --force-recreate db
step api-recreate compose up -d --force-recreate api
step recovered compose run --rm --no-deps --entrypoint node admin tools/checks/probe.mjs available
step session-persisted-after-recreate compose run --rm --no-deps --entrypoint node admin tools/checks/auth-probe.mjs resume
step volume-preserved compose run --rm --no-deps --entrypoint node admin tools/checks/probe.mjs persisted
step vite-start compose --profile dev up -d dev-web
step vite-proxy-hmr compose run --rm --no-deps --user "$LOCAL_UID:$LOCAL_GID" -v "$root/apps/web/src:/hmr" --entrypoint node admin tools/checks/probe.mjs dev
stage=verifier-not-implemented
set +e
compose run --rm --no-deps verifier >"$last" 2>&1
code=$?
set -e
cat "$last" >>"$log"
[ "$code" -eq 2 ] || exit 1
steps=$((steps+1)); printf 'PASS %s\n' "$stage"
