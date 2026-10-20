import {
  DiagramToCodePlugin,
  exportScene,
  getNonDeletedElements,
  getTextFromElements,
  parseSSEStream,
  TTDDialog,
  TTDStreamFetch,
  THEME,
} from "@excalidraw/excalidraw";
import { getDataURL } from "@excalidraw/excalidraw/data/blob";
import { safelyParseJSON } from "@excalidraw/common";

import type { StreamChunk } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { streamTextToDiagram } from "../ai/openaiCompatibleChat";
import { TTDIndexedDBAdapter } from "../data/TTDStorage";
import { getAiBackendUrl, getAiProvider } from "../runtimeEnv";

export const AIComponents = ({
  excalidrawAPI,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
}) => {
  const aiBackend = getAiBackendUrl();
  const aiProvider = getAiProvider();

  return (
    <>
      {/* diagram-to-code needs an image-capable excalidraw AI backend,
          DeepSeek/OpenAI-compatible chat endpoints don't support it */}
      {aiProvider === "excalidraw" && (
        <DiagramToCodePlugin
          generate={async ({ frame, children, onPartial }) => {
            const appState = excalidrawAPI.getAppState();

            // SAFETY: This should never happen, but log it just in case
            if (children.some((el) => el.isDeleted)) {
              console.error(
                "[NONDELETED][INVARIANT] Generated children elements should not be `isDeleted: true`",
              );
            }

            const blob = await exportScene({
              type: "jpeg",
              data: {
                elements: getNonDeletedElements(children),
                appState,
                files: excalidrawAPI.getFiles(),
              },
              config: {
                exportingFrame: frame,
                theme: appState.exportWithDarkMode ? THEME.DARK : THEME.LIGHT,
              },
            });

            const dataURL = await getDataURL(blob);

            const textFromFrameChildren = getTextFromElements(children);

            const response = await fetch(
              `${aiBackend}/v1/ai/diagram-to-code/generate-streaming`,
              {
                method: "POST",
                headers: {
                  Accept: "text/event-stream",
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  texts: textFromFrameChildren,
                  image: dataURL,
                  theme: appState.theme,
                }),
              },
            );

            if (!response.ok) {
              const text = await response.text();
              const errorJSON = safelyParseJSON(text);

              if (!errorJSON) {
                throw new Error(text);
              }

              if (errorJSON.statusCode === 429) {
                return {
                  html: `<html>
                <body style="margin: 0; text-align: center">
                <div style="display: flex; align-items: center; justify-content: center; flex-direction: column; height: 100vh; padding: 0 60px">
                  <div style="color:red">Too many requests today,</br>please try again tomorrow!</div>
                  </br>
                  </br>
                  <div>You can also try <a href="${
                    import.meta.env.VITE_APP_PLUS_LP
                  }/plus?utm_source=excalidraw&utm_medium=app&utm_content=d2c" target="_blank" rel="noopener">Excalidraw+</a> to get more requests.</div>
                </div>
                </body>
                </html>`,
                };
              }

              throw new Error(errorJSON.message || text);
            }

            const reader = response.body?.getReader();

            if (!reader) {
              throw new Error("Generation failed (invalid response)");
            }

            let html = "";
            let streamError: Error | null = null;

            for await (const data of parseSSEStream(reader)) {
              if (data === "[DONE]") {
                break;
              }

              const chunk = safelyParseJSON(data) as StreamChunk | null;

              if (!chunk) {
                continue;
              }

              switch (chunk.type) {
                case "content": {
                  if (chunk.delta) {
                    html += chunk.delta;
                    onPartial?.(html);
                  }
                  break;
                }
                case "error": {
                  streamError = new Error(
                    chunk.error.message || "Generation failed",
                  );
                  break;
                }
                case "done": {
                  break;
                }
              }
            }

            if (streamError) {
              throw streamError;
            }

            if (!html.trim()) {
              throw new Error("Generation failed (invalid response)");
            }

            return {
              html,
            };
          }}
        />
      )}

      <TTDDialog
        onTextSubmit={
          aiProvider === "deepseek"
            ? streamTextToDiagram
            : async (props) => {
                const { onChunk, onStreamCreated, signal, messages } = props;

                return TTDStreamFetch({
                  url: `${aiBackend}/v1/ai/text-to-diagram/chat-streaming`,
                  messages,
                  onChunk,
                  onStreamCreated,
                  extractRateLimits: true,
                  signal,
                });
              }
        }
        persistenceAdapter={TTDIndexedDBAdapter}
      />
    </>
  );
};
