import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ExcalidrawApp from "./App";
import { registerSW } from "virtual:pwa-register";

import "../excalidraw-app/sentry";

import { setDefaultLanguageWithDelay } from "./ext";

window.__EXCALIDRAW_SHA__ = import.meta.env.VITE_APP_GIT_SHA;
const rootElement = document.getElementById("root")!;
const root = createRoot(rootElement);
registerSW();
setDefaultLanguageWithDelay("zh-CN");
root.render(
  <StrictMode>
    <ExcalidrawApp />
  </StrictMode>,
);
