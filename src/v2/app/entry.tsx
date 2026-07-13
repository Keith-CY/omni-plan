import React from "react";
import ReactDOM from "react-dom/client";

import { AgentAdapter } from "../repositories/agentAdapter";
import { BootstrapService } from "../repositories/bootstrapService";
import { BrowserWorkspaceRepository } from "../repositories/browserWorkspaceRepository";
import { CommandService } from "../repositories/commandService";
import { AgentAppV2 } from "./agent/AgentAppV2";
import { AppV2 } from "./AppV2";
import { V2_BROWSER_WORKSPACE_ID } from "./state/V2WorkspaceProvider";
import "./v2.css";

export const V2_APP_MARKER = "omni-plan-app-generation:v2";

export function isV2AgentPath(pathname = window.location.pathname): boolean {
  return pathname === "/agent" || pathname.startsWith("/agent/");
}

function createBrowserAgentProps() {
  const repository = new BrowserWorkspaceRepository();
  const bootstrapService = new BootstrapService({
    repository,
    workspaceId: V2_BROWSER_WORKSPACE_ID,
  });
  const commandService = new CommandService(repository, V2_BROWSER_WORKSPACE_ID);
  const agentAdapter = new AgentAdapter(commandService, {
    // Task 26 supplies configured trusted Agent sources. The internal V2 shell
    // fails closed until then; caller-provided source IDs never create trust.
    resolve: () => undefined,
  });
  return { bootstrapService, agentAdapter };
}

export function renderApp(rootElement: HTMLElement): void {
  rootElement.dataset.appGeneration = "v2";
  rootElement.dataset.appMarker = V2_APP_MARKER;
  const agentProps = isV2AgentPath() ? createBrowserAgentProps() : undefined;
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      {agentProps !== undefined ? (
        <AgentAppV2
          pathname={window.location.pathname}
          bootstrapService={agentProps.bootstrapService}
          agentAdapter={agentProps.agentAdapter}
        />
      ) : (
        <AppV2 />
      )}
    </React.StrictMode>,
  );
}
