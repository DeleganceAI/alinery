export type PastedImage = { id: string; file: File; name: string; previewUrl: string; previewUnavailable: boolean };

const MAX_PASTED_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_PASTED_SET_BYTES = 100 * 1024 * 1024;
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
  "image/heif": "heif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/svg+xml": "svg",
};

export function stagePastedImages(clipboard: DataTransfer, current: PastedImage[]) {
  const errors: string[] = [];
  const files: File[] = [];
  let hasImage = false;
  for (const item of Array.from(clipboard.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue;
    hasImage = true;
    const file = item.getAsFile();
    if (file?.type.startsWith("image/")) files.push(file);
    else errors.push("Couldn't read an image from the clipboard.");
  }
  if (!files.length) {
    for (const file of Array.from(clipboard.files)) {
      if (file.type.startsWith("image/")) files.push(file);
    }
  }
  let total = current.reduce((sum, image) => sum + image.file.size, 0);
  const added: PastedImage[] = [];
  for (const file of files) {
    if (!file.size) {
      errors.push(`${file.name} — pasted image is empty.`);
    } else if (file.size > MAX_PASTED_IMAGE_BYTES) {
      errors.push(`${file.name} — pasted image exceeds 25 MiB.`);
    } else if (file.size > MAX_PASTED_SET_BYTES - total) {
      errors.push(`${file.name} — pasted images would exceed 100 MiB.`);
    } else {
      const id = crypto.randomUUID();
      const extension =
        file.name
          .split(/[\\/]/)
          .pop()
          ?.match(/\.(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|heif|ico|svg)$/i)?.[1]
          .toLowerCase() ??
        IMAGE_EXTENSIONS[file.type.toLowerCase()] ??
        "img";
      added.push({ id, file, name: `pasted-image-${id}.${extension}`, previewUrl: URL.createObjectURL(file), previewUnavailable: false });
      total += file.size;
    }
  }
  return { added, errors, hasImage: hasImage || files.length > 0 };
}
