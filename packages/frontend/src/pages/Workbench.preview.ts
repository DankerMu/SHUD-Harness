import { renderWorkbenchDocument } from "./Workbench";

if (import.meta.main) {
  process.stdout.write(renderWorkbenchDocument());
}
