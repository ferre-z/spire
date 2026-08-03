import { memo } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";

export type CanvasEdgeData = {
  readonly label: string;
  readonly kind: string;
  readonly when: string;
  readonly executing: boolean;
};

export type CanvasEdge = Edge<CanvasEdgeData, "canvas">;

function CanvasEdgeView({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<CanvasEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {data?.label ? (
        <EdgeLabelRenderer>
          <span
            className={`canvas-edge-label nodrag nopan ${data.executing ? "is-executing" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}

export const CanvasEdgeRenderer = memo(CanvasEdgeView);
