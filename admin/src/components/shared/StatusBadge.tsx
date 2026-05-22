import React from 'react';

export type StatusColor = 'green' | 'red' | 'yellow' | 'blue' | 'gray' | 'brand';

interface StatusBadgeProps {
  status: string;
  color?: StatusColor;
  dot?: boolean;
}

const colorMap: Record<StatusColor, string> = {
  green:  'bg-success/10 text-success    border-success/20',
  red:    'bg-danger/10  text-danger      border-danger/20',
  yellow: 'bg-warning/10 text-warning    border-warning/20',
  blue:   'bg-accent/10  text-accent      border-accent/20',
  gray:   'bg-bg-elevated text-text-secondary border-border-default',
  brand:  'bg-accent/10  text-accent      border-accent/20',
};

const dotColor: Record<StatusColor, string> = {
  green: 'bg-success', red: 'bg-danger', yellow: 'bg-warning',
  blue: 'bg-accent', gray: 'bg-text-tertiary', brand: 'bg-accent',
};

export function StatusBadge({ status, color = 'gray', dot = false }: StatusBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border ${colorMap[color]}`}>
      {dot && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor[color]}`} />}
      {status}
    </span>
  );
}
