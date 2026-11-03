/**
 * Browser half of dsh-plugin-sync.
 *
 * A tab inside Settings → Plugins showing this machine's sync status: the
 * phase badge, the (read-only) configuration, buttons for the two blocking
 * decisions (bootstrap choice, empty-manifest confirm), a "sync now" action,
 * and the recent sync log. All state comes from the Host half through
 * /api/plugin-sync/status; every button just triggers a Host-side action.
 *
 * Styling uses only theme tokens through CSS variables, following the same
 * idiom as dsh-mcp-switches, so the page follows the host theme.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-sync',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'pluginSync';

    // Runtime strings live here so the plain-JS client has no dictionary file
    // to fetch; locale/*.json carries the same copy under meta.* plus these
    // keys for the inventory card and future use.
    const DICT = {
      en: {
        tab: 'Plugin sync',
        title: 'Plugin sync',
        subtitle: 'Mirror installed plugins and their enabled state across machines through a private Git repository.',
        refresh: 'Refresh',
        reloading: 'Refreshing…',
        statusTitle: 'Status',
        lastPull: 'Last pull',
        lastPush: 'Last push',
        never: 'never',
        machine: 'This machine',
        errorLabel: 'Last error',
        retry: 'Retry',
        fetchFailed: 'Could not read the sync status.',
        opFailed: 'The action failed.',
        resultOk: 'Done.',
        resultPartial: 'Finished, but not everything applied.',
        phaseDisabled: 'Disabled',
        phaseIdle: 'Idle',
        phaseSyncing: 'Syncing…',
        phaseError: 'Error',
        phaseAwaitChoose: 'Waiting for a choice',
        phaseAwaitEmpty: 'Waiting for confirmation',
        configTitle: 'Configuration',
        repoLabel: 'Repository',
        branchLabel: 'Branch',
        proxyLabel: 'Proxy',
        proxyPlaceholder: 'blank = no proxy, e.g. http://127.0.0.1:10808',
        intervalLabel: 'Pull interval',
        minUnit: 'min',
        configHint: 'Saved changes are written to this profile’s cordis.patch.yml and take effect immediately.',
        notConfigured: 'not configured',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved. The plugin restarted with the new configuration.',
        saveFailed: 'The configuration could not be saved.',
        noChange: 'Nothing changed to save.',
        runNow: 'Sync now',
        runStarted: 'Sync started',
        chooseTitle: 'No baseline on the remote yet',
        chooseHint: 'Choose how this machine should start syncing:',
        bootstrapRemote: 'Use the remote list',
        bootstrapMerge: 'Merge both lists',
        emptyTitle: 'The remote list is empty',
        emptyHint: 'The remote plugin list is empty. Confirming converges this machine onto it — local plugins that are not in the list get removed.',
        confirmEmpty: 'Confirm convergence onto the empty list',
        busy: 'Working…',
        logsTitle: 'Recent log',
        noLogs: 'Nothing logged yet.',
      },
      zh: {
        tab: '插件同步',
        title: '插件同步',
        subtitle: '通过私有 Git 仓库在多台电脑之间同步插件与启用状态。',
        refresh: '刷新',
        reloading: '刷新中…',
        statusTitle: '状态',
        lastPull: '上次拉取',
        lastPush: '上次推送',
        never: '从未',
        machine: '本机',
        errorLabel: '最近错误',
        retry: '重试',
        fetchFailed: '读取同步状态失败。',
        opFailed: '操作失败。',
        resultOk: '完成。',
        resultPartial: '已结束，但有项目没有应用。',
        phaseDisabled: '未启用',
        phaseIdle: '空闲',
        phaseSyncing: '同步中…',
        phaseError: '出错',
        phaseAwaitChoose: '等待选择',
        phaseAwaitEmpty: '等待确认',
        configTitle: '配置',
        repoLabel: '仓库',
        branchLabel: '分支',
        proxyLabel: '代理',
        proxyPlaceholder: '留空 = 不走代理，例如 http://127.0.0.1:10808',
        intervalLabel: '拉取间隔',
        minUnit: '分钟',
        configHint: '保存后写入本配置档案的 cordis.patch.yml，立即生效。',
        notConfigured: '未配置',
        save: '保存',
        saving: '保存中…',
        saved: '已保存，插件已按新配置重启。',
        saveFailed: '配置保存失败。',
        noChange: '没有需要保存的改动。',
        runNow: '立即同步',
        runStarted: '已触发同步',
        chooseTitle: '远端还没有基线',
        chooseHint: '选择这台电脑开始同步的方式：',
        bootstrapRemote: '以远端为准',
        bootstrapMerge: '先合并（两边取并集）',
        emptyTitle: '远端清单为空',
        emptyHint: '远端插件清单是空的。确认后本机按空清单收敛——不在清单里的本地插件会被移除。',
        confirmEmpty: '确认按空清单收敛',
        busy: '处理中…',
        logsTitle: '最近日志',
        noLogs: '暂无日志。',
      },
    };

    const STATUS_URL = '/api/plugin-sync/status';
    const RUN_URL = '/api/plugin-sync/run';
    const BOOTSTRAP_URL = '/api/plugin-sync/bootstrap';
    const CONFIRM_EMPTY_URL = '/api/plugin-sync/confirm-empty';
    const CONFIG_URL = '/api/plugin-sync/config';

    /** Read the current sync status from the Host. */
    async function readStatus() {
      const response = await fetch(STATUS_URL, { credentials: 'same-origin' });
      if (!response.ok) throw new Error('http-' + response.status);
      return response.json();
    }

    /** Trigger one Host-side action; resolves with its JSON body. */
    async function postAction(url, body) {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      // A rejected action still answers with { ok: false, error }, and that
      // text is the only clue this page has: read the body whenever there is
      // one, and only fall back to the bare status for a bodyless failure.
      let result = null;
      try {
        result = await response.json();
      } catch {
        result = null;
      }
      if (result === null && !response.ok) throw new Error('http-' + response.status);
      return result ?? {};
    }

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: '16px', padding: '4px 0' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' },
      heading: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
      title: {
        margin: 0, fontSize: '15px', fontWeight: 600, lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary)',
      },
      subtitle: {
        margin: 0, fontSize: '12px', lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
      },
      card: {
        display: 'flex', flexDirection: 'column', gap: '10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '10px', background: 'var(--dsw-alias-bg-layer-1)',
        padding: '12px 14px',
      },
      cardTitle: {
        margin: 0, fontSize: '12px', fontWeight: 600, lineHeight: '18px',
        color: 'var(--dsw-alias-label-secondary)',
        textTransform: 'uppercase', letterSpacing: '0.4px',
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' },
      label: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)', minWidth: '84px' },
      value: {
        fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-primary)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1,
      },
      input: {
        flex: 1, minWidth: 0, fontSize: '12px', lineHeight: '18px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: '7px',
        padding: '5px 8px', fontFamily: 'monospace',
      },
      hint: { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      button: {
        flex: 'none', cursor: 'pointer',
        fontSize: '12px', lineHeight: '18px', fontWeight: 500,
        padding: '5px 10px', borderRadius: '7px',
        color: 'var(--dsw-alias-label-primary)',
        background: 'var(--dsw-alias-bg-layer-2)',
        border: '1px solid var(--dsw-alias-border-l1)',
      },
      buttonPrimary: {
        color: 'var(--dsw-alias-bg-base)',
        background: 'var(--dsw-alias-brand-primary)',
        border: '1px solid transparent',
      },
      notice: {
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px',
        padding: '10px 14px', borderRadius: '10px',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: 'var(--dsw-alias-label-secondary)', fontSize: '12px', lineHeight: '18px',
      },
      noticeError: {
        borderColor: 'var(--dsw-alias-state-error-primary)',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      noticeOk: {
        borderColor: 'var(--dsw-alias-state-success-primary)',
        color: 'var(--dsw-alias-state-success-primary)',
      },
      dot: (phase) => ({
        width: '6px', height: '6px', borderRadius: '50%', flex: 'none',
        background: phase === 'error'
          ? 'var(--dsw-alias-state-error-primary)'
          : phase === 'syncing'
            ? 'var(--dsw-alias-brand-primary)'
            : phase === 'idle'
              ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-state-idle-primary)',
      }),
      badge: {
        fontSize: '11px', lineHeight: '16px', fontWeight: 600,
        padding: '1px 6px', borderRadius: '5px',
        color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      logList: { display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '220px', overflowY: 'auto' },
      logRow: { display: 'flex', gap: '8px', fontSize: '11px', lineHeight: '16px' },
      logTime: { color: 'var(--dsw-alias-label-secondary)', opacity: 0.75, flex: 'none' },
      logWarn: { color: 'var(--dsw-alias-state-error-primary)' },
      logInfo: { color: 'var(--dsw-alias-label-primary)' },
    };

    const PHASE_KEYS = {
      disabled: 'phaseDisabled',
      idle: 'phaseIdle',
      syncing: 'phaseSyncing',
      error: 'phaseError',
      'await-choose': 'phaseAwaitChoose',
      'await-empty-confirm': 'phaseAwaitEmpty',
    };

    function formatTime(iso) {
      if (!iso) return null;
      const date = new Date(iso);
      return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
    }

    /**
     * The Settings → Plugins tab body. Polls the Host status while mounted.
     * @param props - slot props (unused beyond rendering).
     * @param ctxRef - closure context providing the translator (bound below).
     * @returns React element.
     */
    function makePanel(ctx) {
      return function SyncPanel() {
        const t = ctx.locale.bind(NS);
        const [status, setStatus] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [notice, setNotice] = React.useState(null);

        const load = React.useCallback(async () => {
          try {
            setStatus(await readStatus());
            setError(null);
          } catch {
            setError(t('fetchFailed'));
          }
        }, [t]);

        React.useEffect(() => {
          void load();
          const timer = setInterval(() => void load(), 5000);
          return () => clearInterval(timer);
        }, [load]);

        const act = React.useCallback(async (url, body) => {
          setBusy(true);
          setNotice(null);
          try {
            const result = await postAction(url, body);
            if (result && result.ok === false) {
              setError(result.error ? String(result.error) : t('opFailed'));
            } else if (result && result.outcome) {
              setNotice(result.outcome.errors && result.outcome.errors.length > 0
                ? { kind: 'warn', text: t('resultPartial') }
                : { kind: 'ok', text: t('resultOk') });
            } else {
              setNotice({ kind: 'ok', text: t('runStarted') });
            }
            setError(null);
          } catch {
            setError(t('opFailed'));
          } finally {
            await load();
            setBusy(false);
          }
        }, [load, t]);

        // Editable configuration: the draft starts empty and falls back to the
        // live status values; saving posts only the fields that changed and the
        // Host persists them through the profile config editor.
        const [draft, setDraft] = React.useState(null);
        const repoValue = (draft && draft.repo !== undefined) ? draft.repo : (status?.repo ?? '');
        const branchValue = (draft && draft.branch !== undefined) ? draft.branch : (status?.branch || 'main');
        const proxyValue = (draft && draft.proxy !== undefined) ? draft.proxy : (status?.proxy ?? '');
        const intervalValue = (draft && draft.intervalMin !== undefined)
          ? draft.intervalMin
          : String(status?.intervalMs ? Math.round(status.intervalMs / 60000) : 5);

        const onSaveConfig = React.useCallback(async () => {
          const body = {};
          const repoTrim = repoValue.trim();
          if (repoTrim !== (status?.repo ?? '')) body.repo = repoTrim === '' ? null : repoTrim;
          const branchTrim = branchValue.trim() || 'main';
          if (branchTrim !== (status?.branch || 'main')) body.branch = branchTrim;
          const proxyTrim = proxyValue.trim();
          if (proxyTrim !== (status?.proxy ?? '')) body.proxy = proxyTrim === '' ? null : proxyTrim;
          const minutes = Math.max(1, Number.parseInt(intervalValue, 10) || 5);
          const ms = minutes * 60000;
          if (ms !== (status?.intervalMs ?? 300000)) body.pullIntervalMs = ms;
          if (Object.keys(body).length === 0) {
            setNotice({ kind: 'warn', text: t('noChange') });
            return;
          }
          setBusy(true);
          setNotice(null);
          try {
            const result = await postAction(CONFIG_URL, body);
            if (result && result.ok === true) {
              setDraft(null);
              setNotice({ kind: 'ok', text: t('saved') });
            } else {
              setNotice({ kind: 'warn', text: (result && result.error) || t('saveFailed') });
            }
          } catch {
            setNotice({ kind: 'warn', text: t('saveFailed') });
          } finally {
            await load();
            setBusy(false);
          }
        }, [branchValue, intervalValue, load, proxyValue, repoValue, status, t]);

        const phase = status?.phase ?? 'disabled';
        const phaseLabel = t(PHASE_KEYS[phase] ?? 'phaseDisabled');
        const logs = (status?.log ?? []).slice(-20).reverse();

        return h('div', { style: styles.page },
          h('div', { style: styles.header },
            h('div', { style: styles.heading },
              h('h2', { style: styles.title }, t('title')),
              h('p', { style: styles.subtitle }, t('subtitle')),
            ),
            h('button', {
              type: 'button',
              style: styles.button,
              onClick: () => void load(),
            }, t('refresh')),
          ),

          error !== null
            ? h('div', { style: { ...styles.notice, ...styles.noticeError } },
                h('span', null, error),
                h('button', { type: 'button', style: styles.button, onClick: () => void load() }, t('retry')))
            : null,
          notice !== null
            ? h('div', {
                style: notice.kind === 'ok'
                  ? { ...styles.notice, ...styles.noticeOk }
                  : { ...styles.notice, ...styles.noticeError },
              }, h('span', null, notice.text))
            : null,

          // Status card: phase badge, timestamps, machine, last error.
          h('div', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t('statusTitle')),
            h('div', { style: styles.row },
              h('span', { style: styles.dot(phase), 'aria-hidden': true }),
              h('span', { style: styles.badge }, phaseLabel),
              status?.machineName ? h('span', { style: { ...styles.label, marginLeft: '8px' } }, t('machine')) : null,
              status?.machineName ? h('span', { style: styles.value }, status.machineName) : null,
            ),
            h('div', { style: styles.row },
              h('span', { style: styles.label }, t('lastPull')),
              h('span', { style: styles.value }, formatTime(status?.lastPullAt) ?? t('never')),
              h('span', { style: styles.label }, t('lastPush')),
              h('span', { style: styles.value }, formatTime(status?.lastPushAt) ?? t('never')),
            ),
            status?.error
              ? h('div', { style: { ...styles.hint, ...styles.logWarn } }, t('errorLabel') + ': ' + status.error)
              : null,
          ),

          // Blocking decisions: bootstrap choice / empty confirm.
          phase === 'await-choose'
            ? h('div', { style: styles.card },
                h('h3', { style: styles.cardTitle }, t('chooseTitle')),
                h('p', { style: styles.hint }, t('chooseHint')),
                h('div', { style: styles.row },
                  h('button', {
                    type: 'button',
                    style: { ...styles.button, ...styles.buttonPrimary, opacity: busy ? 0.6 : 1 },
                    disabled: busy,
                    onClick: () => void act(BOOTSTRAP_URL, { mode: 'remote' }),
                  }, t('bootstrapRemote')),
                  h('button', {
                    type: 'button',
                    style: { ...styles.button, opacity: busy ? 0.6 : 1 },
                    disabled: busy,
                    onClick: () => void act(BOOTSTRAP_URL, { mode: 'merge' }),
                  }, t('bootstrapMerge')),
                  busy ? h('span', { style: styles.hint }, t('busy')) : null,
                ),
              )
            : phase === 'await-empty-confirm'
              ? h('div', { style: styles.card },
                  h('h3', { style: styles.cardTitle }, t('emptyTitle')),
                  h('p', { style: styles.hint }, t('emptyHint')),
                  h('div', { style: styles.row },
                    h('button', {
                      type: 'button',
                      style: { ...styles.button, ...styles.buttonPrimary, opacity: busy ? 0.6 : 1 },
                      disabled: busy,
                      onClick: () => void act(CONFIRM_EMPTY_URL, {}),
                    }, t('confirmEmpty')),
                    busy ? h('span', { style: styles.hint }, t('busy')) : null,
                  ),
                )
              : null,

          // Configuration (editable, saved through the Host config editor) + sync now.
          h('div', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t('configTitle')),
            h('div', { style: styles.row },
              h('span', { style: styles.label }, t('repoLabel')),
              h('input', {
                style: styles.input,
                value: repoValue,
                placeholder: t('notConfigured'),
                spellCheck: false,
                onChange: (event) => setDraft(prev => ({
                  repo: event.target.value,
                  branch: branchValue,
                  intervalMin: intervalValue,
                  proxy: proxyValue,
                  ...(prev ?? {}),
                  repo: event.target.value,
                })),
              }),
            ),
            h('div', { style: styles.row },
              h('span', { style: styles.label }, t('proxyLabel')),
              h('input', {
                style: styles.input,
                value: proxyValue,
                placeholder: t('proxyPlaceholder'),
                spellCheck: false,
                onChange: (event) => setDraft(prev => ({
                  repo: repoValue,
                  branch: branchValue,
                  intervalMin: intervalValue,
                  ...(prev ?? {}),
                  proxy: event.target.value,
                })),
              }),
            ),
            h('div', { style: styles.row },
              h('span', { style: styles.label }, t('branchLabel')),
              h('input', {
                style: { ...styles.input, maxWidth: '160px' },
                value: branchValue,
                defaultValue: 'main',
                spellCheck: false,
                onChange: (event) => setDraft(prev => ({
                  repo: repoValue,
                  intervalMin: intervalValue,
                  proxy: proxyValue,
                  ...(prev ?? {}),
                  branch: event.target.value,
                })),
              }),
              h('span', { style: styles.label }, t('intervalLabel')),
              h('input', {
                style: { ...styles.input, maxWidth: '90px' },
                value: intervalValue,
                inputMode: 'numeric',
                onChange: (event) => setDraft(prev => ({
                  repo: repoValue,
                  branch: branchValue,
                  proxy: proxyValue,
                  ...(prev ?? {}),
                  intervalMin: event.target.value,
                })),
              }),
              h('span', { style: styles.hint }, t('minUnit')),
            ),
            h('p', { style: styles.hint }, t('configHint')),
            h('div', { style: styles.row },
              h('button', {
                type: 'button',
                style: { ...styles.button, ...styles.buttonPrimary, opacity: busy ? 0.6 : 1 },
                disabled: busy,
                onClick: () => void onSaveConfig(),
              }, busy ? t('saving') : t('save')),
              h('button', {
                type: 'button',
                style: { ...styles.button, opacity: (busy || phase === 'disabled') ? 0.6 : 1 },
                disabled: busy || phase === 'disabled' || phase === 'syncing',
                onClick: () => void act(RUN_URL, {}),
              }, phase === 'syncing' ? t('phaseSyncing') : t('runNow')),
            ),
          ),

          // Recent log.
          h('div', { style: styles.card },
            h('h3', { style: styles.cardTitle }, t('logsTitle')),
            logs.length === 0
              ? h('p', { style: styles.hint }, t('noLogs'))
              : h('div', { style: styles.logList },
                  logs.map((entry, index) => h('div', { style: styles.logRow, key: index },
                    h('span', { style: styles.logTime }, formatTime(entry.at) ?? entry.at),
                    h('span', { style: entry.level === 'warn' || entry.level === 'error' ? styles.logWarn : styles.logInfo }, entry.msg),
                  )),
                ),
          ),
        );
      };
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, 'en', DICT.en), 'plugin-sync: en');
        ctx.effect(() => ctx.locale.register(NS, 'zh', DICT.zh), 'plugin-sync: zh');

        ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
          name: 'settings.plugins.tab',
          id: 'plugin-sync',
          order: 20,
          label: () => ctx.locale.bind(NS)('tab'),
        }, makePanel(ctx)));
      },
    };
  },
});
