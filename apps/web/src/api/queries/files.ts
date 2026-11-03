import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { uploadFile } from "../files";
import { noteKeys } from "./notes";
import type { ItemSections, ReachSubject } from "../types/access";
import type { FileItem, FileUpload } from "../types/files";

/**
 * Query keys of shared files. Identity is fixed for the page's life, so keys carry no user or org.
 */
export const fileKeys = {
  fileLists: ["artifacts", "files"] as const,
  fileList: (page: ReachSubject) => ["artifacts", "files", page.type, page.id] as const,
};

/** The route that lists a guild's or an agent's files, by home. */
function fileListPath(page: ReachSubject): string {
  return `/api/${page.type === "guild" ? "guilds" : "agents"}/${encodeURIComponent(page.id)}/files`;
}

/** A guild's or an agent's files: those homed in its guild, and those shared with it. */
export function useFileSections(page: ReachSubject) {
  return useQuery({
    queryKey: fileKeys.fileList(page),
    queryFn: () => api<ItemSections<FileItem>>(fileListPath(page)),
  });
}

/**
 * Stores a file in the organisation; a file of the same name is replaced when the upload's expected
 * version allows. Every files list is refreshed either way, so a refused upload sees the file that
 * refused it; the upload settles once they have refetched.
 */
export function useUploadFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (upload: FileUpload) => uploadFile(upload),
    onSuccess: (item) => {
      void client.invalidateQueries({ queryKey: noteKeys.latestChange(item.display_path) });
    },
    onSettled: () => client.invalidateQueries({ queryKey: fileKeys.fileLists }),
  });
}

/** Deletes a shared file by id and refreshes every files list; the delete settles once they have refetched. */
export function useDeleteFile() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<undefined>(`/api/files/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: () => client.invalidateQueries({ queryKey: fileKeys.fileLists }),
  });
}
