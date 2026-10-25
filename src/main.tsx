import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { applyTheme, storedThemePreference } from "./theme";
// Inter ships with the app (weight and optical-size axes), so every platform renders the same typeface.
import "@fontsource-variable/inter/opsz.css";
import "./styles.css";
import "./themes.css";

applyTheme(storedThemePreference());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
