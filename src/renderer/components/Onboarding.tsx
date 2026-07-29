import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  ExternalLink,
  KeyRound,
  LoaderCircle,
  TerminalSquare,
} from "lucide-react";
import { Brand } from "./Brand";
import { useAppStore } from "../store";

export function Onboarding() {
  const snapshot = useAppStore((state) => state.snapshot);
  const applySnapshot = useAppStore((state) => state.applySnapshot);
  const setError = useAppStore((state) => state.setError);
  const [apiKey, setApiKey] = useState("");
  const [detecting, setDetecting] = useState(true);
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    void window.spire
      .detectOpenCode()
      .then(applySnapshot)
      .catch((error) => setError(String(error)))
      .finally(() => setDetecting(false));
  }, [applySnapshot, setError]);

  const status = snapshot?.openCode;

  async function connect() {
    if (!apiKey.trim()) return;
    setConnecting(true);
    setError(undefined);
    try {
      const next = await window.spire.connectOpenRouter({ apiKey });
      setApiKey("");
      applySnapshot(next);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <main className="onboarding-shell">
      <div className="onboarding-ambient ambient-one" />
      <div className="onboarding-ambient ambient-two" />
      <header className="onboarding-header">
        <Brand />
        <span className="eyebrow">LOCAL ORCHESTRATION</span>
      </header>
      <section className="onboarding-card">
        <div className="step-index">01 / 02</div>
        <p className="kicker">IGNITION SEQUENCE</p>
        <h1>Connect your first<br />agent runtime.</h1>
        <p className="lede">
          Spire runs OpenCode locally and turns its sessions into a live,
          inspectable agent graph. Your source stays in an isolated Git worktree.
        </p>

        <div className="runtime-check">
          <div className="runtime-icon">
            <TerminalSquare size={20} />
          </div>
          <div>
            <strong>OpenCode CLI</strong>
            <span>
              {detecting
                ? "Scanning this machine…"
                : status?.installed
                  ? `${status.binaryPath} · v${status.version}`
                  : "Compatible CLI not found"}
            </span>
          </div>
          <div className="runtime-result">
            {detecting ? (
              <LoaderCircle className="spin" size={18} />
            ) : status?.installed && status.compatible ? (
              <Check size={18} />
            ) : (
              <button
                className="external-link-button"
                onClick={() =>
                  void window.spire.openExternal("https://opencode.ai/docs/")
                }
                aria-label="Open installation guide"
              >
                <ExternalLink size={18} />
              </button>
            )}
          </div>
        </div>

        <label className="field-label" htmlFor="openrouter-key">
          OPENROUTER API KEY
        </label>
        <div className="key-field">
          <KeyRound size={17} />
          <input
            id="openrouter-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-or-v1-••••••••••••••••"
            autoComplete="off"
          />
        </div>
        <p className="field-help">
          Sent directly to the local OpenCode service. Spire never stores it in
          run history or its database.
        </p>
        <button
          className="primary-button ignition-button liquid-border"
          disabled={!status?.compatible || !apiKey.trim() || connecting}
          onClick={() => void connect()}
        >
          {connecting ? (
            <LoaderCircle className="spin" size={18} />
          ) : (
            <ArrowRight size={18} />
          )}
          {connecting ? "Connecting runtime" : "Enter Spire"}
        </button>
      </section>
      <footer className="onboarding-footer">
        <span>OPEN SOURCE · LOCAL FIRST</span>
        <span>BUILD 0.1.0</span>
      </footer>
    </main>
  );
}
