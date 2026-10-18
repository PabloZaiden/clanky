import { useCallback, useRef, useState, type DragEvent } from "react";

interface UseFileTreeDropOptions {
  canUploadFile: boolean;
  onDropFiles: (files: readonly File[], targetDirectory: string) => void;
}

function isFileDragEvent(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function isWithinElement(target: EventTarget | null, element: HTMLElement | null): target is Node {
  return target instanceof Node && element?.contains(target) === true;
}

export function useFileTreeDrop({ canUploadFile, onDropFiles }: UseFileTreeDropOptions) {
  const [dropTargetDirectory, setDropTargetDirectory] = useState<string | null>(null);
  const dropZoneRef = useRef<HTMLDivElement>(null);
  const handleTreeDragEnter = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    event.preventDefault();
    if (canUploadFile) {
      setDropTargetDirectory("");
    }
  }, [canUploadFile]);
  const handleTreeDragOver = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = canUploadFile ? "copy" : "none";
    setDropTargetDirectory(canUploadFile ? "" : null);
  }, [canUploadFile]);
  const handleTreeDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    if (isWithinElement(event.relatedTarget, event.currentTarget)) {
      return;
    }
    setDropTargetDirectory(null);
  }, []);
  const handleDirectoryDragEnter = useCallback((
    event: DragEvent<HTMLDivElement>,
    path: string,
  ) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    if (canUploadFile) {
      setDropTargetDirectory(path);
    }
  }, [canUploadFile]);
  const handleDirectoryDragOver = useCallback((
    event: DragEvent<HTMLDivElement>,
    path: string,
  ) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = canUploadFile ? "copy" : "none";
    setDropTargetDirectory(canUploadFile ? path : null);
  }, [canUploadFile]);
  const handleDirectoryDragLeave = useCallback((
    event: DragEvent<HTMLDivElement>,
  ) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (isWithinElement(nextTarget, event.currentTarget)) {
      return;
    }
    setDropTargetDirectory(
      canUploadFile && isWithinElement(nextTarget, dropZoneRef.current) ? "" : null,
    );
  }, [canUploadFile]);
  const handleDropFile = useCallback((
    event: DragEvent<HTMLDivElement>,
    targetDirectory: string,
  ) => {
    if (!isFileDragEvent(event)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    setDropTargetDirectory(null);
    const files = Array.from(event.dataTransfer.files);
    if (canUploadFile && files.length > 0) {
      onDropFiles(files, targetDirectory);
    }
  }, [canUploadFile, onDropFiles]);
  const handleTreeDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    handleDropFile(event, "");
  }, [handleDropFile]);
  const handleDirectoryDrop = useCallback((
    event: DragEvent<HTMLDivElement>,
    path: string,
  ) => {
    handleDropFile(event, path);
  }, [handleDropFile]);

  return {
    dropTargetDirectory,
    dropZoneRef,
    handleDirectoryDragEnter,
    handleDirectoryDragLeave,
    handleDirectoryDragOver,
    handleDirectoryDrop,
    handleTreeDragEnter,
    handleTreeDragLeave,
    handleTreeDragOver,
    handleTreeDrop,
  };
}
