import React, { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  PlusIcon, TrashIcon, PencilIcon, RefreshCwIcon,
  CheckIcon, ImageIcon, XIcon, ToggleLeftIcon, ToggleRightIcon,
  LayersIcon, CheckCircleIcon, XCircleIcon,
} from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
import { StatsCard } from '../components/shared/StatsCard';
import { Modal } from '../components/shared/Modal';
import {
  fetchMembershipPlans,
  createMembershipPlan,
  updateMembershipPlan,
  toggleMembershipPlan,
  deleteMembershipPlan,
  uploadPlanImage,
  type MembershipPlan,
  type CreatePlanPayload,
} from '../api/membershipsApi';

// ─── helpers ─────────────────────────────────────────────────────────────────

const CURRENCY_OPTIONS = ['USD', 'NGN', 'EUR', 'GBP'];

function formatPrice(plan: MembershipPlan) {
  if (!plan.price) return 'Free';
  const sym = { USD: '$', NGN: '₦', EUR: '€', GBP: '£' }[plan.currency] ?? '';
  const n = Number(plan.price);
  return `${sym}${n % 1 === 0 ? n.toLocaleString() : n.toFixed(2)}`;
}

const GRADIENT_COLORS = [
  'from-red-500 to-orange-400',
  'from-purple-600 to-purple-400',
  'from-amber-500 to-orange-400',
  'from-emerald-600 to-teal-400',
  'from-sky-600 to-blue-400',
  'from-pink-600 to-rose-400',
];
function cardGradient(i: number) { return GRADIENT_COLORS[i % GRADIENT_COLORS.length]; }

// ─── blank form ───────────────────────────────────────────────────────────────

interface PlanForm {
  title: string;
  description: string;
  price: string;
  currency: string;
  duration: string;
  durationType: string;
  durationValue: string;
  featuresRaw: string;  // newline-separated, edited as textarea
  badge: string;
  permissionsRaw: string;
  limitsRaw: string;
  creatorBenefitsRaw: string;
  aiAccessRaw: string;
  visibilityPriority: string;
  coinBonus: string;
  isRecurring: boolean;
  image: string;
  isActive: boolean;
  sortOrder: string;
}

const BLANK_FORM: PlanForm = {
  title: '',
  description: '',
  price: '',
  currency: 'USD',
  duration: '30 Days',
  durationType: 'days',
  durationValue: '30',
  featuresRaw: '',
  badge: '',
  permissionsRaw: '{}',
  limitsRaw: '{}',
  creatorBenefitsRaw: '{}',
  aiAccessRaw: '{}',
  visibilityPriority: '0',
  coinBonus: '0',
  isRecurring: false,
  image: '',
  isActive: true,
  sortOrder: '0',
};

function planToForm(plan: MembershipPlan): PlanForm {
  return {
    title: plan.title,
    description: plan.description,
    price: String(plan.price),
    currency: plan.currency,
    duration: plan.duration,
    durationType: plan.durationType || 'days',
    durationValue: String(plan.durationValue || 30),
    featuresRaw: plan.features.join('\n'),
    badge: plan.badge || '',
    permissionsRaw: JSON.stringify(plan.permissions || {}, null, 2),
    limitsRaw: JSON.stringify(plan.limits || {}, null, 2),
    creatorBenefitsRaw: JSON.stringify(plan.creatorBenefits || {}, null, 2),
    aiAccessRaw: JSON.stringify(plan.aiAccess || {}, null, 2),
    visibilityPriority: String(plan.visibilityPriority || 0),
    coinBonus: String(plan.coinBonus || 0),
    isRecurring: plan.isRecurring === true,
    image: plan.image || '',
    isActive: plan.isActive,
    sortOrder: String(plan.sortOrder),
  };
}

