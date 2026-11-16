/** What a Drive folder's path reads when its login cannot read it. */
export const DRIVE_PATH_UNAVAILABLE = "Full path unavailable";

/** The folder's page in Google Drive. */
export function driveFolderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}
