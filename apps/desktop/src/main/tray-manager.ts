import {
  Menu,
  Tray,
  nativeImage
} from 'electron';

export class TrayManager {
  private tray: Tray | undefined;

  create(input: {
    iconPath: string;
    open(): void;
    navigate(route: string): void;
    quit(): void;
  }): void {
    if (this.tray !== undefined) return;
    const size = process.platform === 'darwin' ? 18 : 20;
    const icon = nativeImage.createFromPath(input.iconPath).resize({
      width: size,
      height: size
    });
    if (process.platform === 'darwin') icon.setTemplateImage(true);
    const tray = new Tray(icon);
    tray.setToolTip('BrainBook Creator');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open BrainBook Creator', click: input.open },
      { type: 'separator' },
      { label: 'New task', click: () => input.navigate('#/') },
      { label: 'View running tasks', click: () => input.navigate('#/tasks') },
      { type: 'separator' },
      { label: 'Quit BrainBook Creator', click: input.quit }
    ]));
    tray.on('click', input.open);
    this.tray = tray;
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = undefined;
  }
}
