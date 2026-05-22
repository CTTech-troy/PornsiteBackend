import React, { useState, useEffect, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MegaphoneIcon, PlusIcon, PlayIcon, PauseIcon, TrashIcon,
  RefreshCwIcon, XIcon, ExternalLinkIcon, ImageIcon, UploadIcon,
  CheckCircleIcon, AlertCircleIcon,
} from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
import { StatusBadge, type StatusColor } from '../components/shared/StatusBadge';
import { Modal } from '../components/shared/Modal';
import {
  fetchAdCampaigns, createAdCampaign, updateAdCampaign, deleteAdCampaign,
  uploadAdImage,
  type AdCampaign, type AdPlacement,
} from '../api/financeApi';
import { useToast } from '../contexts/ToastContext';

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtUsd(n: number) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0 }).format(n);
}
function fmtNum(n: number) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

const PLACEMENTS: { value: AdPlacement; label: string; desc: string }[] = [
  { value: 'homepage_banner',  label: 'Homepage Banner',  desc: 'Full-width top of the homepage' },
  { value: 'sidebar',          label: 'Sidebar',          desc: 'Right sidebar on desktop' },
  { value: 'video_player',     label: 'Video Player',     desc: 'Pre-roll or overlay on videos' },
  { value: 'creator_profile',  label: 'Creator Profile',  desc: 'Displayed on creator profile pages' },
  { value: 'feed',             label: 'Content Feed',     desc: 'Inline with video feed cards' },
];

const STATUS_COLOR: Record<string, StatusColor> = { active: 'green', paused: 'yellow', ended: 'gray' };

// ── Types ─────────────────────────────────────────────────────────────────────

interface AdForm {
  name: string;
  description: string;
  redirect_url: string;
  cta_text: string;
  placement: AdPlacement;
  budget_usd: string;
  cpc: string;
  start_date: string;
  end_date: string;
}

const emptyForm: AdForm = {
  name: '', description: '', redirect_url: '', cta_text: 'Learn More',
  placement: 'homepage_banner', budget_usd: '', cpc: '', start_date: '', end_date: '',
};

// ── ImageDropZone ─────────────────────────────────────────────────────────────

