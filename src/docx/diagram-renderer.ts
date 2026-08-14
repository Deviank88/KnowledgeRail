export interface RenderedDiagramImage {
  data: Buffer;
  width: number;
  height: number;
}

/**
 * Boundary between document generation and a concrete diagram engine.
 * Implementations may render in-process, through a local CLI, or through an
 * isolated service without changing the DOCX pipeline.
 */
export interface DiagramRenderer {
  readonly name: string;
  renderPng(source: string): Promise<RenderedDiagramImage>;
}
