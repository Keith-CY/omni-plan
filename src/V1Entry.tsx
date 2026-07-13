import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";

import { AgentApp, isAgentPath } from "./AgentApp";
import { App } from "./App";
import "./styles.css";

export const V1_APP_MARKER = "omni-plan-app-generation:v1";

export function renderApp(rootElement: HTMLElement): void {
  rootElement.dataset.appGeneration = "v1";
  rootElement.dataset.appMarker = V1_APP_MARKER;
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {isAgentPath() ? (
        <AgentApp />
      ) : (
        <HashRouter>
          <App />
        </HashRouter>
      )}
    </React.StrictMode>,
  );
}