function ImageDropZone({
  imageUrl, uploading, onFile,
}: {
  imageUrl: string; uploading: boolean; onFile: (f: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) onFile(file);
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
      className={`relative rounded-lg border-2 border-dashed cursor-pointer transition-colors overflow-hidden
        ${dragging ? 'border-accent bg-accent/5' : 'border-border-strong hover:border-border-hover'}
        ${imageUrl ? 'h-36' : 'h-28 flex items-center justify-center'}
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }}
      />

      {imageUrl ? (
        <>
          <img src={imageUrl} alt="Ad preview" className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-black/40 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-center gap-2 text-white text-[13px]">
            <UploadIcon className="w-4 h-4" />
            Change image
          </div>
        </>
      ) : (
        <div className="flex flex-col items-center gap-2 text-text-tertiary px-4 text-center">
          {uploading
            ? <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            : <ImageIcon className="w-7 h-7" />
          }
          <span className="text-[12px]">
            {uploading ? 'Uploading…' : 'Drop image or click to browse (max 5 MB)'}
          </span>
        </div>
      )}
    </div>
  );
}

// ── AdCard ─────────────────────────────────────────────────────────────────────

function AdCard({
  ad, onToggle, onDelete, onEdit,
}: {
  ad: AdCampaign;
  onToggle: (ad: AdCampaign) => void;
  onDelete: (ad: AdCampaign) => void;
  onEdit:   (ad: AdCampaign) => void;
}) {
  const placement = PLACEMENTS.find(p => p.value === ad.placement);
  return (
    <div className="card p-4 flex flex-col sm:flex-row gap-4">
      {/* Thumbnail */}
      <div className="w-full sm:w-24 h-20 sm:h-16 rounded-lg overflow-hidden shrink-0 bg-bg-elevated flex items-center justify-center border border-border-default">
        {ad.image_url
          ? <img src={ad.image_url} alt={ad.name} className="w-full h-full object-cover" />
          : <MegaphoneIcon className="w-6 h-6 text-text-tertiary" />
        }
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap items-center gap-2 mb-1">
          <h3 className="font-semibold text-[14px] text-text-primary truncate">{ad.name}</h3>
          <StatusBadge status={ad.status} color={STATUS_COLOR[ad.status] || 'gray'} />
          {placement && (
            <span className="text-[11px] px-2 py-0.5 rounded-full bg-bg-elevated text-text-tertiary border border-border-default">
              {placement.label}
            </span>
          )}
        </div>

        {ad.description && (
          <p className="text-[12px] text-text-tertiary mb-1.5 line-clamp-1">{ad.description}</p>
        )}

        <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-text-tertiary">
          <span>Budget: <span className="text-text-secondary font-medium">{fmtUsd(ad.budget_usd)}</span></span>
          <span>Impressions: <span className="text-text-secondary font-medium">{fmtNum(ad.impressions)}</span></span>
          <span>Clicks: <span className="text-text-secondary font-medium">{fmtNum(ad.clicks)}</span></span>
          <span>Revenue: <span className="text-text-secondary font-medium">{fmtUsd(ad.revenue_usd)}</span></span>
          {ad.redirect_url && (
            <a
              href={ad.redirect_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="flex items-center gap-1 text-accent hover:underline"
            >
              <ExternalLinkIcon className="w-3 h-3" /> Link
            </a>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={() => onEdit(ad)}
          className="text-[12px] px-2.5 py-1 rounded-md border border-border-default text-text-secondary hover:text-text-primary hover:bg-bg-elevated transition-colors"
        >
          Edit
        </button>
        <ActionButton
          variant="secondary"
          size="sm"
          icon={ad.status === 'active' ? PauseIcon : PlayIcon}
          onClick={() => onToggle(ad)}
        >
          {ad.status === 'active' ? 'Pause' : 'Resume'}
        </ActionButton>
        <ActionButton
          variant="danger"
          size="sm"
          icon={TrashIcon}
          onClick={() => onDelete(ad)}
        />
      </div>
    </div>
  );
}

// ── AdFormModal ──────────────────────────────────────────────────────────────

function AdFormModal({
  isOpen, onClose, onSave, initial, loading,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSave: (form: AdForm, imageUrl: string, w: number, h: number) => Promise<void>;
  initial?: AdCampaign | null;
  loading: boolean;
}) {
  const [form, setForm] = useState<AdForm>(emptyForm);
  const [imageUrl, setImageUrl] = useState('');
  const [imgW, setImgW] = useState(0);
  const [imgH, setImgH] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [urlError, setUrlError] = useState('');
  const { error: toastError } = useToast();

  useEffect(() => {
    if (!isOpen) return;
    if (initial) {
      setForm({
        name:        initial.name        ?? '',
        description: initial.description ?? '',
        redirect_url: initial.redirect_url ?? '',
        cta_text:    initial.cta_text    ?? 'Learn More',
        placement:   (initial.placement  ?? 'homepage_banner') as AdPlacement,
        budget_usd:  String(initial.budget_usd ?? ''),
        cpc:         String(initial.cpc        ?? ''),
        start_date:  initial.start_date  ? initial.start_date.slice(0, 10)  : '',
        end_date:    initial.end_date    ? initial.end_date.slice(0, 10)    : '',
      });
      setImageUrl(initial.image_url ?? '');
      setImgW(initial.image_width  ?? 0);
      setImgH(initial.image_height ?? 0);
    } else {
      setForm(emptyForm);
      setImageUrl('');
      setImgW(0);
      setImgH(0);
    }
    setUrlError('');
  }, [isOpen, initial]);

  const handleImageFile = async (file: File) => {
    setUploading(true);
    try {
      const result = await uploadAdImage(file);
      setImageUrl(result.url);
      setImgW(result.width);
      setImgH(result.height);
    } catch (e: any) {
      toastError(e.message || 'Image upload failed');
    } finally {
      setUploading(false);
    }
  };

  const validateUrl = (url: string) => {
    if (!url) return '';
    return /^https?:\/\/.+/i.test(url) ? '' : 'Must be a valid https://… URL';
  };

  const handleSubmit = async () => {
    const err = validateUrl(form.redirect_url);
    if (err) { setUrlError(err); return; }
    await onSave(form, imageUrl, imgW, imgH);
  };

  const f = (key: keyof AdForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
    setForm(prev => ({ ...prev, [key]: e.target.value }));

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={initial ? 'Edit Ad' : 'Create New Ad'}
      footer={
        <div className="flex gap-2 justify-end">
          <ActionButton variant="ghost" onClick={onClose} disabled={loading}>Cancel</ActionButton>
          <ActionButton variant="primary" onClick={handleSubmit} isLoading={loading}>
            {initial ? 'Save Changes' : 'Create Ad'}
          </ActionButton>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Image */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1.5">Ad Image</label>
          <ImageDropZone imageUrl={imageUrl} uploading={uploading} onFile={handleImageFile} />
          {imgW > 0 && (
            <p className="text-[11px] text-text-tertiary mt-1">{imgW} × {imgH} px</p>
          )}
        </div>

        {/* Name */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">Ad Title <span className="text-danger">*</span></label>
          <input type="text" className="input-field" placeholder="Summer promo 2025" value={form.name} onChange={f('name')} />
        </div>

        {/* Description */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">Description</label>
          <textarea className="input-field" rows={2} placeholder="Short description…" value={form.description} onChange={f('description')} />
        </div>

        {/* Redirect URL */}
        <div>
          <label className="block text-[13px] font-medium text-text-secondary mb-1">Redirect URL</label>
          <input
            type="url"
            className={`input-field ${urlError ? 'border-danger focus:border-danger focus:ring-danger/20' : ''}`}
            placeholder="https://example.com/landing"
            value={form.redirect_url}
            onChange={(e) => { setUrlError(validateUrl(e.target.value)); f('redirect_url')(e); }}
          />
          {urlError && <p className="text-[11px] text-danger mt-1">{urlError}</p>}
        </div>

        {/* CTA + Placement row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">CTA Button Text</label>
            <input type="text" className="input-field" placeholder="Learn More" value={form.cta_text} onChange={f('cta_text')} />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Placement</label>
            <select className="input-field" value={form.placement} onChange={f('placement')}>
              {PLACEMENTS.map(p => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Budget + CPC row */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Budget (USD)</label>
            <input type="number" min="0" step="1" className="input-field" placeholder="5000" value={form.budget_usd} onChange={f('budget_usd')} />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">CPC (USD)</label>
            <input type="number" min="0" step="0.0001" className="input-field" placeholder="0.12" value={form.cpc} onChange={f('cpc')} />
          </div>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Start Date</label>
            <input type="date" className="input-field" value={form.start_date} onChange={f('start_date')} />
          </div>
          <div>
            <label className="block text-[13px] font-medium text-text-secondary mb-1">Expiry Date</label>
            <input type="date" className="input-field" value={form.end_date} onChange={f('end_date')} />
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ── Main Component ─────────────────────────────────────────────────────────────

export function AdsManagement() {
  const [campaigns, setCampaigns] = useState<AdCampaign[]>([]);
  const [adStats, setAdStats] = useState({ activeCampaigns: 0, totalImpressions: 0, adRevenue: 0 });
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState('');

  const [formOpen, setFormOpen]     = useState(false);
  const [editTarget, setEditTarget] = useState<AdCampaign | null>(null);
  const [formLoading, setFormLoading] = useState(false);

  const [deleteTarget,  setDeleteTarget]  = useState<AdCampaign | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const { success, error: toastError } = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { campaigns: c, stats } = await fetchAdCampaigns();
      setCampaigns(c ?? []);
      setAdStats(stats);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleToggle = async (ad: AdCampaign) => {
    try {
      const newStatus = ad.status === 'active' ? 'paused' : 'active';
      await updateAdCampaign(ad.id, { status: newStatus, is_active: newStatus === 'active' });
      success(`Ad ${newStatus === 'active' ? 'resumed' : 'paused'}.`);
      load();
    } catch (e: any) { toastError(e.message); }
  };

  const handleSave = async (form: AdForm, imageUrl: string, imgW: number, imgH: number) => {
    setFormLoading(true);
    try {
      const payload = {
        name:         form.name.trim(),
        description:  form.description || undefined,
        redirect_url: form.redirect_url || undefined,
        cta_text:     form.cta_text     || 'Learn More',
        placement:    form.placement,
        budget_usd:   form.budget_usd ? parseFloat(form.budget_usd) : 0,
        cpc:          form.cpc         ? parseFloat(form.cpc)        : 0,
        start_date:   form.start_date  || undefined,
        end_date:     form.end_date    || undefined,
        image_url:    imageUrl         || undefined,
        image_width:  imgW             || undefined,
        image_height: imgH             || undefined,
      };

      if (editTarget) {
        await updateAdCampaign(editTarget.id, payload);
        success('Ad updated.');
      } else {
        await createAdCampaign(payload as any);
        success('Ad created.');
      }

      setFormOpen(false);
      setEditTarget(null);
      load();
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setFormLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await deleteAdCampaign(deleteTarget.id);
      success('Ad deleted.');
      setDeleteTarget(null);
      load();
    } catch (e: any) {
      toastError(e.message);
    } finally {
      setDeleteLoading(false);
    }
  };

  const openCreate = () => { setEditTarget(null); setFormOpen(true); };
  const openEdit   = (ad: AdCampaign) => { setEditTarget(ad); setFormOpen(true); };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="space-y-6">

      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Ads Management</h1>
          <p className="text-[13px] text-text-tertiary mt-0.5">Create and manage platform advertisements</p>
        </div>
        <div className="flex gap-2">
          <ActionButton variant="secondary" icon={RefreshCwIcon} onClick={load} isLoading={loading} size="sm">
            Refresh
          </ActionButton>
          <ActionButton variant="primary" icon={PlusIcon} onClick={openCreate} size="sm">
            Create Ad
          </ActionButton>
        </div>
      </div>

      {/* Error banner */}
      <AnimatePresence>
        {error && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
            className="flex items-center justify-between px-4 py-3 rounded-lg bg-danger/10 border border-danger/20 text-danger text-[13px]">
            <span className="flex items-center gap-2"><AlertCircleIcon className="w-4 h-4 shrink-0" />{error}</span>
            <button onClick={() => setError('')}><XIcon className="w-4 h-4" /></button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stats row */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          { label: 'Active Campaigns', value: loading ? null : adStats.activeCampaigns },
          { label: 'Total Impressions', value: loading ? null : fmtNum(adStats.totalImpressions) },
          { label: 'Ad Revenue',       value: loading ? null : fmtUsd(adStats.adRevenue) },
        ].map(({ label, value }) => (
          <div key={label} className="card p-5">
            <p className="text-[12px] font-medium text-text-tertiary uppercase tracking-wider mb-2">{label}</p>
            {value === null
              ? <div className="h-7 w-20 bg-bg-elevated rounded-md animate-pulse" />
              : <p className="text-2xl font-bold text-text-primary tabular-nums">{value}</p>
            }
          </div>
        ))}
      </div>

      {/* Campaign list */}
      <div>
        <h2 className="text-[14px] font-semibold text-text-primary mb-3">
          All Ads <span className="ml-1.5 text-text-tertiary font-normal">({campaigns.length})</span>
        </h2>

        {loading ? (
          <div className="space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="card p-4 h-24 animate-pulse bg-bg-elevated" />
            ))}
          </div>
        ) : campaigns.length === 0 ? (
          <div className="card p-12 flex flex-col items-center text-center text-text-tertiary gap-3">
            <MegaphoneIcon className="w-10 h-10 opacity-30" />
            <p className="text-[14px]">No ads yet. Create your first ad campaign.</p>
            <ActionButton variant="primary" icon={PlusIcon} size="sm" onClick={openCreate}>
              Create Ad
            </ActionButton>
          </div>
        ) : (
          <div className="space-y-3">
            {campaigns.map(ad => (
              <AdCard key={ad.id} ad={ad} onToggle={handleToggle} onDelete={setDeleteTarget} onEdit={openEdit} />
            ))}
          </div>
        )}
      </div>

      {/* Create / Edit Modal */}
      <AdFormModal
        isOpen={formOpen}
        onClose={() => { setFormOpen(false); setEditTarget(null); }}
        onSave={handleSave}
        initial={editTarget}
        loading={formLoading}
      />

      {/* Delete Confirmation Modal */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Ad"
        footer={
          <div className="flex gap-2 justify-end">
            <ActionButton variant="ghost" onClick={() => setDeleteTarget(null)} disabled={deleteLoading}>Cancel</ActionButton>
            <ActionButton variant="danger" onClick={handleDelete} isLoading={deleteLoading}>Delete</ActionButton>
          </div>
        }
      >
        <div className="flex items-start gap-3">
          <AlertCircleIcon className="w-5 h-5 text-danger shrink-0 mt-0.5" />
          <p className="text-[14px] text-text-secondary">
            Delete <strong className="text-text-primary">"{deleteTarget?.name}"</strong>? This cannot be undone.
          </p>
        </div>
      </Modal>
    </motion.div>
  );
}
