import {
  AI_CONFIG_STORAGE_KEY,
  LEGACY_AI_KEY_STORAGE_KEY,
  AI_PRESETS,
  applyAiPreset,
  describeAiModel,
  isAiConfigured,
  normalizeBaseUrl,
  readAiConfig,
  updateAiConfig,
  updateCustomAiConfig,
} from "./aiConfig";

const store = (value: unknown) =>
  window.localStorage.setItem(AI_CONFIG_STORAGE_KEY, JSON.stringify(value));

const customConfig = (overrides: Record<string, string> = {}) => ({
  mode: "custom",
  custom: {
    preset: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "sk-test",
    ...overrides,
  },
  ne: { model: "" },
});

describe("aiConfig", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete window.__EXCALIDRAW_ENV__;
  });

  it("defaults to the deployment relay", () => {
    const config = readAiConfig();
    expect(config.mode).toBe("ne");
    expect(config.ne.model).toBe("");
    expect(isAiConfigured()).toBe(true);
  });

  it("lets the deployment pick another default mode", () => {
    window.__EXCALIDRAW_ENV__ = { aiMode: "custom" };
    expect(readAiConfig().mode).toBe("custom");
    expect(isAiConfigured()).toBe(false);
  });

  it("repairs unreadable storage instead of throwing", () => {
    window.localStorage.setItem(AI_CONFIG_STORAGE_KEY, "{not json");
    expect(readAiConfig().mode).toBe("ne");
  });

  it("migrates the legacy single-key setting without changing the mode", () => {
    window.localStorage.setItem(LEGACY_AI_KEY_STORAGE_KEY, "sk-legacy");
    const config = readAiConfig();
    expect(config.custom.apiKey).toBe("sk-legacy");
    expect(config.mode).toBe("ne");
  });

  it("reports configuration per mode", () => {
    store(customConfig());
    expect(isAiConfigured()).toBe(true);

    store(customConfig({ apiKey: "" }));
    expect(isAiConfigured()).toBe(false);

    store(customConfig({ baseUrl: "" }));
    expect(isAiConfigured()).toBe(false);

    store({ ...customConfig(), mode: "off" });
    expect(isAiConfigured()).toBe(false);
  });

  it("prefills base URL and model from a preset but keeps the key", () => {
    store(customConfig({ apiKey: "sk-keep" }));
    applyAiPreset("ollama");
    const config = readAiConfig();
    const ollama = AI_PRESETS.find((preset) => preset.id === "ollama")!;
    expect(config.custom.baseUrl).toBe(ollama.baseUrl);
    expect(config.custom.model).toBe(ollama.model);
    expect(config.custom.apiKey).toBe("sk-keep");
  });

  it("normalizes a bare host to the /v1 surface", () => {
    expect(normalizeBaseUrl("https://api.deepseek.com")).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(normalizeBaseUrl("https://api.deepseek.com/")).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(normalizeBaseUrl("https://api.deepseek.com/v1/")).toBe(
      "https://api.deepseek.com/v1",
    );
    expect(normalizeBaseUrl("https://example.com/openai/v1")).toBe(
      "https://example.com/openai/v1",
    );
    expect(normalizeBaseUrl("  ")).toBe("");
  });

  it("keeps patches scoped and broadcasts a change event", () => {
    store(customConfig({ model: "a" }));
    const listener = vi.fn();
    window.addEventListener("excalidraw-ai-config-changed", listener);

    updateCustomAiConfig({ model: "b" });

    expect(readAiConfig().custom.model).toBe("b");
    expect(readAiConfig().custom.apiKey).toBe("sk-test");
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("excalidraw-ai-config-changed", listener);
  });

  it("describes the model the user is actually going to hit", () => {
    store({ ...customConfig(), mode: "ne", ne: { model: "qwen3.5" } });
    expect(describeAiModel()).toBe("qwen3.5");

    store({ ...customConfig(), mode: "ne", ne: { model: "" } });
    expect(describeAiModel("relay-default")).toBe("relay-default");

    store(customConfig({ model: "deepseek-chat" }));
    expect(describeAiModel()).toBe("deepseek-chat");
  });

  it("switching mode keeps the other section intact", () => {
    store(customConfig());
    updateAiConfig({ mode: "off" });
    const config = readAiConfig();
    expect(config.mode).toBe("off");
    expect(config.custom.apiKey).toBe("sk-test");
  });
});
