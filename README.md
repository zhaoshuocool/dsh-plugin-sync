# dsh-plugin-sync

DeepSeek Harness（DSH）桌面端插件：通过一个私有 Git 仓库，在多台电脑之间自动同步
profile 的插件 bundle 清单（安装了哪些 bundle、各自是否启用）。

本机清单变化（`pnpm add` / 插件开关）会被 debounce 后 push 到远端 `plugin-sync.json`；
其它机器按固定间隔 pull，并把本机收敛到远端清单（先装缺失、再启用/停用、最后移除多余，
先加后减，收敛期间不打断会话）。

## 安装

在 DSH 里安装本 bundle（或 `plugin_manager install_bundle`，target 为本目录），
然后配置远端仓库。**推荐直接在 设置 → Plugins → 插件同步 页面填写仓库地址并保存**
（改动会写入 profile 的 `cordis.patch.yml` 并即时生效）。等价的 YAML 写法：

```yaml
- id: dsh-plugin-sync
  name: dsh-plugin-sync
  config:
    repo: git@github.com:you/private-sync.git   # 或 file:///C:/local/repo
    branch: main            # 可选，默认 main
    pullIntervalMs: 300000  # 可选，默认 5 分钟，最小 60000
    machineName: desk-1     # 可选，默认 os.hostname()
    proxy: http://127.0.0.1:10808  # 可选，留空 = 不走代理
```

保存后自动生效（patch 热重载）。未配置 `repo` 时插件处于 `disabled`。

`proxy` 只作用于 http/https 远端（`ssh:` 远端请用 ssh 自己的配置）。桌面环境
需要它：Windows 的代理设置放在系统里，`git` 不读，子进程环境又被清理过，
所以插件对每次 git 调用注入 `-c http.proxy=<url> -c https.proxy=<url>`。

## 首次连接（引导二选一）

远端有清单而本机没有基线、且两边不一致时进入 `await-choose`，在
设置 → Plugins → 插件同步 里选择：

- **以远端为准**：本机直接收敛到远端清单；
- **先合并**：两边取并集（同名冲突远端赢），再作为新基线推送。

远端清单为空且本机非空时需要显式确认（`await-empty-confirm`），防止误删。

## 状态与操作

设置 → Plugins → 插件同步 标签页显示状态徽章、配置回显（只读）、引导按钮、
最近日志。HTTP 面（仅本机登录会话可用）：

- `GET  /api/plugin-sync/status`
- `POST /api/plugin-sync/run` — 立即执行一轮 pull+push
- `POST /api/plugin-sync/bootstrap` — `{ "mode": "remote" | "merge" }`
- `POST /api/plugin-sync/confirm-empty`
- `POST /api/plugin-sync/config` — `{ repo?, branch?, pullIntervalMs?, machineName?, proxy?, updatePolicy? }`；
  经 `configEditor` 服务写入 profile 的 `cordis.patch.yml` 并按 Loader 正常路径热生效，
  与手工编辑 YAML 等价（`repo: null` 或空字符串 = 清除 = 停用同步）
- `POST /api/plugin-sync/check-updates` — 立刻查一次 registry（绕过 24 小时缓存）
- `POST /api/plugin-sync/update` — `{ "names": ["包名", …] }`，空数组 = 全部可升级项

因此配置也可以**全部在设置页里完成**：填写仓库/分支/间隔 → 保存。README 顶部的
YAML 片段是给习惯命令行的人的等价写法。

## 更新检查（`updatePolicy`）

插件可选地查询 npm registry，看哪些**已安装的 npm 来源**有更新版本：

| `updatePolicy` | 行为 |
| --- | --- |
| `off`（默认） | 完全不联网查询，与本功能之前一致 |
| `check` | 每 24 小时查一次，把可升级项列在设置页，由人点「升级」 |
| `auto` | 查到就直接升级（先 `remove_bundle` 再 `install_bundle`） |

规则要点：

