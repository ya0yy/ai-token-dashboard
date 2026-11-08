#!/usr/bin/env bash
# GitHub Actions 的通用部署客户端，仅向固定 SSH 入口传数据，不传远程命令。
set -Eeuo pipefail

for variable in SSH_HOST SSH_PORT SSH_USER SSH_KNOWN_HOSTS DEPLOY_PATH DEPLOY_IMAGE DEPLOY_REVISION HEALTHCHECK_URL HEALTHCHECK_STATUS SSH_PRIVATE_KEY RUNNER_TEMP; do
  if [[ -z "${!variable:-}" ]]; then
    printf '错误：部署缺少配置，变量：%s。请检查 Environment Variables 或 Secrets。\n' "$variable" >&2
    exit 1
  fi
done
if [[ ! "$DEPLOY_IMAGE" =~ ^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$ || ! "$DEPLOY_REVISION" =~ ^[a-f0-9]{40}$ ]]; then
  echo '错误：镜像摘要或提交号不合法，停止部署。' >&2
  exit 1
fi
if [[ ! "$SSH_HOST" =~ ^[a-zA-Z0-9._:-]+$ || ! "$SSH_USER" =~ ^[a-z_][a-z0-9_-]*$ || ! "$SSH_PORT" =~ ^[0-9]{1,5}$ ]] || (( 10#$SSH_PORT < 1 || 10#$SSH_PORT > 65535 )); then
  echo '错误：SSH 主机、用户名或端口格式不正确，请检查 Environment。' >&2
  exit 1
fi
if [[ "$DEPLOY_PATH" != /* || "$DEPLOY_PATH" == *$'\n'* || "$DEPLOY_PATH" == *$'\r'* || "$HEALTHCHECK_URL" != https://* || ! "$HEALTHCHECK_STATUS" =~ ^[1-5][0-9]{2}$ ]]; then
  echo '错误：部署目录或 HTTPS 健康检查配置不合法，请检查 Environment。' >&2
  exit 1
fi

# 私钥仅位于权限受限的 Runner 临时目录，退出时删除，不进入日志或产物。
umask 077
ssh_dir=$(mktemp -d "$RUNNER_TEMP/deploy-ssh.XXXXXX")
trap 'rm -rf "$ssh_dir"' EXIT
printf '%s\n' "$SSH_PRIVATE_KEY" > "$ssh_dir/key"
printf '%s\n' "$SSH_KNOWN_HOSTS" > "$ssh_dir/known_hosts"
ssh-keygen -y -f "$ssh_dir/key" > /dev/null
known_host="$SSH_HOST"
if [[ "$SSH_PORT" != 22 ]]; then known_host="[$SSH_HOST]:$SSH_PORT"; fi
if ! ssh-keygen -F "$known_host" -f "$ssh_dir/known_hosts" > /dev/null; then
  echo '错误：SSH_KNOWN_HOSTS 中没有目标主机记录，请通过可信连接核对 SSH 主机公钥。' >&2
  exit 1
fi

printf '开始 SSH 部署，镜像：%s，提交：%s\n' "$DEPLOY_IMAGE" "$DEPLOY_REVISION"
printf '%s\n' "$DEPLOY_IMAGE" "$DEPLOY_PATH" "$DEPLOY_REVISION" |
  timeout --kill-after=10s 1250s ssh -T \
    -o BatchMode=yes -o IdentitiesOnly=yes \
    -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$ssh_dir/known_hosts" \
    -o ConnectTimeout=10 -o ConnectionAttempts=1 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -i "$ssh_dir/key" -p "$SSH_PORT" "$SSH_USER@$SSH_HOST"

# 401 可用于启用鉴权的控制台，200 可用于 API 的公开健康接口。
status=$(curl --silent --show-error --proto '=https' --connect-timeout 10 --max-time 30 \
  --output /dev/null --write-out '%{http_code}' "$HEALTHCHECK_URL")
if [[ "$status" != "$HEALTHCHECK_STATUS" ]]; then
  printf '错误：公网 HTTPS 验证失败，预期状态：%s，实际状态：%s。请检查反向代理和应用容器。\n' "$HEALTHCHECK_STATUS" "$status" >&2
  exit 1
fi
printf '公网 HTTPS 验证通过，HTTP 状态：%s\n' "$status"
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo '### 自动部署成功'
    printf '镜像：`%s`\n\n' "$DEPLOY_IMAGE"
    printf '提交：`%s`\n\n' "$DEPLOY_REVISION"
    printf '公网验证：%s，HTTP 状态：%s\n' "$HEALTHCHECK_URL" "$status"
  } >> "$GITHUB_STEP_SUMMARY"
fi
