/**
 * Backward-compatible names for the shared file explorer request schemas.
 */

export {
  FileExplorerRelativePathSchema as WorkspaceRelativePathSchema,
  FileExplorerStartDirectorySchema as WorkspaceStartDirectorySchema,
  ListFileExplorerRequestSchema as ListWorkspaceFilesRequestSchema,
  GetFileExplorerTreeRequestSchema as GetWorkspaceFileTreeRequestSchema,
  GetFileExplorerFileRequestSchema as GetWorkspaceFileRequestSchema,
  WriteFileExplorerRequestSchema as WriteWorkspaceFileRequestSchema,
  RenameFileExplorerRequestSchema as RenameWorkspaceFileRequestSchema,
  DeleteFileExplorerRequestSchema as DeleteWorkspaceFileRequestSchema,
  CreateFileExplorerUploadRequestSchema as CreateWorkspaceFileUploadRequestSchema,
  UploadFileExplorerChunkRequestSchema as UploadWorkspaceFileChunkRequestSchema,
  CompleteFileExplorerUploadRequestSchema as CompleteWorkspaceFileUploadRequestSchema,
  CancelFileExplorerUploadRequestSchema as CancelWorkspaceFileUploadRequestSchema,
} from "./file-explorer";
