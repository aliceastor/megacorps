'use client';
import { ExternalLink, Plus } from 'lucide-react';
import { useLocale } from '@/lib/locale-context';
import { type CardTabKey, type WorkProduct, type WorkProductType, workProductTypes } from './card-types';

// The work products tab exactly as it rendered inside kanban-board.tsx: the
// add form followed by the list. Form state stays on the board.

export type CardWorkProductsTabProps = {
  workProducts: WorkProduct[];
  tabLoading: Record<CardTabKey, boolean>;
  busy: boolean;
  workProductType: WorkProductType | 'auto';
  setWorkProductType: (value: WorkProductType | 'auto') => void;
  workProductTitle: string;
  setWorkProductTitle: (value: string) => void;
  workProductSummary: string;
  setWorkProductSummary: (value: string) => void;
  workProductUrl: string;
  setWorkProductUrl: (value: string) => void;
  workProductRepoProvider: string;
  setWorkProductRepoProvider: (value: string) => void;
  workProductRepoUrl: string;
  setWorkProductRepoUrl: (value: string) => void;
  workProductBranch: string;
  setWorkProductBranch: (value: string) => void;
  workProductCommitSha: string;
  setWorkProductCommitSha: (value: string) => void;
  workProductPullRequestUrl: string;
  setWorkProductPullRequestUrl: (value: string) => void;
  addWorkProduct: () => void | Promise<void>;
};

export function CardWorkProductsTab({
  workProducts,
  tabLoading,
  busy,
  workProductType,
  setWorkProductType,
  workProductTitle,
  setWorkProductTitle,
  workProductSummary,
  setWorkProductSummary,
  workProductUrl,
  setWorkProductUrl,
  workProductRepoProvider,
  setWorkProductRepoProvider,
  workProductRepoUrl,
  setWorkProductRepoUrl,
  workProductBranch,
  setWorkProductBranch,
  workProductCommitSha,
  setWorkProductCommitSha,
  workProductPullRequestUrl,
  setWorkProductPullRequestUrl,
  addWorkProduct,
}: CardWorkProductsTabProps) {
  const { t } = useLocale();
  return <div style={{ display: 'grid', gap: 10 }}>
    <div className="panel-title">
      <div><h2>{t('kanban.tabWorkProducts')}</h2><span className="status-pill">{workProducts.length} {t('kanban.productsCount')}{tabLoading.workProducts ? ` / ${t('kanban.refreshing')}` : ''}</span></div>
    </div>
    <section className="section-card" style={{ padding: 0 }}>
      <div className="form-grid">
        <label className="field-label">{t('common.title')}<input className="input" maxLength={200} value={workProductTitle} onChange={(event) => setWorkProductTitle(event.target.value)} /></label>
        <label className="field-label">{t('forms.deliverableUrl')}<input className="input" value={workProductUrl} onChange={(event) => setWorkProductUrl(event.target.value)} placeholder="https://..." /></label>
      </div>
      <label className="field-label">{t('kanban.summary')}<textarea className="input" maxLength={4000} rows={3} value={workProductSummary} onChange={(event) => setWorkProductSummary(event.target.value)} /></label>
      <p className="field-hint">{t('forms.productHelp')}</p>
      <details className="form-advanced">
        <summary>{t('forms.advanced')}</summary>
        <div className="form-grid">
        <label className="field-label">{t('kanban.type')}<select className="input" value={workProductType} onChange={(event) => setWorkProductType(event.target.value as WorkProductType | 'auto')}><option value="auto">{t('forms.automatic')}</option>{workProductTypes.map((type) => <option key={type} value={type}>{type}</option>)}</select></label>
        <label className="field-label">{t('kanban.pullRequestUrl')}<input className="input" value={workProductPullRequestUrl} onChange={(event) => setWorkProductPullRequestUrl(event.target.value)} placeholder="https://github.com/org/repo/pull/1" /></label>
        <label className="field-label">{t('kanban.repoProvider')}<input className="input" value={workProductRepoProvider} onChange={(event) => setWorkProductRepoProvider(event.target.value)} placeholder="github" /></label>
        <label className="field-label">{t('kanban.repoUrl')}<input className="input" value={workProductRepoUrl} onChange={(event) => setWorkProductRepoUrl(event.target.value)} /></label>
        <label className="field-label">{t('kanban.branch')}<input className="input" value={workProductBranch} onChange={(event) => setWorkProductBranch(event.target.value)} /></label>
        <label className="field-label">Commit SHA<input className="input" value={workProductCommitSha} onChange={(event) => setWorkProductCommitSha(event.target.value)} /></label>
      </div>
      </details>
      <button className="btn btn-primary" disabled={busy || !workProductTitle.trim()} onClick={addWorkProduct}><Plus size={15} /> {t('kanban.addWorkProduct')}</button>
    </section>
    {tabLoading.workProducts && workProducts.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.loadingWorkProducts')}</p> : workProducts.length === 0 ? <p style={{ opacity: 0.6 }}>{t('kanban.noWorkProducts')}</p> : workProducts.map((product) => {
      const primaryUrl = product.pullRequestUrl || product.url || (product.repoUrl && product.commitSha ? `${product.repoUrl.replace(/\/$/, '')}/commit/${product.commitSha}` : '');
      return <article className="log-item" key={product.id}>
        <b>{product.type} / {product.title}</b>
        <span>{product.createdAt ? new Date(product.createdAt).toLocaleString() : ''}</span>
        {product.summary && <p>{product.summary}</p>}
        <div className="log-meta">
          {product.repoProvider && <span>{product.repoProvider}</span>}
          {product.branch && <span>branch {product.branch}</span>}
          {product.commitSha && <span>commit {product.commitSha.slice(0, 12)}</span>}
        </div>
        {primaryUrl && <a className="btn" href={primaryUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> {t('kanban.openProduct')}</a>}
      </article>;
    })}
  </div>;
}
