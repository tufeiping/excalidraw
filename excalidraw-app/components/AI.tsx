import { TTDDialog } from "@excalidraw/excalidraw";

import { TTDIndexedDBAdapter } from "../data/TTDStorage";

/**
 * Text-to-diagram entry point.
 *
 * Only the manual Mermaid converter is mounted here: the AI side of this dialog
 * (the `text-to-diagram` tab) is switched off through `aiEnabled={false}`,
 * because the AI assistant panel in the right drawer is this app's single AI
 * surface — it can generate whole diagrams itself via its `insert_diagram` tool.
 */
export const AIComponents = () => {
  return <TTDDialog persistenceAdapter={TTDIndexedDBAdapter} />;
};
