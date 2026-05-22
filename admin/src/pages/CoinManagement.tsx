import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  CoinsIcon,
  GiftIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  PencilIcon,
  Trash2Icon,
  PowerIcon,
  WalletIcon,
  SparklesIcon,
  PackageIcon,
  CheckCircleIcon,
  XCircleIcon,
} from 'lucide-react';
import { ActionButton } from '../components/shared/ActionButton';
import { DataTable, type Column } from '../components/shared/DataTable';
import { Modal } from '../components/shared/Modal';
import { StatsCard } from '../components/shared/StatsCard';
import { StatusBadge } from '../components/shared/StatusBadge';
import {
  adjustCoinWallet,
  createCoinPackage,
  createGiftCatalogItem,
  deleteCoinPackage,
  deleteGiftCatalogItem,
  fetchCoinPackages,
  fetchCoinWallet,
  fetchGiftCatalog,
  toggleCoinPackage,
  toggleGiftCatalogItem,
  updateCoinPackage,
  updateGiftCatalogItem,
  type CoinPackage,
  type CoinStats,
  type CoinTransaction,
  type CoinWallet,
  type GiftCatalogItem,
  type GiftCatalogStats,
} from '../api/coinsApi';

const EMPTY_STATS: CoinStats = {
  totalWallets: 0,
  activePackages: 0,
  totalCoinLiability: 0,
  totalCoinsSold: 0,
  totalCoinsSpent: 0,
  transactionCount: 0,
};

const EMPTY_GIFT_STATS: GiftCatalogStats = { total: 0, active: 0 };

const PACKAGE_GRADIENTS = [
  'from-amber-500 to-orange-600',
  'from-violet-600 to-fuchsia-500',
  'from-cyan-500 to-blue-600',
  'from-emerald-500 to-teal-600',
  'from-rose-500 to-red-600',
];

const EMPTY_FORM = {
  id: '',
  name: '',
  description: '',
  coins: '',
  bonusCoins: '0',
  priceUsd: '',
  priceNgn: '',
  currency: 'USD',
  sortOrder: '0',
  isActive: true,
};

const EMPTY_GIFT_FORM = {
  id: '',
  name: '',
  coinCost: '',
  emoji: '',
  tone: 'from-rose-500 to-red-500',
  sortOrder: '0',
  isActive: true,
};

type Tab = 'packages' | 'gifts';

