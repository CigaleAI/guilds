import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { uploadFile, type FilesPrefix } from "../files";
import { noteKeys } from "./notes";
import type {
  FileItem,
  FileUpload,
} from "../types";

/**
 * Query keys of shared files. Identity is fixed for the page's life, so keys carry no user or org.
 */
export const fileKeys = {
  fileList: (prefix: string) => ["artifacts", "files", prefix] as const,
};

/** A scope's shared files, or nothing when there is no scope. */
export function useFileList(prefix: FilesPrefix | null) {
  return useQuery({
    queryKey: fileKeys.fileList(prefix ?? ""),
    queryFn: () => api<FileItem[]>(prefix ?? ""),
    enabled: Boolean(prefix),
  });
}

/** Stores a file under a scope; a file of the same name there is replaced. */
export function useUploadFile(prefix: FilesPrefix) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ file, description }: FileUpload) => uploadFile(prefix, file, description),
    onSuccess: (item) => {
      void client.invalidateQueries({ queryKey: fileKeys.fileList(prefix) });
      void client.invalidateQueries({ queryKey: noteKeys.latestChange(item.display_path) });
    },
  });
}

/** Deletes a shared file by id and refreshes the scope it was listed in. */
export function useDeleteFile(prefix: FilesPrefix) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<undefined>(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: fileKeys.fileList(prefix) }),
  });
}
