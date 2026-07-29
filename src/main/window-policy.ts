/**
 * Window-open policy for renderer-created windows. Only the same-origin
 * popout.html used by FlexLayout popouts may open; every other window is
 * denied. Kept free of Electron imports so it stays unit-testable.
 */
export function isAllowedPopoutUrl(
  target: string,
  devServerUrl: string | undefined,
  rendererName: string,
): boolean {
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return false;
  }
  if (devServerUrl) {
    let devUrl: URL;
    try {
      devUrl = new URL(devServerUrl);
    } catch {
      return false;
    }
    return (
      url.origin === devUrl.origin &&
      url.pathname.replace(/\/+$/, "").endsWith("/popout.html")
    );
  }
  return (
    url.protocol === "file:" &&
    url.pathname
      .replace(/\/+$/, "")
      .endsWith(`/renderer/${rendererName}/popout.html`)
  );
}