function formToPayload(form: PlanForm): CreatePlanPayload {
  const parseJson = (raw: string) => {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  };
  return {
    title: form.title.trim(),
    description: form.description.trim(),
    price: parseFloat(form.price) || 0,
    currency: form.currency,
    duration: form.duration.trim() || '30 Days',
    durationType: form.durationType,
    durationValue: parseInt(form.durationValue, 10) || 30,
    features: form.featuresRaw.split('\n').map((f) => f.trim()).filter(Boolean),
    badge: form.badge.trim() || null,
    permissions: parseJson(form.permissionsRaw),
    limits: parseJson(form.limitsRaw),
    creatorBenefits: parseJson(form.creatorBenefitsRaw),
    aiAccess: parseJson(form.aiAccessRaw),
    visibilityPriority: parseInt(form.visibilityPriority, 10) || 0,
    coinBonus: parseFloat(form.coinBonus) || 0,
    isRecurring: form.isRecurring,
    image: form.image.trim() || null,
    isActive: form.isActive,
    sortOrder: parseInt(form.sortOrder, 10) || 0,
  };
}

// ─── Feature input with tag UI ────────────────────────────────────────────────

function FeaturesInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const tags = value.split('\n').map((f) => f.trim()).filter(Boolean);
  const [inputVal, setInputVal] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const addTag = () => {
    const t = inputVal.trim();
    if (!t) return;
    const next = [...tags, t].join('\n');
    onChange(next);
    setInputVal('');
    inputRef.current?.focus();
  };

  const removeTag = (i: number) => {
    const next = tags.filter((_, idx) => idx !== i).join('\n');
    onChange(next);
  };

  return (
    <div>
      <div className="flex flex-wrap gap-1.5 min-h-[36px] p-2 rounded-lg border border-border-default bg-bg-secondary focus-within:border-accent transition-colors mb-2">
        {tags.map((tag, i) => (
          <span key={i} className="flex items-center gap-1 bg-accent/15 text-accent text-[11px] font-medium px-2 py-0.5 rounded-full">
            {tag}
            <button type="button" onClick={() => removeTag(i)} className="text-accent/70 hover:text-accent ml-0.5">
              <XIcon className="w-3 h-3" />
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          className="input-field flex-1 text-[12px]"
          placeholder="Type a feature and press Enter or Add…"
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
        />
        <button
          type="button"
          onClick={addTag}
          className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-accent text-white hover:bg-accent-hover transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ─── Plan form modal body ─────────────────────────────────────────────────────

function PlanFormBody({
  form,
  onChange,
  formError,
  uploading,
  onUploadImage,
}: {
  form: PlanForm;
  onChange: (patch: Partial<PlanForm>) => void;
  formError: string;
  uploading: boolean;
  onUploadImage: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="space-y-4">
      {formError && (
        <div className="bg-danger/10 border border-danger/20 rounded-lg p-3 text-danger text-[12px]">
          {formError}
        </div>
      )}

      {/* Title */}
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
          Plan Title <span className="text-danger">*</span>
        </label>
        <input
          type="text"
          className="input-field"
          placeholder="e.g. Gold Membership"
          value={form.title}
          onChange={(e) => onChange({ title: e.target.value })}
        />
      </div>

      {/* Description */}
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Description</label>
        <textarea
          className="input-field resize-none"
          rows={2}
          placeholder="Describe what's included…"
          value={form.description}
          onChange={(e) => onChange({ description: e.target.value })}
        />
      </div>

      {/* Price + currency */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
            Price <span className="text-danger">*</span>
          </label>
          <input
            type="number"
            min="0"
            step="0.01"
            className="input-field"
            placeholder="5000"
            value={form.price}
            onChange={(e) => onChange({ price: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Currency</label>
          <select
            className="input-field"
            value={form.currency}
            onChange={(e) => onChange({ currency: e.target.value })}
          >
            {CURRENCY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* Duration + sort order */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Duration</label>
          <input
            type="text"
            className="input-field"
            placeholder="30 Days / Monthly / Yearly"
            value={form.duration}
            onChange={(e) => onChange({ duration: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Sort Order</label>
          <input
            type="number"
            min="0"
            step="1"
            className="input-field"
            placeholder="0"
            value={form.sortOrder}
            onChange={(e) => onChange({ sortOrder: e.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Duration Type</label>
          <select
            className="input-field"
            value={form.durationType}
            onChange={(e) => onChange({ durationType: e.target.value })}
          >
            <option value="days">Days</option>
            <option value="weeks">Weeks</option>
            <option value="months">Months</option>
            <option value="years">Years</option>
          </select>
        </div>
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Duration Value</label>
          <input
            type="number"
            min="1"
            step="1"
            className="input-field"
            value={form.durationValue}
            onChange={(e) => onChange({ durationValue: e.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Badge</label>
          <input
            type="text"
            className="input-field"
            placeholder="Creator Pro"
            value={form.badge}
            onChange={(e) => onChange({ badge: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Coin Bonus</label>
          <input
            type="number"
            min="0"
            step="1"
            className="input-field"
            value={form.coinBonus}
            onChange={(e) => onChange({ coinBonus: e.target.value })}
          />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Visibility Priority</label>
          <input
            type="number"
            min="0"
            step="1"
            className="input-field"
            value={form.visibilityPriority}
            onChange={(e) => onChange({ visibilityPriority: e.target.value })}
          />
        </div>
        <div className="flex items-center justify-between bg-bg-secondary rounded-lg px-3 py-2.5">
          <div>
            <p className="text-[13px] font-medium text-text-primary">Recurring</p>
            <p className="text-[11px] text-text-tertiary">Lifecycle-ready renewal flow.</p>
          </div>
          <button
            type="button"
            onClick={() => onChange({ isRecurring: !form.isRecurring })}
            className={`w-11 h-6 rounded-full flex items-center p-1 transition-colors ${form.isRecurring ? 'bg-accent justify-end' : 'bg-border-strong justify-start'}`}
          >
            <div className="w-4 h-4 bg-white rounded-full shadow" />
          </button>
        </div>
      </div>

      {/* Features */}
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Features / Benefits</label>
        <FeaturesInput value={form.featuresRaw} onChange={(v) => onChange({ featuresRaw: v })} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {[
          ['Permissions JSON', 'permissionsRaw'],
          ['Limits JSON', 'limitsRaw'],
          ['Creator Benefits JSON', 'creatorBenefitsRaw'],
          ['AI Access JSON', 'aiAccessRaw'],
        ].map(([label, key]) => (
          <div key={key}>
            <label className="block text-[12px] font-medium text-text-secondary mb-1.5">{label}</label>
            <textarea
              className="input-field font-mono text-[11px] resize-none"
              rows={4}
              value={(form as any)[key]}
              onChange={(e) => onChange({ [key]: e.target.value } as Partial<PlanForm>)}
            />
          </div>
        ))}
      </div>

      {/* Image */}
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Plan Image</label>
        <div className="flex gap-2 items-start">
          <input
            type="text"
            className="input-field flex-1 text-[12px]"
            placeholder="Paste image URL or upload below"
            value={form.image}
            onChange={(e) => onChange({ image: e.target.value })}
          />
          <button
            type="button"
            disabled={uploading}
            onClick={() => fileRef.current?.click()}
            className="shrink-0 px-3 py-2 rounded-lg border border-border-default text-[12px] text-text-secondary hover:border-accent hover:text-accent transition-colors flex items-center gap-1.5 disabled:opacity-50"
          >
            <ImageIcon className="w-4 h-4" />
            {uploading ? 'Uploading…' : 'Upload'}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUploadImage(f);
              e.target.value = '';
            }}
          />
        </div>
        {form.image && (
          <img src={form.image} alt="Preview" className="mt-2 h-20 w-auto rounded-lg object-cover border border-border-subtle" />
        )}
      </div>

      {/* Active toggle */}
      <div className="flex items-center justify-between bg-bg-secondary rounded-lg px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium text-text-primary">Active</p>
          <p className="text-[11px] text-text-tertiary">Active plans are visible on the membership page.</p>
        </div>
        <button
          type="button"
          onClick={() => onChange({ isActive: !form.isActive })}
          className={`w-11 h-6 rounded-full flex items-center p-1 transition-colors ${form.isActive ? 'bg-accent justify-end' : 'bg-border-strong justify-start'}`}
        >
          <div className="w-4 h-4 bg-white rounded-full shadow" />
        </button>
      </div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function MembershipPlans() {
  const [plans, setPlans] = useState<MembershipPlan[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, disabled: 0 });
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState<PlanForm>(BLANK_FORM);
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [createUploading, setCreateUploading] = useState(false);

  // Edit modal
  const [editTarget, setEditTarget] = useState<MembershipPlan | null>(null);
  const [editForm, setEditForm] = useState<PlanForm>(BLANK_FORM);
  const [editLoading, setEditLoading] = useState(false);
  const [editError, setEditError] = useState('');
  const [editUploading, setEditUploading] = useState(false);

  // Delete modal
  const [deleteTarget, setDeleteTarget] = useState<MembershipPlan | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Toggle loading set (per plan id)
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set());

  const loadPlans = useCallback(async () => {
    setLoading(true);
    setPageError('');
    try {
      const res = await fetchMembershipPlans();
      setPlans(res.data ?? []);
      setStats(res.stats ?? { total: 0, active: 0, disabled: 0 });
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPlans(); }, [loadPlans]);

  // ── Toggle (optimistic) ───────────────────────────────────────────────────
  const handleToggle = async (plan: MembershipPlan) => {
    const next = !plan.isActive;
    // Optimistically update local state immediately
    setPlans((prev) => prev.map((p) => p.id === plan.id ? { ...p, isActive: next } : p));
    setStats((prev) => ({
      ...prev,
      active: prev.active + (next ? 1 : -1),
      disabled: prev.disabled + (next ? -1 : 1),
    }));
    setTogglingIds((s) => new Set(s).add(plan.id));
    try {
      await toggleMembershipPlan(plan.id, next);
    } catch (err) {
      // Revert on failure
      setPlans((prev) => prev.map((p) => p.id === plan.id ? { ...p, isActive: !next } : p));
      setStats((prev) => ({
        ...prev,
        active: prev.active + (next ? -1 : 1),
        disabled: prev.disabled + (next ? 1 : -1),
      }));
      setPageError((err as Error).message);
    } finally {
      setTogglingIds((s) => { const ns = new Set(s); ns.delete(plan.id); return ns; });
    }
  };

  // ── Create ────────────────────────────────────────────────────────────────
  const openCreate = () => { setCreateForm(BLANK_FORM); setCreateError(''); setCreateOpen(true); };

  const handleCreate = async () => {
    if (!createForm.title.trim()) { setCreateError('Title is required.'); return; }
    if (!createForm.price) { setCreateError('Price is required.'); return; }
    setCreateLoading(true);
    setCreateError('');
    try {
      const res = await createMembershipPlan(formToPayload(createForm));
      // Add to state optimistically
      setPlans((prev) => [...prev, res.data].sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt));
      setStats((prev) => ({ ...prev, total: prev.total + 1, active: prev.active + (res.data.isActive ? 1 : 0), disabled: prev.disabled + (res.data.isActive ? 0 : 1) }));
      setCreateOpen(false);
    } catch (err) {
      setCreateError((err as Error).message);
    } finally {
      setCreateLoading(false);
    }
  };

  const handleCreateImageUpload = async (file: File) => {
    setCreateUploading(true);
    try {
      const { url } = await uploadPlanImage(file);
      setCreateForm((f) => ({ ...f, image: url }));
    } catch (err) {
      setCreateError('Image upload failed: ' + (err as Error).message);
    } finally {
      setCreateUploading(false);
    }
  };

  // ── Edit ──────────────────────────────────────────────────────────────────
  const openEdit = (plan: MembershipPlan) => {
    setEditTarget(plan);
    setEditForm(planToForm(plan));
    setEditError('');
  };

  const handleEdit = async () => {
    if (!editTarget) return;
    if (!editForm.title.trim()) { setEditError('Title is required.'); return; }
    if (!editForm.price) { setEditError('Price is required.'); return; }
    setEditLoading(true);
    setEditError('');
    try {
      const res = await updateMembershipPlan(editTarget.id, formToPayload(editForm));
      setPlans((prev) => prev.map((p) => p.id === editTarget.id ? res.data : p).sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt));
      setEditTarget(null);
    } catch (err) {
      setEditError((err as Error).message);
    } finally {
      setEditLoading(false);
    }
  };

  const handleEditImageUpload = async (file: File) => {
    setEditUploading(true);
    try {
      const { url } = await uploadPlanImage(file);
      setEditForm((f) => ({ ...f, image: url }));
    } catch (err) {
      setEditError('Image upload failed: ' + (err as Error).message);
    } finally {
      setEditUploading(false);
    }
  };

  // ── Delete ────────────────────────────────────────────────────────────────
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await deleteMembershipPlan(deleteTarget.id);
      // Optimistically remove from state
      const removed = plans.find((p) => p.id === deleteTarget.id);
      setPlans((prev) => prev.filter((p) => p.id !== deleteTarget.id));
      if (removed) {
        setStats((prev) => ({
          total: prev.total - 1,
          active: prev.active - (removed.isActive ? 1 : 0),
          disabled: prev.disabled - (removed.isActive ? 0 : 1),
        }));
      }
      setDeleteTarget(null);
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Membership Plans</h1>
          <p className="text-[13px] text-text-tertiary mt-0.5">
            Create, edit and toggle plans. Active plans appear on the frontend instantly.
          </p>
        </div>
        <div className="flex gap-2">
          <ActionButton variant="ghost" icon={RefreshCwIcon} onClick={loadPlans}>Refresh</ActionButton>
          <ActionButton variant="primary" icon={PlusIcon} onClick={openCreate}>Create Plan</ActionButton>
        </div>
      </div>

      {pageError && (
        <div className="bg-danger/10 border border-danger/20 rounded-lg p-4 text-danger text-[13px]">
          {pageError}
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatsCard title="Total Plans" value={loading ? '…' : String(stats.total)} icon={LayersIcon} />
        <StatsCard title="Active Plans" value={loading ? '…' : String(stats.active)} icon={CheckCircleIcon} />
        <StatsCard title="Disabled Plans" value={loading ? '…' : String(stats.disabled)} icon={XCircleIcon} />
      </div>

      {/* Plans grid */}
      {loading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card p-6 h-64 animate-pulse" />
          ))}
        </div>
      ) : plans.length === 0 ? (
        <div className="card p-12 text-center">
          <LayersIcon className="w-10 h-10 mx-auto mb-3 text-text-disabled" />
          <p className="text-text-tertiary text-[13px] mb-4">No membership plans yet.</p>
          <ActionButton variant="primary" icon={PlusIcon} onClick={openCreate}>
            Create your first plan
          </ActionButton>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <AnimatePresence>
            {plans.map((plan, index) => (
              <motion.div
                key={plan.id}
                layout
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: plan.isActive ? 1 : 0.55, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.2 }}
                className="card flex flex-col overflow-hidden"
              >
                {/* Plan image or gradient header */}
                {plan.image ? (
                  <div className="h-28 relative overflow-hidden rounded-t-xl -mx-0 -mt-0">
                    <img src={plan.image} alt={plan.title} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
                  </div>
                ) : (
                  <div className={`h-20 rounded-t-xl -mx-0 bg-gradient-to-r ${cardGradient(index)}`} />
                )}

                {/* Header row */}
                <div className="flex items-start justify-between mt-3 mb-1">
                  <div>
                    <h3 className="text-[15px] font-semibold text-text-primary leading-tight">{plan.title}</h3>
                    <div className="text-lg font-bold text-text-primary mt-0.5">
                      {formatPrice(plan)}
                      <span className="text-[12px] font-normal text-text-tertiary ml-1">/ {plan.duration}</span>
                    </div>
                  </div>
                  {/* Toggle switch */}
                  <button
                    onClick={() => handleToggle(plan)}
                    disabled={togglingIds.has(plan.id)}
                    title={plan.isActive ? 'Disable plan' : 'Enable plan'}
                    className={`w-11 h-6 rounded-full flex items-center p-1 transition-colors shrink-0 ml-2 ${
                      plan.isActive ? 'bg-accent justify-end' : 'bg-border-strong justify-start'
                    } disabled:opacity-50`}
                  >
                    <div className="w-4 h-4 bg-white rounded-full shadow-sm" />
                  </button>
                </div>

                {/* Description */}
                {plan.description && (
                  <p className="text-[12px] text-text-tertiary mb-2 leading-snug line-clamp-2">{plan.description}</p>
                )}

                {/* Features */}
                {plan.features.length > 0 && (
                  <ul className="space-y-1 mb-3 flex-1">
                    {plan.features.slice(0, 5).map((f, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-[12px] text-text-secondary">
                        <CheckIcon className="w-3.5 h-3.5 text-success mt-0.5 shrink-0" />
                        {f}
                      </li>
                    ))}
                    {plan.features.length > 5 && (
                      <li className="text-[11px] text-text-tertiary pl-5">+{plan.features.length - 5} more…</li>
                    )}
                  </ul>
                )}

                {/* Status badge */}
                <div className="mt-auto pt-2 border-t border-border-subtle flex items-center justify-between">
                  <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${plan.isActive ? 'bg-success/15 text-success' : 'bg-text-disabled/20 text-text-disabled'}`}>
                    {plan.isActive ? 'Active' : 'Disabled'}
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => openEdit(plan)}
                      className="p-1.5 rounded-md hover:bg-bg-secondary transition-colors text-text-tertiary hover:text-text-primary"
                      title="Edit plan"
                    >
                      <PencilIcon className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => setDeleteTarget(plan)}
                      className="p-1.5 rounded-md hover:bg-danger/10 transition-colors text-text-tertiary hover:text-danger"
                      title="Delete plan"
                    >
                      <TrashIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      )}

      {/* ── Create Modal ── */}
      <Modal
        isOpen={createOpen}
        onClose={() => { setCreateOpen(false); setCreateError(''); }}
        title="Create Membership Plan"
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => { setCreateOpen(false); setCreateError(''); }}>Cancel</ActionButton>
            <ActionButton variant="primary" onClick={handleCreate} isLoading={createLoading}>Create Plan</ActionButton>
          </>
        }
      >
        <PlanFormBody
          form={createForm}
          onChange={(patch) => setCreateForm((f) => ({ ...f, ...patch }))}
          formError={createError}
          uploading={createUploading}
          onUploadImage={handleCreateImageUpload}
        />
      </Modal>

      {/* ── Edit Modal ── */}
      <Modal
        isOpen={!!editTarget}
        onClose={() => { setEditTarget(null); setEditError(''); }}
        title={`Edit — ${editTarget?.title ?? ''}`}
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => { setEditTarget(null); setEditError(''); }}>Cancel</ActionButton>
            <ActionButton variant="primary" onClick={handleEdit} isLoading={editLoading}>Save Changes</ActionButton>
          </>
        }
      >
        <PlanFormBody
          form={editForm}
          onChange={(patch) => setEditForm((f) => ({ ...f, ...patch }))}
          formError={editError}
          uploading={editUploading}
          onUploadImage={handleEditImageUpload}
        />
      </Modal>

      {/* ── Delete Modal ── */}
      <Modal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        title="Delete Plan"
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => setDeleteTarget(null)}>Cancel</ActionButton>
            <ActionButton variant="danger" onClick={handleDelete} isLoading={deleteLoading}>Delete</ActionButton>
          </>
        }
      >
        <p className="text-[13px] text-text-secondary">
          Are you sure you want to permanently delete{' '}
          <strong className="text-text-primary">{deleteTarget?.title}</strong>?
          This cannot be undone.
        </p>
      </Modal>
    </motion.div>
  );
}
