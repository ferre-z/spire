import { useRef, type ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "../lib";
import { useDialogFocus } from "../workspace/useDialogFocus";

type IconButtonProps = {
  readonly label: string;
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly active?: boolean;
  readonly pressed?: boolean;
  readonly ariaCurrent?: "page";
  readonly disabled?: boolean;
  readonly type?: "button" | "submit";
  readonly className?: string;
};

export function IconButton({
  label,
  children,
  onClick,
  active = false,
  pressed,
  ariaCurrent,
  disabled = false,
  type = "button",
  className,
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cn("ui-icon-button", active && "is-active", className)}
      aria-label={label}
      aria-pressed={pressed}
      aria-current={ariaCurrent}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

type RailItemProps = IconButtonProps & {
  readonly current?: boolean;
  readonly text?: string;
};

export function RailItem({ current = false, text, ...props }: RailItemProps) {
  return (
    <div className="ui-rail-item">
      <IconButton {...props} active={current} ariaCurrent={current ? "page" : undefined} />
      {text && <span aria-hidden="true">{text}</span>}
    </div>
  );
}

export function ToolCard({
  title,
  children,
  className,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <section className={cn("ui-tool-card", className)} aria-label={title}>
      <header>{title}</header>
      <div className="ui-tool-card-body">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className={cn("ui-field", error && "is-invalid")}>
      <span className="ui-field-label">{label}</span>
      {children}
      {(error || hint) && (
        <span className="ui-field-message" role={error ? "alert" : undefined}>
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

export type SegmentOption<T extends string> = {
  readonly id: T;
  readonly label: string;
};

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: readonly SegmentOption<T>[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <div className="ui-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export type StatusTone =
  | "neutral"
  | "ready"
  | "warning"
  | "error"
  | "disconnected"
  | "loading";

export function StatusBadge({
  label,
  tone = "neutral",
}: {
  readonly label: string;
  readonly tone?: StatusTone;
}) {
  return <span className={`ui-status-badge tone-${tone}`}>{label}</span>;
}

export function Drawer({
  open,
  title,
  onClose,
  controls,
  children,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly controls?: ReactNode;
  readonly children: ReactNode;
}) {
  if (!open) return null;
  return (
    <DrawerDialog title={title} onClose={onClose} controls={controls}>
      {children}
    </DrawerDialog>
  );
}

function DrawerDialog({
  title,
  onClose,
  controls,
  children,
}: {
  readonly title: string;
  readonly onClose: () => void;
  readonly controls?: ReactNode;
  readonly children: ReactNode;
}) {
  const dialogRef = useRef<HTMLElement>(null);
  useDialogFocus({ containerRef: dialogRef, onClose });
  return (
    <div className="ui-drawer-layer">
      <button
        type="button"
        className="ui-drawer-scrim"
        aria-label={`Dismiss ${title} drawer`}
        onClick={onClose}
      />
      <aside
        ref={dialogRef}
        className="ui-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <header className="ui-drawer-header">
          <div>
            <span>OUTPUT</span>
            <h2>{title}</h2>
          </div>
          <IconButton label={`Close ${title}`} onClick={onClose}>
            <X size={16} />
          </IconButton>
        </header>
        {controls}
        <div className="ui-drawer-body">{children}</div>
      </aside>
    </div>
  );
}
