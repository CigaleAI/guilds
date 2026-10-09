export { ArtifactError } from "./errors.js";
export {
  listFileChanges,
  listLatestFileChanges,
  recordFileChange,
  type FileChangeOperation,
  type FileChangeView,
} from "./file-changes.js";
export {
  ArtifactStore,
  hashArtifactContent,
  validateCollectionName,
  validatePurpose,
  type CollectionDescription,
  type CollectionView,
  type MemoryRevisionRow,
  type RecordView,
} from "./store.js";
export { agentActor, catalogLevels, grantsFromBindings, operatorActor } from "./grants.js";
export {
  inlineTaskEmbeds,
  collectTaskEmbeds,
  inspectTaskEmbeds,
  snapshotTaskEmbeds,
  type TaskEmbedInspection,
  type TaskEmbedSnapshot,
} from "./embeds.js";
export {
  COLUMN_TYPES,
  columnCatalog,
  describeColumn,
  parseColumnChange,
  parseColumns,
  type CollectionColumn,
  type ColumnType,
} from "./columns.js";
export {
  ACCESS_MODES,
  ARTIFACT_GRANT_IDS,
  ARTIFACT_KINDS,
  ARTIFACT_LEVELS,
  DEFAULT_ARTIFACT_GRANTS,
  resolveAccess,
  isAccessMode,
  isAgentAccessMode,
  isArtifactKind,
  isArtifactLevel,
  type AccessMode,
  type AccessSubject,
  type AgentAccessMode,
  type ArtifactActor,
  type ArtifactGrants,
  type ArtifactKind,
  type ArtifactLevel,
} from "./types.js";
export {
  assertNoteKeyFree,
  collectionDisplayPath,
  displayPathFor,
  hostFileDisplayPath,
  isDisplayPath,
  MEMORY_KEY,
  normalizeNoteKey,
  ownerPrefix,
  parseDisplayPath,
  recordDisplayPath,
  SCRIPTS_SEGMENT,
  TASK_KEY,
} from "./paths.js";
