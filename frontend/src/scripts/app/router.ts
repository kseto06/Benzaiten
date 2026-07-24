import { app } from "./appRoot";
import { renderLanding } from "./landing";
import { renderEditor } from "../editor";
import { createBlankEditorProject, loadEditorProject, saveEditorProject } from "../editor/state";
import type { EditorProject, VolatileProjectReason } from "../common/types";

export function openEditor(project: EditorProject): void {
  saveEditorProject(project);
  window.location.hash = "editor";
}

export function openBlankEditor(volatileReason?: VolatileProjectReason): void {
  openEditor(createBlankEditorProject(volatileReason));
}

export function renderRoute(): void {
  if (window.location.hash === "#editor") {
    const project = loadEditorProject();
    if (project) {
      renderEditor(project);
      return;
    }
    window.location.hash = "";
  }
  if (!app.querySelector(".app-shell")) {
    renderLanding({ openEditor, openBlankEditor });
  }
}
