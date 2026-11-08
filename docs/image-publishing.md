# Fork 镜像构建与发布

此 fork 在上游功能上加入 M 单位显示、定价版本兼容修复和 cron / HTTPS 客户端。

## 发布流程

推送 `main`、推送 `v*` 版本标签或手动运行 Actions 都会启动 CI。合并请求只执行检查。
只有跨平台 Node 测试、浏览器回归、依赖审计、数据库集成和客户端脚本检查全部通过，才会发布镜像。

- 镜像：`ghcr.io/ya0yy/ai-token-dashboard`
- 架构：`linux/amd64`、`linux/arm64`
- `main` 标签：`latest` 与 `sha-<提交号>`。
- 版本标签：例如推送 `v1.0.0`，发布同名镜像标签。
- Actions 使用仓库自带的 `GITHUB_TOKEN`，不需要额外配置镜像仓库密码。
- 第三方 Actions 固定到提交 SHA；构建缓存由 GitHub Actions 管理。

工作流入口：[CI and Docker image](https://github.com/ya0yy/ai-token-dashboard/actions/workflows/ci.yml)。

## 拉取与部署

```bash
docker pull ghcr.io/ya0yy/ai-token-dashboard:latest
```

GHCR 首次创建的包默认为私有。如果要匿名拉取，在 GitHub 的包设置中将可见性改为 Public。
私有包拉取需要先使用具有 `read:packages` 权限的经典 PAT 登录 `ghcr.io`。
相关权限说明见 [GitHub Container registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)。

使用根目录 `docker-compose.yml` 时，在保留服务器现有 `.env` 和 `data/` 的前提下更新配置，然后执行：

```bash
docker compose pull
docker compose up -d --no-build --wait --wait-timeout 90
```

可通过 `.env` 中的 `AI_TOKEN_DASHBOARD_IMAGE` 指定版本标签或镜像摘要。
正式部署配置只拉取镜像，不含 `build`，服务器不需要保留源码。开发者如需本地构建，可在源码仓库执行 `docker build -t ghcr.io/ya0yy/ai-token-dashboard:local .`。
流水线负责镜像检查、构建和发布，服务器更新由部署者执行。

## 本地 Git 关系

```text
origin    git@github.com:ya0yy/ai-token-dashboard.git
upstream  https://github.com/fengguanghuai/ai-token-dashboard.git
```

日常更改推送到 `origin/main`；同步原项目时从 `upstream` 获取更新。

## 构建内容

Dockerfile 分为前端构建和运行阶段：前端在构建机原生架构编译，目标架构只安装生产依赖，并复制应用源码、数据库结构、采集配置、两份定价快照和已编译的前端。
`.dockerignore` 使用文件白名单，机器配置、使用记录、凭据、日志、Git 目录和本地运行快照不进入构建上下文。
应用运行时的 `INGEST_TOKEN`、`DASHBOARD_TOKEN` 通过 `.env` 传入，不放进镜像或工作流。
