# 后端 Agent 工作手册

## 角色定位

你是 Cloud-Maven 的后端开发 Agent，负责 `maven-worker/` 目录下的所有工作。

## 关键文件

- `../Worker.md` — 后端完整设计方案（架构、存储模型、权限、性能策略）
- `../Client.md` — 前端设计方案（接口调用参考）
- `../USAGE.md` — 部署指南
- `./Client.md` — 前端需求交接记录（前端提需求的地方，在此回复完成状态）

## 技术栈

- Runtime: Cloudflare Workers
- 语言: TypeScript
- 路由框架: Hono
- 部署工具: Wrangler
- 对象存储: Cloudflare R2 (MAVEN_BUCKET)
- 键值存储: Cloudflare KV (MAVEN_KV)
- 加密: Web Crypto API (PBKDF2-SHA256)
- 测试: Vitest + @cloudflare/vitest-pool-workers

## 当前进度 (2026-05-30)

核心链路已有首版代码，大部分接口已实现：

### 已完成
- 工程基础: Wrangler + Hono + TypeScript + Vitest 配置
- Worker 入口: 路由注册、健康检查、CORS、X-Request-Id
- shared 模块: JSON 响应、错误映射、路径安全校验、MIME 类型、缓存策略、checksum 工具
- storage 模块: R2 get/head/put/delete/list、批量删除、有限页统计
- config 模块: KV 存储仓库策略与 Settings、匿名读取与覆盖上传策略
- tokens 模块: PBKDF2-SHA256 hashing、token CRUD、Session 管理、bootstrap、权限匹配
- auth 模块: xBasic/Bearer/Cookie 鉴权、login/logout/me/session 路由
- admin 模块: 有限页统计、token 管理、settings 读写、权限输入校验
- maven 模块: GET/HEAD/PUT/POST/DELETE 文件操作、目录详情、版本摘要、目录级删除、POM 生成
- README.md: R2/KV 说明、环境变量、bootstrap token、实现边界

### 2026-05-30 已完成改动
- [x] 移除 release/snapshots 区分 — `RepositoryPolicy.allowOverwrite` 替代原有双字段
- [x] 修复 `hasPermission` 根路径 `/` 匹配 bug — 现在正确匹配所有子路径
- [x] 删除目录后自动维护 `maven-metadata.xml` — 从 versions 列表移除已删版本，更新 latest/lastUpdated

### 待补齐
- metadata 自动维护策略 — 仅完成**删除目录后**自动更新（✅）
- 生产级统计成本控制（当前最多 5 页 R2 list 近似统计）
- vitest 版本兼容（@cloudflare/vitest-pool-workers 需 vitest 2.0.x - 3.2.x，当前实际安装可能为 4.x）
- KV namespace id 需要部署者替换为实际值

### 2026-05-30 需求同步（已完成）

#### 1. 移除 release/snapshots 区分 ✅
**改动文件：**
- `src/env.ts` — `RepositoryPolicy.allowOverwrite` 替代原有双字段
- `src/config/index.ts` — DEFAULT_POLICY 和 updateSettings 合并
- `src/shared/mime.ts` — 删除 `isSnapshotArtifact()`，缓存策略不再区分 snapshot
- `src/maven/index.ts` — 删除 `isSnapshotPath/isSnapshotVersion/ensureRedeployAllowed` snapshot 分支
- `src/admin/index.ts` — `policy.allowOverwrite` 替代 `policy.allowReleaseRedeploy`

## 目录结构

```
maven-worker/src/
├── index.ts         # Hono app 入口，路由注册，CORS
├── env.ts           # TypeScript 类型定义 (Bindings, Variables)
├── auth/index.ts    # 鉴权中间件、xBasic/Bearer/Cookie 解析、Auth API
├── tokens/index.ts  # Token CRUD、Session 管理、权限匹配、bootstrap
├── admin/index.ts   # Admin API: stats, tokens CRUD, settings
├── maven/index.ts   # Maven 文件路由、目录详情、版本、POM
├── config/index.ts  # KV 仓库策略与 Settings 读写
├── storage/index.ts # R2 适配层
└── shared/          # errors, path, mime, checksum, responses
```

```
maven-worker/test/
├── auth/            # 鉴权单测
├── config/          # 配置单测
├── maven/           # metadata 单测
├── shared/          # checksum, mime, path 单测
├── tokens/          # 权限匹配单测
└── integration/     # maven-routes, auth-admin-routes 集成测试
```

## 核心约定

### API 实现
- 所有 API 响应使用统一 JSON 格式

### Maven 路径
- Maven 路径直接映射到 R2 Key，格式：`{groupIdPath}/{artifactId}/{version}/{file}`
- 路径安全校验：禁止 `..`、`//`、反斜杠、控制字符、空路径
- `/api/*` 保留给管理 API，不作为 Maven 路径

### 鉴权
- 优先兼容 Reposilite `xBasic base64(name:secret)` 风格
- 同时支持 Bearer token 和 Cookie Session
- PUBLIC 仓库允许匿名读取

### 性能
- 文件下载直接流式返回 R2 object body
- 制品缓存：`Cache-Control: public, max-age=31536000, immutable`
- metadata：`Cache-Control: no-cache`
- 统计写入 `ctx.waitUntil()`，不阻塞响应
- 不主动生成 checksum（保存客户端上传的）

## 注意事项

- 不执行 npm 命令
- 需要前端配合时在 `./Client.md` 需求交接记录章节写入，不直接改前端代码
- 后端只能操作 `maven-worker/` 目录
- 不创建 `releases`/`snapshots` 默认仓库

## 需求交接记录

### 2026-05-30 - 前端 -> 后端

状态：已完成
来源：agents/Client.md | intro.config.ts 静态化
需求：
- `introImage` 字段不再需要，请从 `/api/admin/settings` 接口及 KV 中移除 `intro_image` key 相关逻辑
- ClientSettings 已移除 `introImage` 字段，前端不再通过 settings API 获取介绍图片
- 介绍卡片相关数据改由前端静态配置文件 `intro.config.ts` 提供

验收：
- ✅ `/api/admin/settings` GET/PUT 接口不再包含 `introImage` 字段
- ✅ KV 中不再读写 `intro_image` key
- ✅ 前端 SettingsPage 不再展示 introImage 字段

当前进展：
- `ClientSettings` 接口（`env.ts:32-40`）不包含 `introImage` 字段
- `DEFAULT_SETTINGS`（`config/index.ts:12-20`）不包含 `introImage`
- `admin/index.ts` GET/PUT `/settings` 路由只返回 title/baseUrl/defaultRepository/anonymousRead/allowOverwrite/generateChecksums/maintainMetadata
- 全项目 grep 确认无 `introImage` 或 `intro_image` 残留引用
