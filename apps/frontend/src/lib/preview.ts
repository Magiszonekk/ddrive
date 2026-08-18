import { fetchBlobBody } from "./api.js";
import { classifyPreviewKind, type PreviewKind } from "./media.js";

export interface OwnerPreviewOptions {
  fileName: string;
  mimeType: string;
  manifestBlobId: string;
}

export interface PreviewResult {
  fileName: string;
  mimeType: string;
  previewKind: PreviewKind;
  bytes: number;
  objectUrl: string;
}

export async function createOwnerPreview(options: OwnerPreviewOptions): Promise<PreviewResult> {
  const body = await fetchBlobBody(options.manifestBlobId);
  const blob = new Blob([body], { type: options.mimeType });

  return {
    fileName: options.fileName,
    mimeType: options.mimeType,
    previewKind: classifyPreviewKind(options.mimeType),
    bytes: body.byteLength,
    objectUrl: URL.createObjectURL(blob),
  };
}

export function revokePreview(preview: Pick<PreviewResult, "objectUrl"> | null | undefined) {
  if (!preview?.objectUrl) return;
  URL.revokeObjectURL(preview.objectUrl);
}
