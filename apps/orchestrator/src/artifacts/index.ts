export { ArtifactError } from "./errors.js";
export {
  listFileChanges,
  listLatestFileChanges,
  recordFileChange,
  type FileChangeOperation,
  type FileChangeView,
} from "../db/file-changes.js";
export {
  artifactStore,
  hashArtifactContent,
  type ArtifactRow,
  type ArtifactStore,
  type CollectionDescription,
  type CollectionView,
  type ReachedNote,
  type ReachedTable,
  type RecordView,
  type StateArtifact,
} from "./store.js";
export { validateCollectionName, validatePurpose } from "./collections.js";
export { type MemoryRevisionView } from "./memory.js";
export { ArtifactFiles, fileBlobKey, mimeForName, normalizeMime, validateFileDescription, type FileView } from "./files.js";
export { agentActor, loadOperatorActor, operatorActor, type OperatorScope } from "./actors.js";
export { type AccessEntry, type AccessList } from "./access.js";
export {
  inlineTaskEmbeds,
  collectTaskEmbeds,
  EMBED_DEPTH,
  inspectEmbed,
  inspectTaskEmbeds,
  snapshotTaskEmbeds,
  noteReader,
  embedSource,
  type EmbedSource,
  taskEmbedActor,
  walkTaskEmbeds,
  withoutEmbeds,
  type EmbedReader,
  type EmbedStep,
  snapshotTaskCollections,
  type TaskEmbedInspection,
  type TaskEmbedSnapshot,
} from "./embeds.js";
export { columnCatalog, describeColumn, parseColumnChange, parseColumns } from "./columns.js";
export { COLUMN_TYPES, type CollectionColumn, type ColumnType } from "../db/collections.js";
export {
  ACCESS_MODES,
  ACCESS_SUBJECTS,
  ARTIFACT_KINDS,
  ARTIFACT_LEVELS,
  EMBED_BUDGET,
  FILE_DESCRIPTION_MAX,
  FILE_MAX_BYTES,
  ORG_FILE_BYTES_MAX,
  resolveAccess,
  isAccessMode,
  isAgentAccessMode,
  isArtifactKind,
  isArtifactLevel,
  type AccessMode,
  type AccessSubject,
  type AccessTarget,
  type AccessTargetKind,
  type AgentAccessMode,
  type ArtifactActor,
  type ArtifactKind,
  type ArtifactLevel,
} from "./types.js";
export {
  assertNoteKeyFree,
  collectionDisplayPath,
  displayPathFor,
  fileDisplayPath,
  FILES_SEGMENT,
  hostFileDisplayPath,
  isDisplayPath,
  MEMORY_KEY,
  normalizeFileName,
  normalizeNoteKey,
  ownerPrefix,
  parseDisplayPath,
  recordDisplayPath,
  type ParsedDisplayPath,
  SCRIPTS_SEGMENT,
  TASK_KEY,
} from "./paths.js";