function money(value: number, currency = 'USD') {
  const sym = currency === 'NGN' ? '₦' : '$';
  return `${sym}${Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function packageGradient(index: number) {
  return PACKAGE_GRADIENTS[index % PACKAGE_GRADIENTS.length];
}

function packageToForm(pkg: CoinPackage) {
  return {
    id: pkg.id,
    name: pkg.name,
    description: pkg.description || '',
    coins: String(pkg.coins),
    bonusCoins: String(pkg.bonusCoins || 0),
    priceUsd: String(pkg.priceUsd || ''),
    priceNgn: String(pkg.priceNgn || ''),
    currency: pkg.currency || 'USD',
    sortOrder: String(pkg.sortOrder || 0),
    isActive: pkg.isActive,
  };
}

function formPayload(form: typeof EMPTY_FORM) {
  return {
    id: form.id.trim() || undefined,
    name: form.name.trim(),
    description: form.description.trim(),
    coins: Number(form.coins || 0),
    bonusCoins: Number(form.bonusCoins || 0),
    priceUsd: Number(form.priceUsd || 0),
    priceNgn: Number(form.priceNgn || 0),
    currency: form.currency,
    sortOrder: Number(form.sortOrder || 0),
    isActive: form.isActive,
  };
}

function giftToForm(gift: GiftCatalogItem) {
  return {
    id: gift.id,
    name: gift.name,
    coinCost: String(gift.coinCost),
    emoji: gift.emoji || '',
    tone: gift.tone || '',
    sortOrder: String(gift.sortOrder || 0),
    isActive: gift.isActive,
  };
}

function giftFormPayload(form: typeof EMPTY_GIFT_FORM) {
  return {
    id: form.id.trim() || undefined,
    name: form.name.trim(),
    coinCost: Number(form.coinCost || 0),
    emoji: form.emoji.trim() || null,
    tone: form.tone.trim() || null,
    sortOrder: Number(form.sortOrder || 0),
    isActive: form.isActive,
  };
}

function RowIconButton({
  title,
  onClick,
  disabled,
  children,
  className = '',
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`p-2 rounded-lg border border-transparent hover:border-border-default hover:bg-bg-elevated transition-all disabled:opacity-40 ${className}`}
    >
      {children}
    </button>
  );
}

function ActiveToggle({
  active,
  onChange,
  disabled,
}: {
  active: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onChange}
      className={`w-11 h-6 rounded-full flex items-center p-1 transition-colors shrink-0 ${
        active ? 'bg-accent justify-end' : 'bg-border-strong justify-start'
      } disabled:opacity-50`}
    >
      <div className="w-4 h-4 bg-white rounded-full shadow-sm" />
    </button>
  );
}

function PackageFormBody({
  form,
  onChange,
  formError,
  isEdit,
}: {
  form: typeof EMPTY_FORM;
  onChange: (patch: Partial<typeof EMPTY_FORM>) => void;
  formError: string;
  isEdit?: boolean;
}) {
  return (
    <div className="space-y-4">
      {formError && (
        <div className="bg-danger/10 border border-danger/20 rounded-lg p-3 text-danger text-[12px]">
          {formError}
        </div>
      )}
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
          Package ID {!isEdit && <span className="text-danger">*</span>}
        </label>
        <input
          className="input-field font-mono text-[12px]"
          value={form.id}
          disabled={isEdit}
          onChange={(e) => onChange({ id: e.target.value })}
          placeholder="e.g. coins_500"
        />
      </div>
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
          Name <span className="text-danger">*</span>
        </label>
        <input
          className="input-field"
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="500 Coin Pack"
        />
      </div>
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Description</label>
        <textarea
          className="input-field resize-none"
          rows={2}
          value={form.description}
          onChange={(e) => onChange({ description: e.target.value })}
          placeholder="Shown at checkout…"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Base coins</label>
          <input
            type="number"
            min={1}
            className="input-field"
            value={form.coins}
            onChange={(e) => onChange({ coins: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Bonus coins</label>
          <input
            type="number"
            min={0}
            className="input-field"
            value={form.bonusCoins}
            onChange={(e) => onChange({ bonusCoins: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">USD price</label>
          <input
            type="number"
            min={0}
            step="0.01"
            className="input-field"
            value={form.priceUsd}
            onChange={(e) => onChange({ priceUsd: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">NGN price</label>
          <input
            type="number"
            min={0}
            className="input-field"
            value={form.priceNgn}
            onChange={(e) => onChange({ priceNgn: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Sort order</label>
          <input
            type="number"
            className="input-field"
            value={form.sortOrder}
            onChange={(e) => onChange({ sortOrder: e.target.value })}
          />
        </div>
      </div>
      <div className="flex items-center justify-between bg-bg-secondary rounded-lg px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium text-text-primary">Active package</p>
          <p className="text-[11px] text-text-tertiary">Visible on the coin purchase page.</p>
        </div>
        <ActiveToggle active={form.isActive} onChange={() => onChange({ isActive: !form.isActive })} />
      </div>
    </div>
  );
}

function GiftFormBody({
  form,
  onChange,
  formError,
  isEdit,
}: {
  form: typeof EMPTY_GIFT_FORM;
  onChange: (patch: Partial<typeof EMPTY_GIFT_FORM>) => void;
  formError: string;
  isEdit?: boolean;
}) {
  const tone = form.tone?.trim() || 'from-rose-500 to-red-500';
  return (
    <div className="space-y-4">
      {formError && (
        <div className="bg-danger/10 border border-danger/20 rounded-lg p-3 text-danger text-[12px]">
          {formError}
        </div>
      )}
      <div className="flex items-center gap-4 p-4 rounded-xl border border-border-default bg-bg-secondary">
        <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${tone} flex items-center justify-center text-2xl shadow-lg`}>
          {form.emoji || <GiftIcon className="w-7 h-7 text-white/90" />}
        </div>
        <div>
          <p className="text-[13px] font-semibold text-text-primary">{form.name || 'Gift preview'}</p>
          <p className="text-[12px] text-text-tertiary mt-0.5">
            {form.coinCost ? `${Number(form.coinCost).toLocaleString()} coins` : 'Set coin cost'}
          </p>
        </div>
      </div>
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
          Gift ID {!isEdit && <span className="text-danger">*</span>}
        </label>
        <input
          className="input-field font-mono text-[12px]"
          value={form.id}
          disabled={isEdit}
          onChange={(e) => onChange({ id: e.target.value })}
          placeholder="e.g. rocket"
        />
      </div>
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">
          Display name <span className="text-danger">*</span>
        </label>
        <input
          className="input-field"
          value={form.name}
          onChange={(e) => onChange({ name: e.target.value })}
          placeholder="Rocket"
        />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Coin cost</label>
          <input
            type="number"
            min={1}
            className="input-field"
            value={form.coinCost}
            onChange={(e) => onChange({ coinCost: e.target.value })}
          />
        </div>
        <div>
          <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Sort order</label>
          <input
            type="number"
            className="input-field"
            value={form.sortOrder}
            onChange={(e) => onChange({ sortOrder: e.target.value })}
          />
        </div>
      </div>
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Emoji</label>
        <input
          className="input-field"
          value={form.emoji}
          onChange={(e) => onChange({ emoji: e.target.value })}
          placeholder="🚀"
        />
      </div>
      <div>
        <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Gradient classes</label>
        <input
          className="input-field font-mono text-[11px]"
          value={form.tone}
          onChange={(e) => onChange({ tone: e.target.value })}
          placeholder="from-rose-500 to-red-500"
        />
      </div>
      <div className="flex items-center justify-between bg-bg-secondary rounded-lg px-3 py-2.5">
        <div>
          <p className="text-[13px] font-medium text-text-primary">Active gift</p>
          <p className="text-[11px] text-text-tertiary">Available on live streams.</p>
        </div>
        <ActiveToggle active={form.isActive} onChange={() => onChange({ isActive: !form.isActive })} />
      </div>
    </div>
  );
}

