import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { uploadFile } from "../files";
import { noteKeys } from "./notes";
import type { AccessSubject } from "../types/access";
import type { FileItem, FileUpload } from "../types/files";

/**
 * Query keys of shared files. Identity is fixed for the page's life, so keys carry no user or org.
 */
export const fileKeys = {
  fileLists: ["artifacts", "files"] as const,
  fileList: (page: AccessSubject) => ["artifacts", "files", page.type, page.id] as const,
};

/**
 * The route that lists a page's files: the organisation's lists every file, a guild's the files
 * whose access list names the guild, one of its agents or the organisation, an agent's the files
 * it reads.
 */
function fileListPath(page: AccessSubject): string {
  if (page.type === "org") return "/api/org/files";
  return `/api/${page.type === "guild" ? "guilds" : "agents"}/${encodeURIComponent(page.id)}/files`;
}

/** The files a page lists, or nothing when there is no page. */
export function useFileList(page: AccessSubject | null) {
  return useQuery({
    queryKey: page ? fileKeys.fileList(page) : fileKeys.fileLists,
    queryFn: () => api<FileItem[]>(page ? fileListPath(page) : ""),
    enabled: Boolean(page),
  });
}

/**
 * Stores a file in the organisation; a file of the same name is replaced when the upload's expected
 * version allows. Every files list is refreshed either way, so a refused upload sees the file that
 * refused it.
 */
export function useUploadFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (upload: FileUpload) => uploadFile(upload),
    onSuccess: (item) => {
      void client.invalidateQueries({ queryKey: noteKeys.latestChange(item.display_path) });
    },
    onSettled: () => void client.invalidateQueries({ queryKey: fileKeys.fileLists }),
  });
}

/** Deletes a shared file by id and refreshes every files list. */
export function useDeleteFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<undefined>(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => void client.invalidateQueries({ queryKey: fileKeys.fileLists }),
  });
}
