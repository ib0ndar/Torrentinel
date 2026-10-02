// Applies the remembered theme before the application bundle loads. It runs as an
// external file because the Content-Security-Policy does not allow inline scripts.
(() => {
  try {
    const preference = localStorage.getItem("torrentinel-theme");
    if (!preference) return;
    document.documentElement.dataset.theme = preference === "auto"
      ? matchMedia("(prefers-color-scheme: light)").matches ? "daylight" : "sentinel"
      : preference;
  } catch {
    // Storage can be unavailable; the application applies the account theme after it loads.
  }
})();
