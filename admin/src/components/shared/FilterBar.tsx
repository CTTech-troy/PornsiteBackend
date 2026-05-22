import React from 'react';
import { SearchIcon } from 'lucide-react';

interface FilterOption { label: string; value: string; }
interface InlineFilter {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: FilterOption[];
}
interface FilterBarProps {
  searchPlaceholder?: string;
  searchValue: string;
  onSearchChange: (v: string) => void;
  filters?: InlineFilter[];
}

export function FilterBar({
  searchPlaceholder = 'Search…',
  searchValue,
  onSearchChange,
  filters = [],
}: FilterBarProps) {
  return (
    <div className="flex flex-col sm:flex-row gap-3 mb-5">
      {/* Search */}
      <div className="relative flex-1 max-w-sm">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-tertiary pointer-events-none" />
        <input
          type="text"
          value={searchValue}
          onChange={e => onSearchChange(e.target.value)}
          placeholder={searchPlaceholder}
          className="input-field pl-9 h-8 text-[13px]"
        />
      </div>

      {/* Filters */}
      {filters.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto custom-scrollbar">
          {filters.map(f => (
            <select
              key={f.label}
              value={f.value}
              onChange={e => f.onChange(e.target.value)}
              className="input-field h-8 text-[13px] w-auto min-w-[130px] cursor-pointer pr-8"
              style={{ backgroundImage: `url("data:image/svg+xml,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 20 20' fill='none'%3e%3cpath d='M7 7l3-3 3 3m0 6l-3 3-3-3' stroke='%2352525b' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3e%3c/svg%3e")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center', backgroundSize: '16px' }}
            >
              {f.options.map(o => (
                <option key={o.value} value={o.value} style={{ background: '#111111' }}>
                  {o.label}
                </option>
              ))}
            </select>
          ))}
        </div>
      )}
    </div>
  );
}
