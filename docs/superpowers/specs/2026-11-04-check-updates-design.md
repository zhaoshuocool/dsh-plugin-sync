# 检查更新（updatePolicy）设计

日期：2026-11-04　状态：已确认要做，作者已定的取舍见文末

## 意图与动机

同步只镜像「装了哪些 bundle、启不启用」，版本会悄悄落后：本机 `@michengai/dsh-skills-manager`
停在 1.2.26，registry 上 latest 已经是 1.2.29（清单里的 `^1.2.24` 本来就允许它），没有任何
机制会发现这件事。用户要的是「插件能发现新版，并按我要的方式用上」。

## 目标

- 每个同步周期（可缓存）对 npm 源查 registry 的 `dist-tags.latest`。
- 已装版本比它旧、且 latest 落在清单声明的区间内 → 视为可升级。
- `updatePolicy: check` → 只记录并显示（状态里的 `updates` + 日志），可一键升级。
- `updatePolicy: auto` → 直接升级，不需要人点。
- 升级动作 = `remove_bundle` + `install_bundle`（宿主对已装包会 `refused("already-installed")`）。
- 查询走插件已有的 `proxy` 配置。
- 永不升级本 bundle 自己（宿主 HMR 事务不能嵌套）。

## 非目标

- `github:` / `file:` / `link:` / `ssh:` 源的版本判定（清单里没有 commit 可比）。
- 版本回滚 UI、per-bundle pin 管理。
- 把「已装版本」写进远端清单（formatVersion 1 的 entry 只有 name/source/enabled）。

## 反目标

- 不能变成每 5 分钟重装一次——那是刚修掉的漂移抖动（见 README 修复记录 5、6）。
- registry 不可达时不能把已装好的插件弄坏，也不能清掉上一次的结果。

## 约束

- **零运行时依赖**：`undici` 在 profile 里解析不到（`MODULE_NOT_FOUND`），带代理的 HTTPS
  只能用 `node:http` 的 CONNECT + `node:tls` 手写。
- 每个周期对 npm bundle 各发一个请求；用 24h 缓存抑制。
- 不新增宿主 RPC：只用已有的 `list_bundles` / `remove_bundle` / `install_bundle`。

## 做法（三个里选一个）

1. **插件自带 registry 客户端 + 复用现有 reinstall 原语**（选它）。零依赖；升级走已经验证过的
   移除+安装路径和它的错误处理；策略开关清晰；与其它机器同步语义不冲突。
2. 把「最新版本」写进远端清单，谁升级谁 push。省掉其它机器的网络请求，但**不会主动发现**
   新版，只是传播已知的升级；当作以后的补充，不解决主要问题。
3. 用 `subprocess` 跑 `npm view`。省事，但依赖 npm 在 PATH、慢，且代理是另一套配置
   （`npm config get https-proxy` 在这台机器上是 null）。否。

## 具体形状

- 新配置 `updatePolicy`: `off`（默认，行为与现在一致）| `check` | `auto`。
- 新模块 `registry.mjs`：`fetchJson(url, { proxy, timeoutMs })`（CONNECT 隧道；无 proxy 走
  直连 HTTPS），`latestVersions(names, { proxy, registry, timeoutMs, log })` →
  `{ ok: [{ name, latest }], failed: [{ name, error }] }`，单个包失败不影响其它。
- `core.mjs`：`semverCompare(a, b)`、`rangeAccepts(spec, version)`（`^` / `~` / 精确 / `*`）、
  `installedVersionsFromList(rows)`（只读 `version`，不进清单渲染）、
  `planUpdates(entries, installedVersions, latestByName, { selfName })` →
  `[{ name, from, to, spec }]`。
- `engine.mjs`：pull 之后，若 `policy !== 'off'` 且距 `lastUpdateCheckAt` 超过 24h → 检查；
  `check` 只写状态与日志；`auto` 立即按 `spec` 移除+安装，并记录每个包的上次升级时间防抖。
- 新路由 `POST /api/plugin-sync/update { names: [...] }`：`check` 模式下的手动升级。
- status 新增 `updates: [{ name, from, to }]`、`lastUpdateCheckAt`；设置页新增策略下拉与
  「可升级」列表 + 「升级」按钮。

## 留给实现者定的

registry 基址先用 `https://registry.npmjs.org`（不做 `registry` 配置项）；超时 10s；
一次检查失败下次周期再试（不额外退避）；日志措辞。
