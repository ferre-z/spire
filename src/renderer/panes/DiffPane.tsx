import { FileCode2 } from "lucide-react";
import { EmptyRun, RunHeader, useSelectedRun } from "./shared";

export function DiffPane() {
  const { run } = useSelectedRun();

  if (!run) {
    return (
      <EmptyRun
        pane="diff"
        message="Select a run to inspect its tracked changes."
      />
    );
  }

  return (
    <div className="pane pane-column" data-pane="diff">
      <RunHeader run={run} />
      <div className="diff-view pane-scroll">
        {run.artifacts?.changedFiles.length ? (
          <div className="changed-files">
            {run.artifacts.changedFiles.map((file) => (
              <span key={file}>
                <FileCode2 size={13} /> {file}
              </span>
            ))}
          </div>
        ) : null}
        <pre>
          <code>{run.artifacts?.diff || "No tracked changes yet."}</code>
        </pre>
      </div>
    </div>
  );
}
