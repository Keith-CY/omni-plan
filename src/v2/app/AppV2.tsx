import { HashRouter } from "react-router-dom";

import { V2Routes } from "./routes";
import {
  V2WorkspaceProvider,
  type V2WorkspaceRuntime,
} from "./state/V2WorkspaceProvider";

export interface AppV2Props {
  runtime?: V2WorkspaceRuntime;
}

export function AppV2({ runtime }: AppV2Props = {}) {
  return (
    <V2WorkspaceProvider runtime={runtime}>
      <HashRouter>
        <V2Routes />
      </HashRouter>
    </V2WorkspaceProvider>
  );
}
