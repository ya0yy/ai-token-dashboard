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
`main` 的镜像发布成功后，流水线会自动通过 SSH 更新 tom；版本标签只发布镜像。
部署使用本次构建返回的镜像摘要，不依赖可变化的 `latest` 标签。

## tom 自动部署

在仓库的 **Settings → Environments → tom** 中维护配置。
该环境只允许 `main` 分支部署，不设置人工审批，以便成功构建后自动上线。

| 类型 | 名称 | 用途 |
| --- | --- | --- |
| Environment variable | `SSH_HOST` | tom 的 SSH 主机地址 |
| Environment variable | `SSH_PORT` | SSH 端口 |
| Environment variable | `SSH_USER` | SSH 用户 |
| Environment variable | `SSH_KNOWN_HOSTS` | 通过可信连接核对的主机公钥记录，用于严格校验服务器身份 |
| Environment variable | `DEPLOY_PATH` | `/data/app/ai-token-dashboard` |
| Environment variable | `HEALTHCHECK_URL` | `https://tks.420114.xyz/` |
| Environment variable | `HEALTHCHECK_STATUS` | `401`，控制台未认证时的预期响应 |
| Environment secret | `SSH_PRIVATE_KEY` | 仅供此应用部署使用的 Ed25519 私钥 |

服务端部署入口由仓库的 `deploy/tom-deploy.sh` 安装到 `/data/app/ai-token-dashboard/deploy.sh`，与 Compose 配置放在同一目录，属主为 root，权限 `0755`。
专用公钥在 `/root/.ssh/authorized_keys` 中使用 `restrict` 和强制命令，只允许调用该入口，不提供交互式 Shell、端口转发或任意远程命令。
入口在执行迁移或更新前校验镜像仓库、摘要、部署目录和镜像提交，更新后核对运行版本与健康状态；服务端入口有变更时需通过管理 SSH 单独更新。

自动部署只拉取并启动配置的应用服务，不上传源码。应用健康检查通过后，仅原子更新 `.env` 中的 `AI_TOKEN_DASHBOARD_IMAGE` 为完整摘要，保留其余配置和 `data/`。这样手动执行 Compose 也会使用最后成功上线的镜像。
部署目录只保留 `docker-compose.yml`、`.env`、`data/` 和 `deploy.sh`；临时互斥锁位于 `/run/lock/`。
同一分支的流水线不会中途取消正在运行的部署，SSH、拉取镜像、迁移和健康检查均有超时。
拉取失败时不切换容器；切换后的健康检查失败会使工作流失败，不自动回滚数据库或容器。
部署结果和错误可在 Actions 的“自动部署到 tom”作业查看，公网验证要求 HTTPS 控制台返回预期的 `401` 鉴权响应。

后续更新 `main` 即可自动上线，也可以在 Actions 中选择 `main` 手动运行工作流。
若修改了 Compose 配置或新增运行环境变量，仍需通过管理 SSH 同步服务器配置后再部署。

## 适配其他 Compose 项目

`deploy/tom-deploy.sh` 的项目差异集中在顶部，只需修改下列受信配置，再安装到对应项目目录的 `deploy.sh`：

| 配置 | 用途 |
| --- | --- |
| `PROJECT_NAME`、`DEPLOY_DIR` | 项目标识、独立部署锁与允许的目录 |
| `IMAGE_REPOSITORY`、`IMAGE_ENV_VAR` | 唯一允许的镜像仓库，以及 Compose 读取完整镜像引用的变量名 |
| `APP_SERVICE` | 要更新的单实例 Compose 应用服务 |
| `COMPOSE_PROFILE`、`MIGRATION_SERVICE` | 可选 profile 和先行执行的一次性迁移服务 |
| `DEPENDENCY_SERVICES` | 只启动和等待健康、不强制重建的依赖服务 |
| `REQUIRED_PATHS` | 必须保留的项目路径，例如 `data/` |
| `PULL_TIMEOUT`、`MIGRATION_TIMEOUT`、`HEALTH_TIMEOUT` | 拉取、迁移、健康检查超时秒数 |

Compose 的 image 字段应读取对应镜像变量；例如 `${AI_TOKEN_DASHBOARD_IMAGE}`。依赖服务、迁移入口和镜像仓库都固定在服务器配置中，不能由 SSH 请求指定。
`deploy/github-deploy.sh` 为通用 Actions 客户端，workflow 只负责传入 Environment 参数并调用它。适配新项目时为每个项目生成独立密钥，强制命令只指向该项目的 `deploy.sh`，外层使用 `timeout --kill-after=10s 1200s` 限制整个部署。
服务器需要 Bash、Python 3、Docker Compose、`timeout` 和 `flock`；客户端需要 OpenSSH 和 curl。

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
