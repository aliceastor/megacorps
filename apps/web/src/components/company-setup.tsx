'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { useLocale } from '@/lib/locale-context';

type Agent = {
  id: string;
  name: string;
  slug: string;
  companyId?: string;
  departmentId?: string;
  runtimeId?: string;
  adapterType?: string;
};
type Setup = {
  company: { id: string; name: string; slug: string; mission?: string; bossRolePrompt?: string; autoDispatchEnabled?: boolean };
  status?: 'draft' | 'ready' | 'needs_attention' | 'dispatch_disabled';
  draft: { stage?: string; completed?: boolean; runtimeId?: string };
  boss: Agent | null;
  head: Agent | null;
  department: {
    id: string;
    name: string;
    slug: string;
    description?: string;
    headRolePrompt?: string;
  } | null;
  readiness?: { ready: boolean; issues: string[]; runtimeIssues: string[] };
  connectionIssues?: string[];
};
type Runtime = { id: string; companyId: string; name: string; adapterType: string; isActive?: boolean };
const steps = ['company', 'boss', 'department', 'head', 'runtime'] as const;
const initial = {
  companyName: '',
  companySlug: '',
  mission: '',
  bossName: 'Boss',
  bossSlug: 'boss',
  bossAgentId: '',
  bossPrompt: '',
  departmentName: '',
  departmentSlug: '',
  charter: '',
  headName: '',
  headSlug: '',
  headAgentId: '',
  headPrompt: '',
  runtimeId: '',
  runtimeName: '',
  runtimeUrl: '',
  runtimeCreateKey: '',
};
type Fields = typeof initial;
type CachedDraft = { fields?: Partial<Fields>; step?: number; setupKey?: string };
function reconcileAgentSelections(fields: Fields, state: Setup | null, liveAgents: Agent[]): Fields {
  if (!state) return fields;
  const liveIds = new Set(liveAgents.filter(agent => agent.companyId === state.company.id).map(agent => agent.id));
  const selection = (cachedId: string, persisted: Agent | null) =>
    liveIds.has(cachedId) ? cachedId : persisted && liveIds.has(persisted.id) ? persisted.id : '';
  return {
    ...fields,
    bossAgentId: selection(fields.bossAgentId, state.boss),
    headAgentId: selection(fields.headAgentId, state.head),
  };
}
const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

