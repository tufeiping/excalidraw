import {
  extractMermaidContent,
  MermaidStreamFilter,
} from "./openaiCompatibleChat";

const streamAll = (chunks: string[]) => {
  const filter = new MermaidStreamFilter();
  let out = "";
  for (const chunk of chunks) {
    out += filter.push(chunk);
  }
  out += filter.flush();
  return out;
};

describe("MermaidStreamFilter", () => {
  it("passes through unfenced definitions", () => {
    expect(streamAll(["flowchart TD\n", "  A[Start] --> B[End]\n"])).toEqual(
      "flowchart TD\n  A[Start] --> B[End]",
    );
  });

  it("strips a fenced definition split across arbitrary chunks", () => {
    const raw = "```mermaid\nflowchart TD\n  A --> B\n```";
    const chunks = raw.split("");

    expect(streamAll(chunks)).toEqual("flowchart TD\n  A --> B");
  });

  it("strips a fence without language tag", () => {
    expect(streamAll(["```\n", "graph LR\n  A-->B\n", "```"])).toEqual(
      "graph LR\n  A-->B",
    );
  });

  it("keeps leading backticks that are part of the definition", () => {
    // a fence-shaped prefix that never completes is not treated as a fence
    expect(streamAll(["graph LR\n  A-->|x|B"])).toEqual("graph LR\n  A-->|x|B");
  });
});

describe("extractMermaidContent", () => {
  it("extracts fenced content", () => {
    expect(extractMermaidContent("```mermaid\nflowchart TD\n```")).toEqual(
      "flowchart TD",
    );
  });

  it("returns plain content as-is", () => {
    expect(extractMermaidContent("  flowchart TD  ")).toEqual("flowchart TD");
  });
});
