#!/usr/bin/env bash
# 安装到 tom 的 /data/app/ai-token-dashboard/deploy.sh，由专用 SSH 密钥强制调用。
# 不执行 SSH 客户端传入的命令，只从标准输入读取镜像、部署目录和提交号。
set -Eeuo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

trap 'status=$?; printf "错误：tom 部署失败，脚本行号：%s，退出码：%s。请检查上方错误和 tom 上的容器状态。\n" "$LINENO" "$status" >&2; exit "$status"' ERR

if [[ -n "${SSH_ORIGINAL_COMMAND:-}" ]]; then
  echo '错误：此密钥仅允许固定部署入口，不接受远程命令。' >&2
  exit 1
fi

image=''
deploy_path=''
revision=''
if ! IFS= read -r image || ! IFS= read -r deploy_path || ! IFS= read -r revision; then
  echo '错误：部署请求不完整，需要镜像摘要、部署目录和提交号。' >&2
  exit 1
fi
if [[ ! "$image" =~ ^ghcr\.io/ya0yy/ai-token-dashboard@sha256:[a-f0-9]{64}$ ]]; then
  echo '错误：只允许部署本仓库按 sha256 摘要固定的镜像。' >&2
  exit 1
fi
if [[ "$deploy_path" != /data/app/ai-token-dashboard || ! "$revision" =~ ^[a-f0-9]{40}$ ]]; then
  echo '错误：部署目录或提交号不合法，请核对 tom Environment 和工作流。' >&2
  exit 1
fi

# 锁放在系统运行目录，避免在项目目录添加临时运行文件。
exec 9>/run/lock/ai-token-dashboard-deploy.lock
if ! timeout --kill-after=5s 35s flock -w 30 9; then
  echo '错误：另一个部署仍在执行，请检查正在运行的 Actions 后重试。' >&2
  exit 1
fi
cd "$deploy_path"
if [[ ! -f docker-compose.yml || ! -f .env || ! -d data ]]; then
  echo '错误：部署目录缺少 docker-compose.yml、.env 或 data/，停止更新。' >&2
  exit 1
fi

# 环境变量只覆盖本次 Compose 命令，不改动服务器的令牌和持久化数据。
export AI_TOKEN_DASHBOARD_IMAGE="$image"
timeout --kill-after=5s 30s docker compose config --quiet
printf '开始拉取已通过检查的镜像，镜像：%s，提交：%s\n' "$image" "$revision"
timeout --kill-after=10s 300s docker compose pull ai-token-dashboard

# 拉取成功才切换容器；健康检查失败会让 Actions 失败，保留现场供排查。
printf '开始更新容器并等待健康检查，目录：%s\n' "$deploy_path"
timeout --kill-after=10s 180s docker compose up -d --no-deps --no-build --pull never \
  --wait --wait-timeout 90 ai-token-dashboard
actual_image=$(timeout --kill-after=5s 15s docker inspect --format '{{.Config.Image}}' ai-token-dashboard)
actual_revision=$(timeout --kill-after=5s 15s docker inspect --format '{{ index .Config.Labels "org.opencontainers.image.revision" }}' ai-token-dashboard)
health=$(timeout --kill-after=5s 15s docker inspect --format '{{.State.Health.Status}}' ai-token-dashboard)
if [[ "$actual_image" != "$image" || "$actual_revision" != "$revision" || "$health" != healthy ]]; then
  printf '错误：运行版本或健康检查不符，实际镜像：%s，实际提交：%s，健康状态：%s。请在 tom 检查 docker inspect ai-token-dashboard。\n' \
    "$actual_image" "$actual_revision" "$health" >&2
  exit 1
fi
printf 'tom 部署成功，镜像：%s，提交：%s，健康状态：%s\n' "$actual_image" "$actual_revision" "$health"
