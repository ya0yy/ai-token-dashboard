#!/usr/bin/env bash
# 复制到项目部署目录的 deploy.sh；只需调整本区配置即可适配其他 Compose 项目。
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# 项目配置必须由服务器管理员维护，禁止从 SSH 输入读取命令、仓库或服务名。
readonly PROJECT_NAME='ai-token-dashboard'
readonly DEPLOY_DIR='/data/app/ai-token-dashboard'
readonly IMAGE_REPOSITORY='ghcr.io/ya0yy/ai-token-dashboard'
readonly IMAGE_ENV_VAR='AI_TOKEN_DASHBOARD_IMAGE'
readonly APP_SERVICE='ai-token-dashboard'
readonly COMPOSE_PROFILE=''
readonly MIGRATION_SERVICE=''
readonly -a DEPENDENCY_SERVICES=()
readonly -a REQUIRED_PATHS=('data')
readonly PULL_TIMEOUT=300
readonly MIGRATION_TIMEOUT=120
readonly HEALTH_TIMEOUT=90

# 以下为通用部署逻辑；新增项目只修改上方配置。
trap 'status=$?; printf "错误：部署失败，项目：%s，脚本行号：%s，退出码：%s。请检查上方错误及服务器容器状态。\n" "$PROJECT_NAME" "$LINENO" "$status" >&2; exit "$status"' ERR