- 只处理 npm 来源。`github:` / `file:` / `link:` 一类来源不查询、不升级。
- **不会升级插件自己**（`dsh-plugin-sync` 永远跳过），避免升级中途把自己卸掉。
- 只在清单里的 range **确实会挑中**新版本时才升级：`^1.2.24` 遇到 `1.2.29` 会升；
  钉死成 `1.2.24` 是人下的决定，插件不越权；`^1.2.24` 也不会被升到 `2.x`。
- 升级用的仍是清单里原有的 `source`，不改写清单。因此同 major 内的升级**不会自动
  传播到其他机器**；要把某个版本带到别的机器，就在设置页/清单里钉一个确切版本。
- 一次成功升级会记账：若 registry 仍报同一版本（缓存滞后或解析受限），不会每个周期
  反复装卸。
- 查询失败（离线、registry 不可达）只写日志，不影响同步与安装。
- 走 `proxy` 配置：`http(s)` 代理用 CONNECT 建隧道后再 TLS，代理不可用时报错而不是
  偷偷直连。registry 地址固定 `https://registry.npmjs.org`。

## 实现要点

- 零运行时 npm 依赖；git 走系统 `git` CLI（`subprocess` 注入服务）。
- 收敛计划对插件自身只允许启用/停用，永不 install/remove/reinstall 自己
  （在自身请求事务里移除自己会触发 "HMR transactions cannot be nested"）。
- 每台机器在 `<DSH_HOME>/plugin-sync/<sha256(repo)[:16]>/` 维护独立 workcopy、
  `baseline.json`（上次共同确认的清单）与 `state.json`（远端镜像）。
- 推送触发：监听 profile 的 `package.json` 与 `cordis.patch.yml`（30s debounce）；
  监听建立失败时降级为 60s 本地快照对比。
- 单飞调度：同一时刻只有一个同步任务；执行中的请求合并为结束后补跑一次。

## 端到端验证记录（2026-11-03，Windows，git 2.55 / DSH 0.2.1-rc.5）

1. 以 `%TEMP%\plugin-sync-origin` 裸仓当远端，`plugin-sync.json` 预置 5 个 bundle
   （含本插件自身与鲸鱼挂件）。
2. `plugin_manager install_bundle` 目录链接安装 → `set_bundle` 关闭/开启 →
   `application: applied`，Config entry `include:dsh-plugin-sync` 挂载可见
   （schema 投影为 `unsupported`，属投影器对手写 Standard Schema 的限制，不影响校验）。
3. 向用户 patch 追加 `repo: file:///...` override → **热重载即时生效**，15s 后首拉，
   日志按 300s 节奏出现（18:47/18:52/19:02/19:07/19:12…）。
4. 第二台机器语义：远端提交移除鲸鱼挂件 → 下一轮自动拉取进入 `await-choose`，
   设置页卡片显示「以远端为准 / 先合并」，点击后：鲸鱼 bundle 从
   `list_bundles` 消失、`baseline.json` 写入、远端无多余提交（内容一致 no-op）。
5. 全程用户 `cordis.patch.yml` 除临时 override 6 行外 **零变化**；验证后 patch 还原
   （恢复原始文件、0 处 plugin-sync 痕迹）、鲸鱼经 `install_bundle` 装回、
   临时仓与 `<DSH_HOME>/plugin-sync/` 均已删除。本 bundle 保留安装（默认 disabled）。

已知观察：bundle 的 `source` 字符串在不同安装路径下可能以不同斜杠形式出现
（`link:E:\…` vs `link:E:/…`），会被视为 source 漂移触发 reinstall/引导。
跨机器同步时建议远端使用 git URL 类 source。

## 修复与验证记录（2026-11-04，Windows，真实 GitHub 远端）

1. **保存必失败**：`saveConfig` 按 `patchId` / `name` / `moduleName` 找自己的 entry，
   而 Loader Entry 的身份在 `entry.options` 里，于是永远查不到 → 稳定 503
   `this plugin is not addressable in the profile patch`。改成宿主其它调用方的写法
   （运行中 fiber 的 entry，否则按 `options.id`），并抽成导出的 `createSaveConfig(ctx)`——
   api 测试一直注入假 `saveConfig`，这条只在真实宿主里跑过的写路径此前没有覆盖。
