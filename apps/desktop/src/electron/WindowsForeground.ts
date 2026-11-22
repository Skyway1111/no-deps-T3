import { activateWindow, foregroundWindow } from "@t3tools/shared/sys/win";

/** An Electron native window handle buffer as an HWND; 32-bit builds hand back 4 bytes. */
export function windowHandle(buffer: Buffer): bigint {
  if (buffer.length === 8) return buffer.readBigUInt64LE();
  if (buffer.length === 4) return BigInt(buffer.readUInt32LE());
  throw new Error(`Unsupported Windows window handle size: ${String(buffer.length)} bytes.`);
}

export async function activateWindowsForeground(handleBuffer: Buffer): Promise<void> {
  if (await activateWindow(windowHandle(handleBuffer))) return;
  throw new Error("Windows refused to activate the T3 Code window.");
}

export async function windowsForegroundHandle(): Promise<bigint | undefined> {
  return (await foregroundWindow())?.hwnd;
}

/** Whether a UWP shell host such as Settings owns the foreground. */
export async function isWindowsShellHostedForeground(): Promise<boolean> {
  return (await foregroundWindow())?.className === "ApplicationFrameWindow";
}