if [[ $# -ne 0 || -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  echo '错误：此密钥仅允许固定部署入口，不接受远程命令或脚本参数。' >&2
  exit 1
fi

image=''
requested_dir=''
revision=''
if ! IFS= read -r -t 10 -n 1024 image || ! IFS= read -r -t 10 -n 512 requested_dir || ! IFS= read -r -t 10 -n 128 revision; then
  echo '错误：部署请求不完整或读取超时，需要镜像摘要、部署目录和提交号。' >&2
  exit 1
fi
digest=${image##*@}
if [[ "$image" != "$IMAGE_REPOSITORY@$digest" || ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  printf '错误：镜像不属于允许的仓库或缺少有效摘要，允许仓库：%s\n' "$IMAGE_REPOSITORY" >&2
  exit 1
fi
if [[ "$requested_dir" != "$DEPLOY_DIR" || ! "$revision" =~ ^[a-f0-9]{40}$ ]]; then
  echo '错误：部署目录或提交号不合法，请核对 Environment 和工作流。' >&2
  exit 1
fi

# 锁覆盖检查、迁移、启动和配置落盘，避免手动调用与流水线互相覆盖。
exec 9>"/run/lock/${PROJECT_NAME}-deploy.lock"
if ! timeout --kill-after=5s 35s flock -w 30 9; then
  printf '错误：另一个部署仍在执行，项目：%s。请检查正在运行的 Actions 后重试。\n' "$PROJECT_NAME" >&2
  exit 1
fi
# 迁移容器由 Docker daemon 执行，CLI 超时不能替代清理；锁保持到清理结束。
migration_container="${PROJECT_NAME}-deploy-migrate"
migration_active=false
cleanup_migration() {
  local status=$? owner=''
  trap - EXIT HUP INT TERM
  if [[ "$migration_active" == true ]]; then
    owner=$(timeout --kill-after=2s 5s docker inspect --format '{{ index .Config.Labels "io.ya0yy.deploy.project" }}' "$migration_container" 2>/dev/null) || true
    if [[ "$owner" == "$PROJECT_NAME" ]]; then
      if ! timeout --kill-after=2s 5s docker rm -f "$migration_container" > /dev/null 2>&1; then
        printf '错误：迁移容器清理失败，容器：%s。下次部署会拒绝继续，请在服务器检查。\n' "$migration_container" >&2
        status=1
      fi
    fi
  fi
  exit "$status"
}
trap cleanup_migration EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$DEPLOY_DIR"
for required in docker-compose.yml .env "${REQUIRED_PATHS[@]}"; do
  if [[ ! -e "$required" ]]; then
    printf '错误：部署目录缺少必要文件，项目：%s，路径：%s\n' "$PROJECT_NAME" "$required" >&2
    exit 1
  fi
done

# 只覆盖受信的镜像变量；Compose 从服务器现有 .env 读取应用秘密。
printf -v "$IMAGE_ENV_VAR" '%s' "$image"
export "${IMAGE_ENV_VAR?}"
compose=(docker compose --env-file .env)
if [[ -n "$COMPOSE_PROFILE" ]]; then compose+=(--profile "$COMPOSE_PROFILE"); fi
timeout --kill-after=5s 30s "${compose[@]}" config --quiet
printf '开始拉取镜像，项目：%s，镜像：%s，提交：%s\n' "$PROJECT_NAME" "$image" "$revision"
timeout --kill-after=10s "${PULL_TIMEOUT}s" "${compose[@]}" pull "$APP_SERVICE"

# 必须先核对镜像提交，再执行迁移，避免错误构建触碰生产数据库。
image_revision=$(timeout --kill-after=5s 15s docker image inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$image")
if [[ "$image_revision" != "$revision" ]]; then
  printf '错误：镜像提交不符，预期提交：%s，实际提交：%s。停止迁移和更新。\n' "$revision" "$image_revision" >&2
  exit 1
fi
if (( ${#DEPENDENCY_SERVICES[@]} > 0 )); then
  printf '检查依赖服务，项目：%s，服务：%s\n' "$PROJECT_NAME" "${DEPENDENCY_SERVICES[*]}"
  # 已有 Redis 等依赖不重建，避免丢失临时数据；仅启动缺失或停止的服务。
  timeout --kill-after=10s 180s "${compose[@]}" up -d --no-deps --no-build --no-recreate \
    --pull missing --wait --wait-timeout "$HEALTH_TIMEOUT" "${DEPENDENCY_SERVICES[@]}"
fi
if [[ -n "$MIGRATION_SERVICE" ]]; then
  printf '开始执行数据库迁移，项目：%s，服务：%s\n' "$PROJECT_NAME" "$MIGRATION_SERVICE"
  if timeout --kill-after=5s 15s docker inspect "$migration_container" > /dev/null 2>&1; then
    printf '错误：存在遗留迁移容器，容器：%s。请在服务器确认迁移状态并清理后再部署。\n' "$migration_container" >&2
    exit 1
  fi
  migration_active=true
  timeout --kill-after=10s "${MIGRATION_TIMEOUT}s" "${compose[@]}" run --rm --no-deps --pull never \
    --name "$migration_container" --label "io.ya0yy.deploy.project=$PROJECT_NAME" "$MIGRATION_SERVICE"
  migration_active=false
fi

printf '开始更新应用并等待健康检查，项目：%s，服务：%s\n' "$PROJECT_NAME" "$APP_SERVICE"
timeout --kill-after=10s 180s "${compose[@]}" up -d --no-deps --no-build --pull never \
  --wait --wait-timeout "$HEALTH_TIMEOUT" "$APP_SERVICE"
container=$(timeout --kill-after=5s 15s "${compose[@]}" ps -q "$APP_SERVICE")
if [[ -z "$container" || "$container" == *$'\n'* ]]; then
  echo '错误：应用容器数量不符合预期，此入口仅支持单实例 Compose 服务。' >&2
  exit 1
fi
actual_image=$(timeout --kill-after=5s 15s docker inspect --format '{{.Config.Image}}' "$container")
actual_revision=$(timeout --kill-after=5s 15s docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' "$container")
health=$(timeout --kill-after=5s 15s docker inspect --format '{{.State.Health.Status}}' "$container")
if [[ "$actual_image" != "$image" || "$actual_revision" != "$revision" || "$health" != healthy ]]; then
  printf '错误：运行版本或健康检查不符，实际镜像：%s，实际提交：%s，健康状态：%s。请在服务器检查应用容器。\n' \
    "$actual_image" "$actual_revision" "$health" >&2
  exit 1
fi

# 成功后才记录完整摘要；避免后续手动 Compose 操作回退到过时的标签。
if ! timeout --kill-after=5s 20s python3 - "$DEPLOY_DIR/.env" "$IMAGE_ENV_VAR" "$image" <<'PY'
from pathlib import Path
import os
import re
import sys
import tempfile

path = Path(sys.argv[1])
name, image = sys.argv[2:]
pattern = re.compile(r"^(?:export\s+)?" + re.escape(name) + r"\s*=")
original = path.read_bytes()
lines = original.decode().splitlines(keepends=True)
updated = []
written = False
for line in lines:
    if pattern.match(line):
        if not written:
            updated.append(f"{name}={image}\n")
            written = True
    else:
        updated.append(line)
if not written:
    if updated and not updated[-1].endswith("\n"):
        updated[-1] += "\n"
    updated.append(f"{name}={image}\n")
content = "".join(updated).encode()
if content != original:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".env.", delete=False) as f:
            temporary = f.name
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, path)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)
PY
then
  printf '错误：应用已更新且健康，但镜像配置未落盘，项目：%s。请检查 .env 权限、磁盘空间，并重新执行部署。\n' "$PROJECT_NAME" >&2
  exit 1
fi
printf '部署成功，项目：%s，镜像：%s，提交：%s，健康状态：%s，镜像配置已保存。\n' "$PROJECT_NAME" "$actual_image" "$actual_revision" "$health"