export function CompanySetup({
  initialCompanyId,
  userId,
  onSaved,
  onClose,
}: {
  initialCompanyId?: string;
  userId: string;
  onSaved: () => void;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [companyId, setCompanyId] = useState(initialCompanyId ?? '');
  const [server, setServer] = useState<Setup | null>(null);
  const [fields, setFields] = useState<Fields>(initial),
    [step, setStep] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const retrySnapshot = useRef<CachedDraft>({});
  const setupKey = useRef('');
  const heading = useRef<HTMLHeadingElement>(null);
  const storageKey = `megacorps.company-setup.${userId}.${companyId || 'new'}`;
  const runtimes = useQuery({
    queryKey: ['agent-runtimes'],
    queryFn: () => api<Runtime[]>('/api/agent-runtimes'),
  });
  const agents = useQuery({ queryKey: ['agents'], queryFn: () => api<Agent[]>('/api/agents') });
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      setReady(false);
      setLoadError('');
      setError('');
      try {
        let cached: CachedDraft = retrySnapshot.current;
        if (loadAttempt === 0) try {
          cached = JSON.parse(localStorage.getItem(storageKey) ?? '{}');
        } catch { cached = {}; }
        setupKey.current = cached.setupKey || crypto.randomUUID();
        cached = { ...cached, setupKey: setupKey.current, fields: { ...cached.fields, runtimeCreateKey: cached.fields?.runtimeCreateKey || crypto.randomUUID() } };
        retrySnapshot.current = cached;
        // Show cached input immediately, but do not persist or allow mutations until
        // both remote reads have succeeded. A failed read is not an empty agent list.
        setFields({ ...initial, ...cached.fields });
        setStep(cached.step ?? 0);
        setLoaded(true);
        const [data, liveAgents] = await Promise.all([
          companyId ? api<Setup>(`/api/companies/${companyId}/setup`) : Promise.resolve(null),
          agents.refetch({ throwOnError: true }),
        ]);
        if (cancelled) return;
        setServer(data);
        const persisted: Partial<Fields> = data
          ? {
              companyName: data.company.name,
              companySlug: data.company.slug,
              mission: data.company.mission ?? '',
              bossName: data.boss?.name ?? 'Boss',
              bossSlug: data.boss?.slug ?? 'boss',
              bossAgentId: data.boss?.id ?? '',
              bossPrompt: data.company.bossRolePrompt ?? '',
              departmentName: data.department?.name ?? '',
              departmentSlug: data.department?.slug ?? '',
              charter: data.department?.description ?? '',
              headName: data.head?.name ?? '',
              headSlug: data.head?.slug ?? '',
              headAgentId: data.head?.id ?? '',
              headPrompt: data.department?.headRolePrompt ?? '',
              runtimeId: data.draft.runtimeId ?? data.head?.runtimeId ?? '',
            }
          : {};
        setFields(reconcileAgentSelections({ ...initial, ...persisted, ...cached.fields }, data, liveAgents.data ?? []));
        setStep(cached.step ?? Math.max(0, steps.indexOf(data?.draft.stage as (typeof steps)[number])));
        setReady(true);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : t('common.error'));
        }
      }
    }
    void hydrate();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);
  useEffect(() => {
    if (ready)
      try {
        localStorage.setItem(storageKey, JSON.stringify({ fields, step, setupKey: setupKey.current }));
      } catch {}
  }, [fields, step, ready, storageKey]);
  useEffect(() => {
    if (loaded) heading.current?.focus();
  }, [step, loaded]);
  function change(key: keyof Fields, value: string, slugKey?: keyof Fields) {
    setFields((current) => ({
      ...current,
      [key]: value,
      ...(slugKey && (!current[slugKey] || current[slugKey] === slugify(current[key]))
        ? { [slugKey]: slugify(value) }
        : {}),
    }));
  }
  async function reload(id = companyId) {
    setReady(false);
    try {
      const [data, liveAgents] = await Promise.all([
        api<Setup>(`/api/companies/${id}/setup`),
        agents.refetch({ throwOnError: true }),
      ]);
      setServer(data);
      setFields(current => reconcileAgentSelections(current, data, liveAgents.data ?? []));
      await runtimes.refetch();
      setReady(true);
      return data;
    } catch (err) {
      retrySnapshot.current = { fields, step, setupKey: setupKey.current };
      setLoadError(err instanceof Error ? err.message : t('common.error'));
      throw err;
    }
  }
  async function save(advance = true) {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      let data: Setup;
      if (step === 0 && !companyId) {
        data = await api<Setup>('/api/company-setup', {
          method: 'POST',
          body: JSON.stringify({
            setupKey: setupKey.current,
            name: fields.companyName,
            slug: fields.companySlug,
            mission: fields.mission,
          }),
        });
        localStorage.removeItem(storageKey);
        setCompanyId(data.company.id);
        window.history.replaceState(null, '', `?setup=${encodeURIComponent(data.company.id)}`);
      } else {
        const payload =
          step === 0
            ? { step: 'company', name: fields.companyName, slug: fields.companySlug, mission: fields.mission }
            : step === 1
              ? {
                  step: 'boss',
                  name: fields.bossName,
                  slug: fields.bossSlug,
                  agentId: fields.bossAgentId || undefined,
                  prompt: fields.bossPrompt,
                }
              : step === 2
                ? {
                    step: 'department',
                    name: fields.departmentName,
                    slug: fields.departmentSlug,
                    description: fields.charter,
                  }
                : step === 3
                  ? {
                      step: 'head',
                      name: fields.headName,
                      slug: fields.headSlug,
                      agentId: fields.headAgentId || undefined,
                      prompt: fields.headPrompt,
                    }
                  : {
                      step: 'runtime',
                      ...(fields.runtimeId
                        ? { runtimeId: fields.runtimeId }
                        : { name: fields.runtimeName, a2aBaseUrl: fields.runtimeUrl, runtimeCreateKey: fields.runtimeCreateKey }),
                    };
        data = await api<Setup>(`/api/companies/${companyId}/setup`, {
          method: 'PUT',
          body: JSON.stringify(payload),
        });
      }
      if (data.boss) setFields((f) => ({ ...f, bossAgentId: data.boss!.id }));
      if (data.head) setFields((f) => ({ ...f, headAgentId: data.head!.id }));
      if (data.draft.runtimeId) setFields((f) => ({ ...f, runtimeId: data.draft.runtimeId! }));
      setServer(data);
      await reload(data.company.id);
      onSaved();
      if (advance) setStep(Math.min(step + 1, 4));
      setNotice(t('setup.saved'));
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }
  async function check(execute = false) {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (execute) {
        for (const agent of [server?.boss, server?.head])
          if (agent) {
            const result = await api<{ success: boolean; needsInput?: boolean }>(`/api/agents/${agent.id}/test-connection`, {
              method: 'POST',
            });
            if (!result.success) throw new Error(`${agent.name}: ${t('setup.checkFailed')}`);
            if (result.needsInput) throw new Error(`${agent.name}: ${t('setup.executionNeedsInput')}`);
          }
        setNotice(t('setup.executionResponded'));
      } else {
        const result = await api<{ results: Array<{ success: boolean; message?: string }> }>(
          `/api/companies/${companyId}/setup/probe`,
          { method: 'POST' },
        );
        if (result.results.length !== 2 || result.results.some((row) => !row.success))
          throw new Error(result.results.find((row) => !row.success)?.message ?? t('setup.checkFailed'));
        setNotice(t('setup.probeResponded'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      await reload().catch(() => {});
      setBusy(false);
    }
  }
  async function finish() {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      const data = await api<Setup>(`/api/companies/${companyId}/setup`, {
        method: 'PUT',
        body: JSON.stringify({ step: 'finish' }),
      });
      setServer(data);
      await reload();
      onSaved();
      localStorage.removeItem(storageKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally {
      setBusy(false);
    }
  }
  async function reopen() {
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api<Setup>(`/api/companies/${companyId}/setup`, { method: 'PUT', body: JSON.stringify({ step: 'reopen' }) });
      await reload();
      setStep(0);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.error'));
    } finally { setBusy(false); }
  }
  function field(key: keyof Fields, label: string, slugKey?: keyof Fields, multiline = false) {
    return (
      <label className="field-label">
        {t(label)}
        {multiline ? (
          <textarea
            className="input"
            rows={3}
            value={fields[key]}
            onChange={(e) => change(key, e.target.value)}
          />
        ) : (
          <input
            className="input"
            value={fields[key]}
            onChange={(e) => change(key, e.target.value, slugKey)}
            required
          />
        )}
      </label>
    );
  }
  const available = (runtimes.data ?? []).filter(
    (r) =>
      r.companyId === companyId &&
      r.isActive !== false &&
      (r.adapterType !== 'hermes-ssh' || [server?.boss, server?.head].every((a) => a?.runtimeId === r.id)),
  );
  const selectedRuntime = available.find((r) => r.id === fields.runtimeId);
  const configured = Boolean(
    server?.boss?.runtimeId && server.head?.runtimeId && fields.runtimeId === server.head.runtimeId,
  );
  const canFinish = configured && server?.readiness?.ready === true && server.connectionIssues?.length === 0;
  const members = (agents.data ?? []).filter((a) => a.companyId === companyId);
  if (!loaded) return <p>{t('common.loading')}</p>;
  return (
    <section className="card section-card company-setup" aria-label={t('setup.title')}>
      <div className="panel-title">
        <h2 tabIndex={-1} ref={heading}>
          {t('setup.title')}
        </h2>
        <button className="btn" onClick={onClose}>
          {t('setup.close')}
        </button>
      </div>
      {!ready && (loadError ? <div><p className="form-error" role="alert">{loadError}</p><button className="btn" onClick={() => setLoadAttempt(attempt => attempt + 1)}>{t('common.retry')}</button></div> : <p role="status">{t('common.loading')}</p>)}
      {server?.draft.completed ? (
        <>
          {ready && <p role="status">{t(server.status === 'ready' ? 'setup.complete' : server.status === 'dispatch_disabled' ? 'setup.dispatchDisabled' : 'setup.needsAttention')}</p>}
          {ready && error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn-primary" disabled={busy || !ready} onClick={() => void reopen()}>{t('setup.reopen')}</button>
          <Link className="btn" href="/kanban">
            {t('nav.kanban')}
          </Link>
        </>
      ) : (
        <>
          <p>{t('setup.intro')}</p>
          <ol className="setup-steps">
            {steps.map((key, index) => (
              <li key={key} aria-current={step === index ? 'step' : undefined}>
                <span>{index + 1}</span> {t(`setup.step.${key}`)}
              </li>
            ))}
          </ol>
          {ready && error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {notice && <p role="status">{notice}</p>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <fieldset disabled={!ready || busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
            {step === 0 && (
              <div className="form-grid">
                {field('companyName', 'setup.companyName', 'companySlug')}
                {field('companySlug', 'setup.companySlug')}
                {field('mission', 'setup.purpose', undefined, true)}
              </div>
            )}
            {step === 1 && (
              <>
                <p>{t('setup.bossHelp')}</p>
                <div className="form-grid">
                  {field('bossName', 'setup.bossName', 'bossSlug')}
                  {field('bossSlug', 'setup.bossSlug')}
                </div>
                {!server?.boss && (
                  <label className="field-label">
                    {t('setup.chooseAgent')}
                    <select
                      className="input"
                      value={fields.bossAgentId}
                      onChange={(e) => {
                        const agent = members.find((a) => a.id === e.target.value);
                        setFields((f) => ({
                          ...f,
                          bossAgentId: agent?.id ?? '',
                          bossName: agent?.name ?? f.bossName,
                          bossSlug: agent?.slug ?? f.bossSlug,
                        }));
                      }}
                    >
                      <option value="">{t('setup.newAgent')}</option>
                      {!ready && fields.bossAgentId && !members.some(a => a.id === fields.bossAgentId) && <option value={fields.bossAgentId}>{fields.bossName}</option>}
                      {members.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <details>
                  <summary>{t('setup.optionalPrompt')}</summary>
                  {field('bossPrompt', 'setup.bossPrompt', undefined, true)}
                </details>
              </>
            )}
            {step === 2 && (
              <div className="form-grid">
                {field('departmentName', 'setup.departmentName', 'departmentSlug')}
                {field('departmentSlug', 'setup.departmentSlug')}
                {field('charter', 'setup.charter', undefined, true)}
              </div>
            )}
            {step === 3 && (
              <>
                <p>{t('setup.headHelp')}</p>
                <div className="form-grid">
                  {field('headName', 'setup.headName', 'headSlug')}
                  {field('headSlug', 'setup.headSlug')}
                </div>
                {!server?.head && (
                  <label className="field-label">
                    {t('setup.chooseAgent')}
                    <select
                      className="input"
                      value={fields.headAgentId}
                      onChange={(e) => {
                        const agent = members.find((a) => a.id === e.target.value);
                        setFields((f) => ({
                          ...f,
                          headAgentId: agent?.id ?? '',
                          headName: agent?.name ?? f.headName,
                          headSlug: agent?.slug ?? f.headSlug,
                        }));
                      }}
                    >
                      <option value="">{t('setup.newAgent')}</option>
                      {!ready && fields.headAgentId && !members.some(a => a.id === fields.headAgentId) && <option value={fields.headAgentId}>{fields.headName}</option>}
                      {members
                        .filter((a) => a.id !== server?.boss?.id)
                        .map((a) => (
                          <option key={a.id} value={a.id}>
                            {a.name}
                          </option>
                        ))}
                    </select>
                  </label>
                )}
                <details>
                  <summary>{t('setup.optionalPrompt')}</summary>
                  {field('headPrompt', 'setup.headPrompt', undefined, true)}
                </details>
              </>
            )}
            {step === 4 && (
              <>
                <p>{t('setup.runtimeHelp')}</p>
                <label className="field-label">
                  {t('setup.runtime')}
                  <select
                    className="input"
                    value={fields.runtimeId}
                    onChange={(e) => setFields(f => ({ ...f, runtimeId: e.target.value, ...(!e.target.value ? { runtimeCreateKey: crypto.randomUUID(), runtimeName: '', runtimeUrl: '' } : {}) }))}
                  >
                    <option value="">{t('setup.addA2a')}</option>
                    {available.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                        {r.adapterType === 'hermes-ssh' ? ` (${t('setup.legacy')})` : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {!fields.runtimeId && (
                  <div className="form-grid">
                    {field('runtimeName', 'setup.runtimeName')}
                    {field('runtimeUrl', 'setup.a2aUrl')}
                  </div>
                )}
                <p>
                  <Link href={`/settings?setup=${encodeURIComponent(companyId)}${fields.runtimeId ? `&runtime=${encodeURIComponent(fields.runtimeId)}` : ''}`}>{t('setup.otherRuntime')}</Link>
                </p>
                <button type="submit" className="btn" disabled={busy}>
                  {t('setup.saveRuntime')}
                </button>
                <p>{configured ? t('setup.configured') : t('setup.unconfigured')}</p>
                {server?.readiness &&
                  [...server.readiness.issues, ...server.readiness.runtimeIssues].map((issue) => (
                    <p key={issue}>{issue}</p>
                  ))}
                {server?.connectionIssues?.map((issue) => (
                  <p key={issue}>{issue}</p>
                ))}
                <div className="action-row">
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !configured || selectedRuntime?.adapterType !== 'a2a'}
                    onClick={() => void check()}
                  >
                    {t('setup.probe')}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={busy || !configured}
                    onClick={() => void check(true)}
                  >
                    {t('setup.executeTest')}
                  </button>
                </div>
                <p className="field-hint">{t('setup.billingHelp')}</p>
                <p className="field-hint">{t('setup.repositoryHelp')}</p>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !canFinish}
                  onClick={() => void finish()}
                >
                  {t('setup.finish')}
                </button>
              </>
            )}
            <div className="action-row setup-actions">
              {step > 0 && (
                <button
                  type="button"
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setStep(step - 1);
                  }}
                >
                  {t('setup.back')}
                </button>
              )}
              {step < 4 && (
                <>
                  <button type="button" className="btn" disabled={busy} onClick={() => void save(false)}>
                    {t('setup.saveDraft')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={busy}>
                    {t('setup.next')}
                  </button>
                </>
              )}
            </div>
            </fieldset>
          </form>
        </>
      )}
    </section>
  );
}
