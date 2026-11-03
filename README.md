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
```

保存后自动生效（patch 热重载）。未配置 `repo` 时插件处于 `disabled`。

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
- `POST /api/plugin-sync/config` — `{ repo?, branch?, pullIntervalMs?, machineName? }`；
  经 `configEditor` 服务写入 profile 的 `cordis.patch.yml` 并按 Loader 正常路径热生效，
  与手工编辑 YAML 等价（`repo: null` 或空字符串 = 清除 = 停用同步）

因此配置也可以**全部在设置页里完成**：填写仓库/分支/间隔 → 保存。README 顶部的
YAML 片段是给习惯命令行的人的等价写法。

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
