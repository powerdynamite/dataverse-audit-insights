import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { PowerProvider } from "./PowerProvider";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <PowerProvider>
      <App />
    </PowerProvider>
  </StrictMode>
);
