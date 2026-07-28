import type { RunStatus } from "../../shared/domain";
import { cn } from "../lib";

export function StatusPill({
  status,
  compact = false,
}: {
  status: RunStatus;
  compact?: boolean;
}) {
  const label = status.replace("_", " ");
  return (
    <span className={cn("status-pill", `status-${status}`, compact && "compact")}>
      <span className="status-dot" />
      {!compact && label}
    </span>
  );
}
