export function downloadGeneratedFile(file: Blob, filename: string): void {
  const link = document.createElement("a");
  const url = URL.createObjectURL(file);
  try {
    link.href = url;
    link.download = filename;
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    document.body.appendChild(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(url);
  }
}
