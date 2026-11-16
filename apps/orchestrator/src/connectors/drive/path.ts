import {
  DriveFolderError,
  loadDriveFile,
  loadDriveRootId,
  loadSharedDrive,
  type DriveFileMeta,
  type DriveFolder,
  type DriveLogin,
} from "./folder.js";

/** What a folder's path reads when a folder on the way up to its Drive's root cannot be read. */
export const DRIVE_PATH_UNAVAILABLE = "Full path unavailable";

/** The most folders a path climbs before it reads as unavailable. */
const MAX_PATH_DEPTH = 32;

/** A folder with its path: the names from its Drive's root down to it, joined by " / ", or `DRIVE_PATH_UNAVAILABLE`. */
export type LocatedDriveFolder = DriveFolder & { path: string };

/** What `read` resolves to, or null when Drive refuses it to this login. */
async function absentWhenRefused<T>(read: Promise<T>): Promise<T | null> {
  try {
    return await read;
  } catch (error) {
    if (error instanceof DriveFolderError) {
      return null;
    }
    throw error;
  }
}

/** The Drive files the paths of one lookup climb through, each read once with the login. */
class DriveTree {
  private readonly files = new Map<string, Promise<DriveFileMeta | null>>();
  private myDriveRoot: Promise<string | null> | null = null;

  constructor(private readonly login: DriveLogin) {}

  /** The file, or null when this login cannot read it. */
  private readableFile(fileId: string): Promise<DriveFileMeta | null> {
    const known = this.files.get(fileId);
    if (known) {
      return known;
    }
    const read = absentWhenRefused(loadDriveFile(this.login.accessToken, fileId, this.login));
    this.files.set(fileId, read);
    return read;
  }

  private myDriveRootId(): Promise<string | null> {
    this.myDriveRoot ??= absentWhenRefused(loadDriveRootId(this.login.accessToken, this.login));
    return this.myDriveRoot;
  }

  /**
   * The name of the Drive `top` is the root of: My Drive, or the shared drive's. Null when `top`
   * is no root, such as a folder shared with the login whose parent the login cannot see.
   */
  private async rootName(top: DriveFileMeta): Promise<string | null> {
    if (top.driveId && top.driveId === top.id) {
      const drive = await absentWhenRefused(loadSharedDrive(this.login.accessToken, top.id, this.login));
      return drive?.name ?? null;
    }
    return top.id === (await this.myDriveRootId()) ? "My Drive" : null;
  }

  /** The folder's path, climbing only parents the login reads, never a folder twice nor past `MAX_PATH_DEPTH`. */
  async readablePath(folderId: string): Promise<string> {
    const names: string[] = [];
    const seen = new Set<string>();
    let fileId = folderId;
    while (names.length < MAX_PATH_DEPTH && !seen.has(fileId)) {
      seen.add(fileId);
      const file = await this.readableFile(fileId);
      if (!file) {
        return DRIVE_PATH_UNAVAILABLE;
      }
      const parent = file.parents[0];
      if (!parent) {
        const root = await this.rootName(file);
        return root === null ? DRIVE_PATH_UNAVAILABLE : [root, ...names].join(" / ");
      }
      names.unshift(file.name.trim());
      fileId = parent;
    }
    return DRIVE_PATH_UNAVAILABLE;
  }
}

/** Each folder with its path, read with `login`; folders that share parents read them once. */
export async function locateDriveFolders(login: DriveLogin, folders: DriveFolder[]): Promise<LocatedDriveFolder[]> {
  const tree = new DriveTree(login);
  return Promise.all(folders.map(async (folder) => ({ ...folder, path: await tree.readablePath(folder.id) })));
}
