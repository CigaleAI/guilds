import { useItemsAccess } from "../../api/queries/access";
import type { AccessTarget } from "../../api/types/access";
import type { AccessRead } from "./accessGroups";

/** What a list grouped by access knows of its items' access lists, and how it reads the failed ones again. */
type AccessReads = {
  readOf: (id: string) => AccessRead;
  /** Reads again each list whose read failed. */
  retry: () => void;
};

/** The access lists of these items of one kind, as a list grouped by access reads them. */
export function useAccessReads(kind: AccessTarget["kind"], ids: readonly string[]): AccessReads {
  const reads = useItemsAccess(kind, ids);
  const readsById = new Map(ids.map((id, index) => [id, reads[index]]));
  return {
    readOf: (id) => {
      const read = readsById.get(id);
      if (read?.isSuccess) return { status: "success", list: read.data };
      return { status: read?.isError ? "error" : "pending" };
    },
    retry: () => {
      for (const read of reads) if (read.isError) void read.refetch();
    },
  };
}