2. **前端吞掉失败原因**：`postAction` 对非 2xx 直接 throw，丢掉响应里的 `error`，
   页面只剩「配置保存失败。」。现在会读出响应体，把真实原因显示出来。
3. **代理**：git 不读 Windows 系统代理，子进程环境又被 scrub，直连 GitHub 443 超时
   （`git fetch failed … Failed to connect to github.com port 443`、
   `git push rejected: Recv failure: Connection was reset`）。新增 `proxy` 配置项，
   对每次调用注入 `-c http.proxy=… -c https.proxy=…`；设置页加同名输入框（留空=不走代理）。
4. 实测远端 `https://github.com/zhaoshuocool/plugin-sync.git` + 代理 `http://127.0.0.1:10808`：
   保存写入 patch → 热重载 → 读到另一台机器推的清单（5 个 bundle）→
   `bootstrap {"mode":"remote"}` 收敛：装 4 个、移除 1 个、`errors: []`，
   `baseline.json` / `state.json` 落盘，状态回到 `idle`。
   顺带确认：pnpm 安装可直达 GitHub，只有 git 这条路需要代理。
5. **npm 区间漂移抖动**：远端写 `mgr@^1.2.24`，本机装完后 pnpm 把 source 规范化成
   `mgr@^1.2.26`（已装版本同时满足两个区间）。按字符串比较 source 就永远不一致 →
   每轮同步 remove+install 一次（实测 09:02:15 与 09:07:15 两轮，间隔正好一个 pull 周期）。
   现在 npm source 按「解析器搬不动的边界」判定是不是同一个安装：
   - 区间（`^1.2.24` / `~1.2` / `>=1.0` / `1.x - 2`）：同 major 即同一个安装。caret 与 tilde
     跨不过 major，所以作者发布 2.x 也不会让 `^1.x` 装到 2.x；只有真有人手动升到 2.x 才是
     一次重装，装完本机记录变成 `^2.3.1`，与远端 `^2.0.0` 同 major → 收敛一次就停。
   - 精确 pin（`2.3.1`）：只与「该版本被记录下来的写法」（`^2.3.1`）相等，所以 pin 会传播，
     各机器跟上之后也不再动。
   - 浮动 spec（`latest` / `next` / `*` / `>=…`）：只比包名，这类区间永远不可能等于记录值。
   `github:` / `file:` / `link:` / `ssh:` 与裸路径仍按原样比较；不带版本也不带 `@` 的任意
   字符串不当作 npm spec，照旧按字符串比较。
   代价：同 major 内的 minor 升级不会自动跨机器传播（分不清 pnpm 的改写与故意升 minor），
   要强制某个版本就用精确 pin。
6. **`HMR transactions cannot be nested`**（观察）：宿主 `dsh-hmr` 用 AsyncLocalStorage
   记账，事务执行中再发起 pluginManager 变更会被拒。00:05 / 00:10 两轮的 remove 撞的就是
   这条，宿主重启后同一个 remove 在 09:02 正常完成——是执行上下文问题，不是清单损坏，
   插件侧也没有可靠绕法；第 5 条修掉每轮重装后就不再触发它。
7. **新增：更新检查（2026-11-04）**：见上文「更新检查（`updatePolicy`）」。实现分四块：
   `registry.mjs` 是零依赖的 registry 客户端（`https` 请求，代理时先 CONNECT 隧道再 TLS，
   隧道断或被拒一定报错，不会退化成直连）；`core.mjs` 的 `semverCompare` / `rangeAccepts` /
   `planUpdates` 只判断该不该升（精确 pin 不动，range 挑不中的版本不升）；`engine.mjs` 按策略
   与 24 小时缓存执行，升级复用已有的 remove+install 原语，并记账避免重复装卸；设置页多一个
   策略下拉与「可升级」列表。测试 104 → 134 条，全绿。
