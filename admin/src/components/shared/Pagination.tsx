import React from 'react';
import { ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';

interface PaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems?: number;
  itemsPerPage?: number;
  onPageChange: (page: number) => void;
  onItemsPerPageChange?: (items: number) => void;
}

export function Pagination({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage,
  onPageChange,
  onItemsPerPageChange,
}: PaginationProps) {
  const hasInfo = totalItems !== undefined && itemsPerPage !== undefined;
  const start = hasInfo ? (currentPage - 1) * itemsPerPage! + 1 : null;
  const end = hasInfo ? Math.min(currentPage * itemsPerPage!, totalItems!) : null;

  const pages = (() => {
    const result: (number | '…')[] = [];
    const total = Math.max(1, totalPages);
    if (total <= 7) {
      for (let i = 1; i <= total; i++) result.push(i);
    } else if (currentPage <= 4) {
      for (let i = 1; i <= 5; i++) result.push(i);
      result.push('…');
      result.push(total);
    } else if (currentPage >= total - 3) {
      result.push(1);
      result.push('…');
      for (let i = total - 4; i <= total; i++) result.push(i);
    } else {
      result.push(1, '…', currentPage - 1, currentPage, currentPage + 1, '…', total);
    }
    return result;
  })();

  const btnBase = `
    inline-flex items-center justify-center h-7 min-w-[28px] px-2 rounded-md text-[13px]
    border border-border-default transition-all duration-150
    disabled:opacity-30 disabled:cursor-not-allowed
  `;

  return (
    <div className="flex flex-col sm:flex-row items-center justify-between gap-4 px-5 py-3 border-t border-border-default">
      {/* Item info */}
      <p className="text-[12px] text-text-tertiary">
        {hasInfo ? (
          <>
            Showing <span className="text-text-secondary font-medium">{totalItems === 0 ? 0 : start}</span>
            {' '}–{' '}
            <span className="text-text-secondary font-medium">{end}</span>
            {' '}of{' '}
            <span className="text-text-secondary font-medium">{totalItems}</span>
          </>
        ) : (
          <>
            Page <span className="text-text-secondary font-medium">{currentPage}</span>
            {' '}of{' '}
            <span className="text-text-secondary font-medium">{Math.max(1, totalPages)}</span>
          </>
        )}
      </p>

      {/* Controls */}
      <div className="flex items-center gap-3">
        {onItemsPerPageChange && itemsPerPage !== undefined && (
          <div className="hidden sm:flex items-center gap-2">
            <span className="text-[12px] text-text-tertiary">Per page</span>
            <select
              value={itemsPerPage}
              onChange={e => onItemsPerPageChange(Number(e.target.value))}
              className="input-field h-7 text-[12px] w-auto px-2 py-0"
            >
              {[10, 25, 50, 100].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
        )}

        <nav className="flex items-center gap-1" aria-label="Pagination">
          <button
            onClick={() => onPageChange(currentPage - 1)}
            disabled={currentPage === 1}
            className={`${btnBase} text-text-tertiary hover:text-text-primary hover:bg-bg-elevated`}
          >
            <ChevronLeftIcon className="w-3.5 h-3.5" />
          </button>

          {pages.map((p, i) =>
            p === '…' ? (
              <span key={`e-${i}`} className="inline-flex h-7 w-7 items-center justify-center text-[13px] text-text-tertiary">
                …
              </span>
            ) : (
              <button
                key={p}
                onClick={() => onPageChange(p as number)}
                className={`${btnBase} ${
                  currentPage === p
                    ? 'bg-white text-black border-transparent font-medium'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-elevated'
                }`}
              >
                {p}
              </button>
            )
          )}

          <button
            onClick={() => onPageChange(currentPage + 1)}
            disabled={currentPage >= Math.max(1, totalPages)}
            className={`${btnBase} text-text-tertiary hover:text-text-primary hover:bg-bg-elevated`}
          >
            <ChevronRightIcon className="w-3.5 h-3.5" />
          </button>
        </nav>
      </div>
    </div>
  );
}
