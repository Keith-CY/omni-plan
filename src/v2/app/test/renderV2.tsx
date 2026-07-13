import { render, type RenderOptions } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactElement, ReactNode } from "react";

import {
  V2WorkspaceProvider,
  type V2WorkspaceRuntime,
} from "../state/V2WorkspaceProvider";

export interface RenderV2Options extends Omit<RenderOptions, "wrapper"> {
  initialPath?: string;
  runtime: V2WorkspaceRuntime;
}

export function renderV2(
  element: ReactElement,
  { initialPath = "/", runtime, ...options }: RenderV2Options,
) {
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        <V2WorkspaceProvider runtime={runtime}>{children}</V2WorkspaceProvider>
      </MemoryRouter>
    );
  }
  return render(element, { wrapper: Wrapper, ...options });
}
