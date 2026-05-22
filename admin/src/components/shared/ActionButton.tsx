import React from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'warning' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

interface ActionButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: React.ComponentType<{ className?: string }> | React.ReactNode;
  label?: string;
  children?: React.ReactNode;
  isLoading?: boolean;
}

const variants: Record<Variant, string> = {
  primary:   'bg-white text-black hover:bg-white/90 border border-transparent font-medium',
  secondary: 'bg-transparent text-text-secondary hover:text-text-primary border border-border-default hover:border-border-strong',
  danger:    'bg-transparent text-danger hover:bg-danger/10 border border-danger/30 hover:border-danger/50',
  warning:   'bg-transparent text-warning hover:bg-warning/10 border border-warning/30 hover:border-warning/50',
  ghost:     'bg-transparent text-text-tertiary hover:text-text-primary hover:bg-bg-elevated border border-transparent',
};

const sizes: Record<Size, string> = {
  sm: 'h-7 px-3 text-xs gap-1.5',
  md: 'h-8 px-3.5 text-[13px] gap-2',
  lg: 'h-10 px-4 text-sm gap-2',
};

export function ActionButton({
  variant = 'primary',
  size = 'md',
  icon,
  label,
  children,
  isLoading,
  className = '',
  disabled,
  ...props
}: ActionButtonProps) {
  const iconSize = size === 'sm' ? 'w-3.5 h-3.5' : 'w-4 h-4';

  const renderIcon = () => {
    if (isLoading) return (
      <svg className={`animate-spin ${iconSize}`} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
      </svg>
    );
    if (!icon) return null;
    if (React.isValidElement(icon)) return icon;
    const Icon = icon as React.ComponentType<{ className?: string }>;
    return <Icon className={iconSize} />;
  };

  return (
    <button
      disabled={disabled || isLoading}
      className={`
        inline-flex items-center justify-center rounded-md
        transition-all duration-150 cursor-pointer select-none
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50
        disabled:opacity-40 disabled:cursor-not-allowed
        ${variants[variant]}
        ${sizes[size]}
        ${className}
      `}
      {...props}
    >
      {renderIcon()}
      {label ?? children}
    </button>
  );
}
