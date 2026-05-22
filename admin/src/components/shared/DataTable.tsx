import React from 'react';
import { ChevronUpIcon, ChevronDownIcon } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: string;
  render?: (item: T) => React.ReactNode;
  sortable?: boolean;
  width?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  keyExtractor?: (item: T, index: number) => string;
  isLoading?: boolean;
  onSort?: (key: string) => void;
  sortKey?: string;
  sortDirection?: 'asc' | 'desc';
  emptyMessage?: string;
}

function LoadingRow({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} className="border-b border-border-subtle">
          {Array.from({ length: cols }).map((_, j) => (
            <td key={j} className="px-5 py-3.5">
              <div
                className="h-4 bg-bg-elevated rounded animate-pulse"
                style={{ width: `${55 + Math.random() * 30}%`, opacity: 1 - i * 0.15 }}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function DataTable<T>({
  columns,
  data,
  keyExtractor,
  isLoading,
  onSort,
  sortKey,
  sortDirection,
  emptyMessage = 'No results found',
}: DataTableProps<T>) {
  const key = (item: T, i: number) => {
    if (keyExtractor) return keyExtractor(item, i);
    if ((item as any).id) return String((item as any).id);
    return String(i);
  };

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-border-default">
            {columns.map(col => (
              <th
                key={col.key}
                style={col.width ? { width: col.width } : undefined}
                onClick={() => col.sortable && onSort?.(col.key)}
                className={`
                  px-5 py-3 text-left text-[11px] font-semibold text-text-tertiary
                  uppercase tracking-widest whitespace-nowrap select-none
                  first:pl-5 last:pr-5 bg-bg-base
                  ${col.sortable ? 'cursor-pointer hover:text-text-secondary transition-colors' : ''}
                `}
              >
                <span className="flex items-center gap-1">
                  {col.header}
                  {col.sortable && sortKey === col.key && (
                    sortDirection === 'asc'
                      ? <ChevronUpIcon className="w-3 h-3 shrink-0" />
                      : <ChevronDownIcon className="w-3 h-3 shrink-0" />
                  )}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            <LoadingRow cols={columns.length} />
          ) : data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length}
                className="px-5 py-16 text-center text-[13px] text-text-tertiary"
              >
                {emptyMessage}
              </td>
            </tr>
          ) : (
            data.map((item, i) => (
              <tr
                key={key(item, i)}
                className="border-b border-border-subtle hover:bg-bg-elevated/50 transition-colors duration-100 group"
              >
                {columns.map(col => (
                  <td
                    key={`${key(item, i)}-${col.key}`}
                    className="px-5 py-3.5 text-[13px] text-text-secondary first:pl-5 last:pr-5"
                  >
                    {col.render ? col.render(item) : String((item as any)[col.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
