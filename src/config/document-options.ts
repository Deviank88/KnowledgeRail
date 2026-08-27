export const DIAGRAM_MODES = ["none", "mermaid", "external_asset"] as const;
export type DiagramMode = (typeof DIAGRAM_MODES)[number];
