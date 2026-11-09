// The Files & Folders switch that lets an app read Google Chrome's folder. No Node imports: the app window bundles it.

/** System Settings, Privacy & Security, Files & Folders. */
export const FILES_AND_FOLDERS_PANE = "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

export function chromeAccessSwitch(app: string): string {
  return `System Settings > Privacy & Security > Files & Folders > ${app} > Google Chrome`;
}
