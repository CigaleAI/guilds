import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { api } from "../client";
import { accessKeys } from "./access";
import type {
  Collection,
  CollectionRecord,
  RecordsPage,
  RecordsQuery,
  DatabaseInput,
  RecordUpdate,
} from "../types/tables";

/** Query keys of tables. Identity is fixed for the page's life, so keys carry no user or org. */
export const tableKeys = {
  /** Databases and their records; any database write refreshes all of it. */
  databases: ["databases"] as const,
  collection: (id: string) => ["databases", "collection", id] as const,
  records: (id: string, params: string) => ["databases", "records", id, params] as const,
};

/** The organisation's databases, for embedding one in a Task or note. */
export function useCollections() {
  return useDatabases();
}

const collectionPath = (id: string) => `/api/collections/${encodeURIComponent(id)}`;

/** Every database in the organisation, by name, with its record count. */
export function useDatabases() {
  return useQuery({
    queryKey: tableKeys.databases,
    queryFn: () => api<Collection[]>("/api/collections"),
  });
}

/** One database. */
export function useDatabase(id: string | undefined) {
  return useQuery({
    queryKey: tableKeys.collection(id ?? ""),
    queryFn: () => api<Collection>(collectionPath(id ?? "")),
    enabled: Boolean(id),
  });
}

export function useRecords(id: string | undefined, query: RecordsQuery) {
  const params = new URLSearchParams({ limit: String(query.limit) });
  if (query.query) params.set("query", query.query);
  else {
    params.set("offset", String(query.offset));
    if (query.order) params.set("order", JSON.stringify(query.order));
    if (query.where && Object.keys(query.where).length)
      params.set("where", JSON.stringify(query.where));
  }
  const search = params.toString();
  return useQuery({
    queryKey: tableKeys.records(id ?? "", search),
    queryFn: () => api<RecordsPage>(`${collectionPath(id ?? "")}/records?${search}`),
    enabled: Boolean(id),
    placeholderData: (previous) => previous,
  });
}

function useDatabasesRefresh() {
  const client = useQueryClient();
  return () => void client.invalidateQueries({ queryKey: tableKeys.databases });
}

/** A table created, changed or deleted also changes what each guild and agent reaches. */
function useTablesRefresh() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: tableKeys.databases });
    void client.invalidateQueries({ queryKey: accessKeys.accessLists });
  };
}

export function useCreateDatabase() {
  const refresh = useTablesRefresh();
  return useMutation({
    mutationFn: (input: DatabaseInput) =>
      api<Collection>("/api/collections", { method: "POST", body: input }),
    onSuccess: refresh,
  });
}

/** Changes a database's name, purpose, columns or placement; its access list stays as it is. */
export function useUpdateDatabase(id: string) {
  const refresh = useTablesRefresh();
  return useMutation({
    mutationFn: (input: Partial<DatabaseInput>) =>
      api<Collection>(collectionPath(id), { method: "PATCH", body: input }),
    onSuccess: refresh,
  });
}

/** Deletes a database with its records; every guild and agent loses it at once. */
export function useDeleteDatabase() {
  const refresh = useTablesRefresh();
  return useMutation({
    mutationFn: (id: string) => api<undefined>(collectionPath(id), { method: "DELETE" }),
    onSuccess: refresh,
  });
}

/** Adds a record; with a unique column, a record holding the same value is merged into instead. */
export function useAddRecord(id: string) {
  const refresh = useDatabasesRefresh();
  return useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ record: CollectionRecord; merged: number | null }>(`${collectionPath(id)}/records`, {
        method: "POST",
        body: { body },
      }),
    onSuccess: refresh,
  });
}

/** Changes a record's values; null clears one. Warnings name values that still do not fit. */
export function useUpdateRecord(id: string) {
  const refresh = useDatabasesRefresh();
  return useMutation({
    mutationFn: ({ recordId, body }: RecordUpdate) =>
      api<{ record: CollectionRecord; warnings: string[] }>(
        `${collectionPath(id)}/records/${recordId}`,
        {
          method: "PATCH",
          body: { body },
        },
      ),
    onSuccess: refresh,
  });
}

export function useDeleteRecord(id: string) {
  const refresh = useDatabasesRefresh();
  return useMutation({
    mutationFn: (recordId: number) =>
      api<undefined>(`${collectionPath(id)}/records/${recordId}`, { method: "DELETE" }),
    onSuccess: refresh,
  });
}

/** Deletes every record; the database and its access list stay, and new ids carry on. */
export function useClearRecords(id: string) {
  const refresh = useDatabasesRefresh();
  return useMutation({
    mutationFn: () => api<undefined>(`${collectionPath(id)}/records`, { method: "DELETE" }),
    onSuccess: refresh,
  });
}
