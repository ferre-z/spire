import { Network } from "lucide-react";

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Spire">
      <span className="brand-mark">
        <Network size={17} strokeWidth={2.2} />
      </span>
      {!compact && (
        <span className="brand-name">
          SPIRE <span>LABS</span>
        </span>
      )}
    </div>
  );
}