export function CoinManagement() {
  const [tab, setTab] = useState<Tab>('packages');
  const [packages, setPackages] = useState<CoinPackage[]>([]);
  const [stats, setStats] = useState<CoinStats>(EMPTY_STATS);
  const [gifts, setGifts] = useState<GiftCatalogItem[]>([]);
  const [giftStats, setGiftStats] = useState<GiftCatalogStats>(EMPTY_GIFT_STATS);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');

  const [packageCreateOpen, setPackageCreateOpen] = useState(false);
  const [packageEdit, setPackageEdit] = useState<CoinPackage | null>(null);
  const [packageForm, setPackageForm] = useState(EMPTY_FORM);
  const [packageFormError, setPackageFormError] = useState('');
  const [packageSaving, setPackageSaving] = useState(false);
  const [packageDisable, setPackageDisable] = useState<CoinPackage | null>(null);
  const [packageDisableLoading, setPackageDisableLoading] = useState(false);
  const [packageToggling, setPackageToggling] = useState<Set<string>>(new Set());

  const [giftCreateOpen, setGiftCreateOpen] = useState(false);
  const [giftEdit, setGiftEdit] = useState<GiftCatalogItem | null>(null);
  const [giftForm, setGiftForm] = useState(EMPTY_GIFT_FORM);
  const [giftFormError, setGiftFormError] = useState('');
  const [giftSaving, setGiftSaving] = useState(false);
  const [giftDisable, setGiftDisable] = useState<GiftCatalogItem | null>(null);
  const [giftDisableLoading, setGiftDisableLoading] = useState(false);
  const [giftToggling, setGiftToggling] = useState<Set<string>>(new Set());

  const [walletUserId, setWalletUserId] = useState('');
  const [wallet, setWallet] = useState<CoinWallet | null>(null);
  const [transactions, setTransactions] = useState<CoinTransaction[]>([]);
  const [walletLoading, setWalletLoading] = useState(false);
  const [adjustAmount, setAdjustAmount] = useState('');
  const [adjustModalOpen, setAdjustModalOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setPageError('');
    try {
      const [pkgRes, giftRes] = await Promise.all([fetchCoinPackages(), fetchGiftCatalog()]);
      setPackages(pkgRes.data || []);
      setStats(pkgRes.stats || EMPTY_STATS);
      setGifts(giftRes.data || []);
      setGiftStats(giftRes.stats || EMPTY_GIFT_STATS);
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const handlePackageToggle = async (pkg: CoinPackage) => {
    const next = !pkg.isActive;
    setPackages((prev) => prev.map((p) => (p.id === pkg.id ? { ...p, isActive: next } : p)));
    setPackageToggling((s) => new Set(s).add(pkg.id));
    try {
      await toggleCoinPackage(pkg.id, next);
    } catch (err) {
      setPackages((prev) => prev.map((p) => (p.id === pkg.id ? { ...p, isActive: !next } : p)));
      setPageError((err as Error).message);
    } finally {
      setPackageToggling((s) => { const n = new Set(s); n.delete(pkg.id); return n; });
    }
  };

  const handleGiftToggle = async (gift: GiftCatalogItem) => {
    const next = !gift.isActive;
    setGifts((prev) => prev.map((g) => (g.id === gift.id ? { ...g, isActive: next } : g)));
    setGiftToggling((s) => new Set(s).add(gift.id));
    try {
      await toggleGiftCatalogItem(gift.id, next);
    } catch (err) {
      setGifts((prev) => prev.map((g) => (g.id === gift.id ? { ...g, isActive: !next } : g)));
      setPageError((err as Error).message);
    } finally {
      setGiftToggling((s) => { const n = new Set(s); n.delete(gift.id); return n; });
    }
  };

  const savePackage = async () => {
    if (!packageForm.name.trim() || Number(packageForm.coins) <= 0) {
      setPackageFormError('Package name and coin amount are required.');
      return;
    }
    setPackageSaving(true);
    setPackageFormError('');
    try {
      const payload = formPayload(packageForm);
      if (packageEdit) await updateCoinPackage(packageEdit.id, payload);
      else await createCoinPackage(payload);
      setPackageEdit(null);
      setPackageCreateOpen(false);
      setPackageForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setPackageFormError((err as Error).message);
    } finally {
      setPackageSaving(false);
    }
  };

  const saveGift = async () => {
    if (!giftForm.name.trim() || Number(giftForm.coinCost) <= 0) {
      setGiftFormError('Gift name and coin cost are required.');
      return;
    }
    setGiftSaving(true);
    setGiftFormError('');
    try {
      const payload = giftFormPayload(giftForm);
      if (giftEdit) await updateGiftCatalogItem(giftEdit.id, payload);
      else await createGiftCatalogItem(payload);
      setGiftEdit(null);
      setGiftCreateOpen(false);
      setGiftForm(EMPTY_GIFT_FORM);
      await load();
    } catch (err) {
      setGiftFormError((err as Error).message);
    } finally {
      setGiftSaving(false);
    }
  };

  const confirmDisablePackage = async () => {
    if (!packageDisable) return;
    setPackageDisableLoading(true);
    try {
      await deleteCoinPackage(packageDisable.id);
      setPackageDisable(null);
      await load();
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setPackageDisableLoading(false);
    }
  };

  const confirmDisableGift = async () => {
    if (!giftDisable) return;
    setGiftDisableLoading(true);
    try {
      await deleteGiftCatalogItem(giftDisable.id);
      setGiftDisable(null);
      await load();
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setGiftDisableLoading(false);
    }
  };

  const lookupWallet = async () => {
    if (!walletUserId.trim()) return;
    setWalletLoading(true);
    setPageError('');
    try {
      const res = await fetchCoinWallet(walletUserId.trim());
      setWallet(res.wallet);
      setTransactions(res.transactions || []);
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setWalletLoading(false);
    }
  };

  const adjustWallet = async () => {
    if (!walletUserId.trim() || !adjustAmount) return;
    setWalletLoading(true);
    try {
      await adjustCoinWallet(walletUserId.trim(), {
        amount: Number(adjustAmount),
        reason: 'Admin Coin Management adjustment',
      });
      setAdjustAmount('');
      setAdjustModalOpen(false);
      await lookupWallet();
      await load();
    } catch (err) {
      setPageError((err as Error).message);
    } finally {
      setWalletLoading(false);
    }
  };

  const packageColumns: Column<CoinPackage>[] = useMemo(() => [
    {
      key: 'name',
      header: 'Package',
      render: (p) => (
        <div className="flex items-center gap-3 min-w-[200px]">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${packageGradient(packages.findIndex((x) => x.id === p.id))} flex items-center justify-center shrink-0 shadow-md`}>
            <CoinsIcon className="w-5 h-5 text-white" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-text-primary text-[13px] truncate">{p.name}</p>
            <p className="text-[11px] text-text-tertiary font-mono truncate">{p.id}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'coins',
      header: 'Coins',
      render: (p) => (
        <div>
          <span className="font-mono text-[13px] font-semibold text-text-primary tabular-nums">
            {p.totalCoins.toLocaleString()}
          </span>
          {p.bonusCoins > 0 && (
            <p className="text-[11px] text-accent mt-0.5">+{p.bonusCoins.toLocaleString()} bonus</p>
          )}
        </div>
      ),
    },
    {
      key: 'priceUsd',
      header: 'USD',
      render: (p) => (
        <span className="inline-flex px-2.5 py-1 rounded-lg bg-bg-elevated border border-border-subtle text-[12px] font-medium tabular-nums">
          {money(p.priceUsd)}
        </span>
      ),
    },
    {
      key: 'priceNgn',
      header: 'NGN',
      render: (p) => (
        <span className="inline-flex px-2.5 py-1 rounded-lg bg-bg-elevated border border-border-subtle text-[12px] font-medium tabular-nums">
          {money(p.priceNgn, 'NGN')}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (p) => (
        <StatusBadge
          status={p.isActive ? 'Active' : 'Disabled'}
          color={p.isActive ? 'green' : 'gray'}
          dot
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '140px',
      render: (p) => (
        <div className="flex items-center justify-end gap-0.5 opacity-80 group-hover:opacity-100">
          <RowIconButton
            title="Edit package"
            onClick={() => {
              setPackageEdit(p);
              setPackageForm(packageToForm(p));
              setPackageFormError('');
            }}
            className="text-text-tertiary hover:text-accent"
          >
            <PencilIcon className="w-4 h-4" />
          </RowIconButton>
          <RowIconButton
            title={p.isActive ? 'Disable package' : 'Enable package'}
            disabled={packageToggling.has(p.id)}
            onClick={() => handlePackageToggle(p)}
            className="text-text-tertiary hover:text-warning"
          >
            <PowerIcon className="w-4 h-4" />
          </RowIconButton>
          <RowIconButton
            title="Remove from catalog"
            onClick={() => setPackageDisable(p)}
            className="text-text-tertiary hover:text-danger hover:bg-danger/10 hover:border-danger/20"
          >
            <Trash2Icon className="w-4 h-4" />
          </RowIconButton>
        </div>
      ),
    },
  ], [packageToggling, packages]);

  const giftColumns: Column<GiftCatalogItem>[] = useMemo(() => [
    {
      key: 'name',
      header: 'Gift',
      render: (g) => (
        <div className="flex items-center gap-3 min-w-[180px]">
          <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${g.tone || 'from-rose-500 to-red-500'} flex items-center justify-center shrink-0 text-lg shadow-md`}>
            {g.emoji || <SparklesIcon className="w-5 h-5 text-white/90" />}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-text-primary text-[13px] truncate">{g.name}</p>
            <p className="text-[11px] text-text-tertiary font-mono truncate">{g.id}</p>
          </div>
        </div>
      ),
    },
    {
      key: 'coinCost',
      header: 'Cost',
      render: (g) => (
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[12px] font-semibold tabular-nums">
          <CoinsIcon className="w-3.5 h-3.5" />
          {g.coinCost.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'tone',
      header: 'Style',
      render: (g) => (
        <div className="flex items-center gap-2 max-w-[220px]">
          <div className={`w-8 h-8 rounded-lg bg-gradient-to-r ${g.tone || 'from-gray-500 to-gray-600'} shrink-0`} />
          <span className="text-[10px] font-mono text-text-tertiary truncate">{g.tone || '—'}</span>
        </div>
      ),
    },
    {
      key: 'sortOrder',
      header: 'Order',
      render: (g) => (
        <span className="text-[13px] font-mono text-text-secondary tabular-nums">{g.sortOrder}</span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (g) => (
        <StatusBadge
          status={g.isActive ? 'Active' : 'Disabled'}
          color={g.isActive ? 'green' : 'gray'}
          dot
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      width: '140px',
      render: (g) => (
        <div className="flex items-center justify-end gap-0.5">
          <RowIconButton
            title="Edit gift"
            onClick={() => {
              setGiftEdit(g);
              setGiftForm(giftToForm(g));
              setGiftFormError('');
            }}
            className="text-text-tertiary hover:text-accent"
          >
            <PencilIcon className="w-4 h-4" />
          </RowIconButton>
          <RowIconButton
            title={g.isActive ? 'Disable gift' : 'Enable gift'}
            disabled={giftToggling.has(g.id)}
            onClick={() => handleGiftToggle(g)}
            className="text-text-tertiary hover:text-warning"
          >
            <PowerIcon className="w-4 h-4" />
          </RowIconButton>
          <RowIconButton
            title="Remove from catalog"
            onClick={() => setGiftDisable(g)}
            className="text-text-tertiary hover:text-danger hover:bg-danger/10 hover:border-danger/20"
          >
            <Trash2Icon className="w-4 h-4" />
          </RowIconButton>
        </div>
      ),
    },
  ], [giftToggling]);

  const txColumns: Column<CoinTransaction>[] = useMemo(() => [
    {
      key: 'type',
      header: 'Type',
      render: (tx) => (
        <span className="text-[12px] font-medium capitalize text-text-primary">{tx.type}</span>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      render: (tx) => (
        <span className={`font-mono text-[13px] font-semibold tabular-nums ${tx.amount < 0 ? 'text-danger' : 'text-success'}`}>
          {tx.amount > 0 ? '+' : ''}{tx.amount.toLocaleString()}
        </span>
      ),
    },
    {
      key: 'balance',
      header: 'Balance after',
      render: (tx) => (
        <span className="font-mono text-[12px] text-text-secondary tabular-nums">
          {Number(tx.balanceAfter || 0).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'date',
      header: 'Date',
      render: (tx) => (
        <span className="text-[12px] text-text-tertiary">
          {tx.createdAt ? new Date(tx.createdAt).toLocaleString() : '—'}
        </span>
      ),
    },
  ], []);

  const tabBtn = (id: Tab, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-[13px] font-medium transition-all ${
        tab === id
          ? 'bg-accent text-white shadow-sm'
          : 'text-text-tertiary hover:text-text-primary hover:bg-bg-elevated'
      }`}
    >
      {icon}
      {label}
    </button>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="space-y-6"
    >
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text-primary">Coin Management</h1>
          <p className="text-[13px] text-text-tertiary mt-0.5">
            Packages, live gifts, and wallet adjustments — prices enforced server-side.
          </p>
        </div>
        <div className="flex gap-2">
          <ActionButton variant="ghost" icon={RefreshCwIcon} onClick={load} isLoading={loading}>
            Refresh
          </ActionButton>
          {tab === 'packages' ? (
            <ActionButton
              variant="primary"
              icon={PlusIcon}
              onClick={() => {
                setPackageForm(EMPTY_FORM);
                setPackageFormError('');
                setPackageCreateOpen(true);
              }}
            >
              Create Package
            </ActionButton>
          ) : (
            <ActionButton
              variant="primary"
              icon={PlusIcon}
              onClick={() => {
                setGiftForm(EMPTY_GIFT_FORM);
                setGiftFormError('');
                setGiftCreateOpen(true);
              }}
            >
              Create Gift
            </ActionButton>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 p-1 rounded-xl bg-bg-secondary border border-border-default w-fit">
        {tabBtn('packages', 'Coin Packages', <PackageIcon className="w-4 h-4" />)}
        {tabBtn('gifts', 'Live Gifts', <GiftIcon className="w-4 h-4" />)}
      </div>

      {pageError && (
        <div className="bg-danger/10 border border-danger/20 rounded-lg p-4 text-danger text-[13px]">
          {pageError}
        </div>
      )}

      <AnimatePresence mode="wait">
        {tab === 'packages' && (
          <motion.div
            key="packages"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="space-y-6"
          >
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
              <StatsCard title="Wallets" value={loading ? '…' : String(stats.totalWallets)} icon={WalletIcon} />
              <StatsCard title="Active packages" value={loading ? '…' : String(stats.activePackages)} icon={CheckCircleIcon} />
              <StatsCard title="Liability" value={loading ? '…' : stats.totalCoinLiability.toLocaleString()} icon={CoinsIcon} />
              <StatsCard title="Coins sold" value={loading ? '…' : stats.totalCoinsSold.toLocaleString()} icon={CoinsIcon} />
              <StatsCard title="Coins spent" value={loading ? '…' : stats.totalCoinsSpent.toLocaleString()} icon={CoinsIcon} />
              <StatsCard title="Transactions" value={loading ? '…' : String(stats.transactionCount)} icon={XCircleIcon} />
            </div>

            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-border-default flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-[14px] font-semibold text-text-primary">Coin packages</h2>
                  <p className="text-[12px] text-text-tertiary mt-0.5">{packages.length} total</p>
                </div>
              </div>
              <DataTable
                columns={packageColumns}
                data={packages}
                isLoading={loading}
                keyExtractor={(item) => item.id}
                emptyMessage="No coin packages yet. Create one to get started."
              />
            </div>
          </motion.div>
        )}

        {tab === 'gifts' && (
          <motion.div
            key="gifts"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            className="space-y-6"
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-lg">
              <StatsCard title="Total gifts" value={loading ? '…' : String(giftStats.total)} icon={GiftIcon} />
              <StatsCard title="Active gifts" value={loading ? '…' : String(giftStats.active)} icon={SparklesIcon} />
            </div>

            <div className="card overflow-hidden">
              <div className="px-5 py-4 border-b border-border-default">
                <h2 className="text-[14px] font-semibold text-text-primary">Live gift catalog</h2>
                <p className="text-[12px] text-text-tertiary mt-0.5">
                  Viewers send gifts by ID only — coin cost is read from this catalog.
                </p>
              </div>
              <DataTable
                columns={giftColumns}
                data={gifts}
                isLoading={loading}
                keyExtractor={(item) => item.id}
                emptyMessage="No gifts yet. Create one for live streams."
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {tab === 'packages' && (
        <div className="card p-5 space-y-4">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div>
              <h2 className="text-[14px] font-semibold text-text-primary flex items-center gap-2">
                <WalletIcon className="w-4 h-4 text-accent" />
                Wallet lookup
              </h2>
              <p className="text-[12px] text-text-tertiary mt-1">Inspect balance and ledger for any user ID.</p>
            </div>
            {wallet && (
              <ActionButton variant="secondary" size="sm" onClick={() => setAdjustModalOpen(true)}>
                Adjust balance
              </ActionButton>
            )}
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              className="input-field flex-1"
              value={walletUserId}
              onChange={(e) => setWalletUserId(e.target.value)}
              placeholder="Paste user ID…"
              onKeyDown={(e) => e.key === 'Enter' && lookupWallet()}
            />
            <ActionButton variant="primary" icon={SearchIcon} onClick={lookupWallet} isLoading={walletLoading}>
              Lookup
            </ActionButton>
          </div>
          {wallet && (
            <div className="space-y-4 pt-2">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                <StatsCard title="Balance" value={wallet.balance.toLocaleString()} icon={CoinsIcon} />
                <StatsCard title="Purchased" value={wallet.lifetimePurchased.toLocaleString()} icon={CoinsIcon} />
                <StatsCard title="Spent" value={wallet.lifetimeSpent.toLocaleString()} icon={CoinsIcon} />
                <StatsCard title="Received" value={wallet.lifetimeReceived.toLocaleString()} icon={CoinsIcon} />
                <StatsCard title="Adjusted" value={wallet.lifetimeAdjusted.toLocaleString()} icon={CoinsIcon} />
              </div>
              <div className="card overflow-hidden border border-border-subtle">
                <div className="px-4 py-3 border-b border-border-default">
                  <h3 className="text-[13px] font-semibold text-text-primary">Recent transactions</h3>
                </div>
                <DataTable
                  columns={txColumns}
                  data={transactions}
                  isLoading={walletLoading}
                  keyExtractor={(tx) => tx.id}
                  emptyMessage="No transactions for this wallet."
                />
              </div>
            </div>
          )}
        </div>
      )}

      <Modal
        isOpen={packageCreateOpen}
        onClose={() => { setPackageCreateOpen(false); setPackageFormError(''); }}
        title="Create coin package"
        maxWidth="lg"
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => setPackageCreateOpen(false)}>Cancel</ActionButton>
            <ActionButton variant="primary" isLoading={packageSaving} onClick={savePackage}>Create package</ActionButton>
          </>
        }
      >
        <PackageFormBody form={packageForm} onChange={(patch) => setPackageForm((f) => ({ ...f, ...patch }))} formError={packageFormError} />
      </Modal>

      <Modal
        isOpen={!!packageEdit}
        onClose={() => { setPackageEdit(null); setPackageFormError(''); }}
        title={`Edit — ${packageEdit?.name ?? ''}`}
        maxWidth="lg"
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => setPackageEdit(null)}>Cancel</ActionButton>
            <ActionButton variant="primary" isLoading={packageSaving} onClick={savePackage}>Save changes</ActionButton>
          </>
        }
      >
        <PackageFormBody form={packageForm} onChange={(patch) => setPackageForm((f) => ({ ...f, ...patch }))} formError={packageFormError} isEdit />
      </Modal>

      <Modal
        isOpen={!!packageDisable}
        onClose={() => setPackageDisable(null)}
        title="Disable package"
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => setPackageDisable(null)}>Cancel</ActionButton>
            <ActionButton variant="danger" isLoading={packageDisableLoading} onClick={confirmDisablePackage}>
              Disable
            </ActionButton>
          </>
        }
      >
        <p className="text-[13px] text-text-secondary">
          Disable <strong className="text-text-primary">{packageDisable?.name}</strong>? It will no longer appear at checkout.
        </p>
      </Modal>

      <Modal
        isOpen={giftCreateOpen}
        onClose={() => { setGiftCreateOpen(false); setGiftFormError(''); }}
        title="Create live gift"
        maxWidth="lg"
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => setGiftCreateOpen(false)}>Cancel</ActionButton>
            <ActionButton variant="primary" isLoading={giftSaving} onClick={saveGift}>Create gift</ActionButton>
          </>
        }
      >
        <GiftFormBody form={giftForm} onChange={(patch) => setGiftForm((f) => ({ ...f, ...patch }))} formError={giftFormError} />
      </Modal>

      <Modal
        isOpen={!!giftEdit}
        onClose={() => { setGiftEdit(null); setGiftFormError(''); }}
        title={`Edit — ${giftEdit?.name ?? ''}`}
        maxWidth="lg"
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => setGiftEdit(null)}>Cancel</ActionButton>
            <ActionButton variant="primary" isLoading={giftSaving} onClick={saveGift}>Save changes</ActionButton>
          </>
        }
      >
        <GiftFormBody form={giftForm} onChange={(patch) => setGiftForm((f) => ({ ...f, ...patch }))} formError={giftFormError} isEdit />
      </Modal>

      <Modal
        isOpen={!!giftDisable}
        onClose={() => setGiftDisable(null)}
        title="Disable gift"
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => setGiftDisable(null)}>Cancel</ActionButton>
            <ActionButton variant="danger" isLoading={giftDisableLoading} onClick={confirmDisableGift}>
              Disable
            </ActionButton>
          </>
        }
      >
        <p className="text-[13px] text-text-secondary">
          Disable <strong className="text-text-primary">{giftDisable?.name}</strong>? Viewers will not be able to send it on streams.
        </p>
      </Modal>

      <Modal
        isOpen={adjustModalOpen}
        onClose={() => setAdjustModalOpen(false)}
        title="Adjust wallet balance"
        footer={
          <>
            <ActionButton variant="ghost" onClick={() => setAdjustModalOpen(false)}>Cancel</ActionButton>
            <ActionButton variant="primary" isLoading={walletLoading} onClick={adjustWallet}>Apply</ActionButton>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-[13px] text-text-secondary">
            User <span className="font-mono text-text-primary">{walletUserId}</span>
          </p>
          <p className="text-[12px] text-text-tertiary">Current balance: {wallet?.balance.toLocaleString() ?? '—'} coins</p>
          <div>
            <label className="block text-[12px] font-medium text-text-secondary mb-1.5">Adjustment</label>
            <input
              className="input-field"
              type="number"
              value={adjustAmount}
              onChange={(e) => setAdjustAmount(e.target.value)}
              placeholder="+100 or -50"
            />
          </div>
        </div>
      </Modal>
    </motion.div>
  );
}
