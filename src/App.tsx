import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  CircleAlert,
  Download,
  FilePlus2,
  FolderOpen,
  Info,
  Loader2,
  Play,
  RefreshCw,
  Settings,
  X,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useMemo, useState } from "react";
import { invokeCommand, isTauriRuntime } from "./runtime";
import { toolById, tools, type ToolDefinition, type ToolId } from "./tools";
import type { DependencySet, JobState, OperationOptions } from "./types";

type AppearanceMode = "system" | "light" | "dark";
type AppView = ToolId | "settings";

type FormState = Omit<ToolDefinition["defaults"], "input" | "inputs"> & {
  input: string;
  inputs: string[];
  password: string;
  userPassword: string;
  ownerPassword: string;
  allowPrinting: boolean;
  allowCopying: boolean;
  allowModification: boolean;
};

const initialForm = (tool: ToolDefinition): FormState => ({
  ...tool.defaults,
  input: "",
  inputs: [],
  password: "",
  userPassword: "",
  ownerPassword: "",
  allowPrinting: true,
  allowCopying: true,
  allowModification: false,
});

export function App() {
  const [selectedToolId, setSelectedToolId] = useState<ToolId>("mergePdf");
  const [activeView, setActiveView] = useState<AppView>("mergePdf");
  const [appearance, setAppearance] = useState<AppearanceMode>(() => {
    const stored = localStorage.getItem("appearance");
    return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
  });
  const [dependencies, setDependencies] = useState<DependencySet | null>(null);
  const [operationOptions, setOperationOptions] = useState<OperationOptions[]>([]);
  const [form, setForm] = useState<FormState>(() => initialForm(toolById.mergePdf));
  const [jobs, setJobs] = useState<JobState[]>([]);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isNativeSidebarCollapsed, setIsNativeSidebarCollapsed] = useState(false);

  const selectedTool = toolById[selectedToolId];
  const selectedOption = operationOptions.find((option) => option.tool === selectedToolId);
  const disabledReason = selectedOption?.unavailableReason ?? null;
  const selectedFiles = selectedTool.needsMultipleInputs
    ? form.inputs
    : form.input
      ? [form.input]
      : [];

  useEffect(() => {
    void refreshRuntime();
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyAppearance = () => {
      const resolved = appearance === "system" ? (media.matches ? "dark" : "light") : appearance;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.appearance = appearance;
      localStorage.setItem("appearance", appearance);
    };

    applyAppearance();
    void invokeCommand("set_appearance", { appearance });
    media.addEventListener("change", applyAppearance);
    return () => media.removeEventListener("change", applyAppearance);
  }, [appearance]);

  useEffect(() => {
    setForm(initialForm(selectedTool));
  }, [selectedTool]);

  useEffect(() => {
    const handleNativeToolSelected = (event: Event) => {
      const tool = (event as CustomEvent<{ tool?: AppView }>).detail?.tool;
      if (tool === "settings") {
        setActiveView("settings");
        return;
      }
      if (!tool || !toolById[tool]) return;
      setActiveView(tool);
      setSelectedToolId(tool);
    };

    window.addEventListener("native-tool-selected", handleNativeToolSelected);
    return () => window.removeEventListener("native-tool-selected", handleNativeToolSelected);
  }, []);

  useEffect(() => {
    const handleNativeSidebarVisibility = (event: Event) => {
      const collapsed = Boolean(
        (event as CustomEvent<{ collapsed?: boolean }>).detail?.collapsed,
      );
      setIsNativeSidebarCollapsed(collapsed);
    };

    window.addEventListener("native-sidebar-visibility", handleNativeSidebarVisibility);
    return () =>
      window.removeEventListener("native-sidebar-visibility", handleNativeSidebarVisibility);
  }, []);

  useEffect(() => {
    if (!isTauriRuntime()) return;

    let unlisten: (() => void) | undefined;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "over") {
          setIsDraggingFiles(true);
          return;
        }

        if (event.payload.type === "drop") {
          applySelectedFiles(event.payload.paths);
        }
        setIsDraggingFiles(false);
      })
      .then((listener) => {
        unlisten = listener;
      });

    return () => unlisten?.();
  }, [selectedToolId, form]);

  const dependencyList = useMemo(
    () =>
      dependencies
        ? [
            dependencies.qpdf,
            dependencies.ghostscript,
            dependencies.pdfRenderer,
            dependencies.libreoffice,
          ]
        : [],
    [dependencies],
  );

  async function refreshRuntime() {
    const [deps, options] = await Promise.all([
      invokeCommand<DependencySet>("get_dependencies"),
      invokeCommand<OperationOptions[]>("get_operation_options"),
    ]);
    setDependencies(deps);
    setOperationOptions(options);
  }

  async function pickFiles() {
    const picked = await open({
      title: `Choose files for ${selectedTool.title}`,
      multiple: selectedTool.needsMultipleInputs,
      filters: dialogFilters(selectedToolId),
      fileAccessMode: "scoped",
    });

    if (!picked) return;
    applySelectedFiles(Array.isArray(picked) ? picked : [picked]);
  }

  function applySelectedFiles(paths: string[]) {
    if (selectedTool.needsMultipleInputs) {
      setForm((current) => ({
        ...current,
        inputs: [...current.inputs, ...paths].filter(unique),
      }));
    } else {
      setForm((current) => ({ ...current, input: paths[0] ?? "" }));
    }
  }

  function removeFile(path: string) {
    if (selectedTool.needsMultipleInputs) {
      setForm((current) => ({
        ...current,
        inputs: current.inputs.filter((input) => input !== path),
      }));
    } else {
      setForm((current) => ({ ...current, input: "" }));
    }
  }

  async function submitJob(event: FormEvent) {
    event.preventDefault();
    const id = crypto.randomUUID();
    const request = buildRequest(id, selectedToolId, form);

    const newJob: JobState = {
      id,
      tool: selectedToolId,
      title: selectedTool.title,
      status: "running",
      message: "Generating to a temporary location",
    };
    setJobs((current) => [newJob, ...current]);

    try {
      const result = await invokeCommand<JobState["result"]>("execute_job", { request });
      setJobs((current) =>
        current.map((job) =>
          job.id === id
            ? { ...job, status: "complete", message: "Ready to save", result }
            : job,
        ),
      );
    } catch (error) {
      setJobs((current) =>
        current.map((job) =>
          job.id === id
            ? { ...job, status: "failed", message: String(error) }
            : job,
        ),
      );
    }
  }

  async function saveJobOutput(job: JobState) {
    if (!job.result || job.result.outputs.length === 0) return;

    if (job.result.outputs.length === 1) {
      const source = job.result.outputs[0];
      const destination = await save({
        title: `Save ${job.title}`,
        defaultPath: suggestedOutputName(job.tool, source),
        filters: outputFilters(job.tool),
      });
      if (!destination) return;
      await invokeCommand("save_output", { source, destination });
      markSaved(job.id, destination);
      return;
    }

    const folder = await open({
      title: `Choose folder for ${job.title} outputs`,
      directory: true,
      multiple: false,
      canCreateDirectories: true,
    });
    if (!folder || Array.isArray(folder)) return;

    for (const source of job.result.outputs) {
      await invokeCommand("save_output", {
        source,
        destination: `${folder}/${basename(source)}`,
      });
    }
    markSaved(job.id, folder);
  }

  function markSaved(jobId: string, _destination: string) {
    setJobs((current) =>
      current.map((job) => (job.id === jobId ? { ...job, message: "Saved" } : job)),
    );
  }

  const canRun = !disabledReason && selectedFiles.length > 0;
  const isSettingsView = activeView === "settings";

  return (
    <main className={`app-shell ${isNativeSidebarCollapsed ? "native-sidebar-collapsed" : ""}`}>
      <div className="window-drag-strip" data-tauri-drag-region />
      <section className="sidebar">
        <div className="brand" data-tauri-drag-region>
          <div>
            <h1>Local PDF Tool</h1>
          </div>
        </div>

        <div className="tool-list">
          {tools.map((tool) => {
            const Icon = tool.icon;
            const option = operationOptions.find((item) => item.tool === tool.id);
            const unavailable = Boolean(option?.unavailableReason);
            return (
              <button
                key={tool.id}
                className={`tool-button ${activeView === tool.id ? "selected" : ""}`}
                onClick={() => {
                  setSelectedToolId(tool.id);
                  setActiveView(tool.id);
                }}
                type="button"
              >
                <span className="tool-icon">
                  <Icon size={18} />
                </span>
                <span>
                  <strong>{tool.title}</strong>
                  {unavailable ? <small>Needs setup</small> : null}
                </span>
              </button>
            );
          })}
        </div>

        <button
          className={`tool-button settings-button ${isSettingsView ? "selected" : ""}`}
          onClick={() => setActiveView("settings")}
          type="button"
        >
          <span className="tool-icon">
            <Settings size={18} />
          </span>
          <span>
            <strong>Settings</strong>
          </span>
        </button>
      </section>

      <section className="workspace">
        <header className="topbar">
          <div data-tauri-drag-region>
            <h2>{isSettingsView ? "Settings" : selectedTool.title}</h2>
            <p>
              {isSettingsView
                ? "Appearance and runtime diagnostics."
                : selectedTool.description}
            </p>
          </div>
          <button className="icon-button" onClick={refreshRuntime} type="button" title="Refresh">
            <RefreshCw size={18} />
          </button>
        </header>

        {isSettingsView ? (
          <SettingsView
            appearance={appearance}
            dependencies={dependencyList}
            operationOptions={operationOptions}
            onAppearanceChange={setAppearance}
            onRefreshRuntime={refreshRuntime}
          />
        ) : (
        <div className="content-grid">
          <form className="tool-panel" onSubmit={submitJob}>
            {disabledReason ? (
              <div className="notice warning">
                <CircleAlert size={18} />
                <span>{availabilityMessage(disabledReason)}</span>
              </div>
            ) : null}

            <FileDropZone
              dragging={isDraggingFiles}
              files={selectedFiles}
              multiple={selectedTool.needsMultipleInputs}
              onPick={pickFiles}
              onRemove={removeFile}
              title={
                selectedTool.needsMultipleInputs
                  ? "Drop files here or choose files"
                  : "Drop a file here or choose a file"
              }
            />

            {selectedToolId === "splitPdf" || selectedToolId === "organizePdf" ? (
              <Field label={selectedToolId === "splitPdf" ? "Ranges" : "Page order"}>
                <input
                  value={form.ranges}
                  onChange={(event) => setForm({ ...form, ranges: event.target.value })}
                  placeholder="1, 3-5, 8"
                />
              </Field>
            ) : null}

            {selectedToolId === "splitPdf" ? (
              <Field label="Output pattern">
                <input
                  value={form.outputPattern}
                  onChange={(event) => setForm({ ...form, outputPattern: event.target.value })}
                />
              </Field>
            ) : null}

            {selectedToolId === "compressPdf" ? (
              <Field label="Compression profile">
                <select
                  value={form.profile}
                  onChange={(event) =>
                    setForm({ ...form, profile: event.target.value as FormState["profile"] })
                  }
                >
                  <option value="screen">Screen</option>
                  <option value="ebook">Ebook</option>
                  <option value="printer">Printer</option>
                  <option value="prepress">Prepress</option>
                </select>
              </Field>
            ) : null}

            {selectedToolId === "pdfToJpg" ? (
              <div className="inline-fields">
                <Field label="DPI">
                  <input
                    min={72}
                    max={600}
                    type="number"
                    value={form.dpi}
                    onChange={(event) => setForm({ ...form, dpi: Number(event.target.value) })}
                  />
                </Field>
                <Field label="JPG quality">
                  <input
                    min={1}
                    max={100}
                    type="number"
                    value={form.quality}
                    onChange={(event) =>
                      setForm({ ...form, quality: Number(event.target.value) })
                    }
                  />
                </Field>
              </div>
            ) : null}

            {selectedToolId === "jpgToPdf" ? (
              <div className="inline-fields">
                <Field label="Page size">
                  <select
                    value={form.pageSize}
                    onChange={(event) => setForm({ ...form, pageSize: event.target.value })}
                  >
                    <option value="auto">Auto</option>
                    <option value="a4">A4</option>
                    <option value="letter">Letter</option>
                  </select>
                </Field>
                <Field label="Fit mode">
                  <select
                    value={form.fitMode}
                    onChange={(event) => setForm({ ...form, fitMode: event.target.value })}
                  >
                    <option value="fit">Fit</option>
                    <option value="fill">Fill</option>
                  </select>
                </Field>
              </div>
            ) : null}

            {selectedToolId === "unlockPdf" ? (
              <Field label="Password">
                <input
                  type="password"
                  value={form.password}
                  onChange={(event) => setForm({ ...form, password: event.target.value })}
                />
              </Field>
            ) : null}

            {selectedToolId === "protectPdf" ? (
              <>
                <div className="inline-fields">
                  <Field label="User password">
                    <input
                      type="password"
                      value={form.userPassword}
                      onChange={(event) =>
                        setForm({ ...form, userPassword: event.target.value })
                      }
                    />
                  </Field>
                  <Field label="Owner password">
                    <input
                      type="password"
                      value={form.ownerPassword}
                      onChange={(event) =>
                        setForm({ ...form, ownerPassword: event.target.value })
                      }
                    />
                  </Field>
                </div>
                <div className="toggle-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={form.allowPrinting}
                      onChange={(event) =>
                        setForm({ ...form, allowPrinting: event.target.checked })
                      }
                    />
                    Allow printing
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.allowCopying}
                      onChange={(event) =>
                        setForm({ ...form, allowCopying: event.target.checked })
                      }
                    />
                    Allow copying
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={form.allowModification}
                      onChange={(event) =>
                        setForm({ ...form, allowModification: event.target.checked })
                      }
                    />
                    Allow modification
                  </label>
                </div>
              </>
            ) : null}

            <div className="notice">
              <FolderOpen size={18} />
              <span>Outputs are generated in a temporary location. Save them after the job finishes.</span>
            </div>

            <button className="run-button" type="submit" disabled={!canRun}>
              <Play size={18} />
              Run {selectedTool.title}
            </button>
          </form>

          <aside className="status-panel">
            <section>
              <div className="panel-heading">
                <h3>Jobs</h3>
                <RuntimeInfo dependencies={dependencyList} />
              </div>
              <div className="jobs">
                {jobs.length === 0 ? <p className="empty">No jobs yet</p> : null}
                {jobs.map((job) => (
                  <div className={`job ${job.status}`} key={job.id}>
                    <div>
                      <strong>{job.title}</strong>
                      <small>{job.message}</small>
                    </div>
                    {job.status === "running" ? <Loader2 className="spin" size={18} /> : null}
                    {job.result ? (
                      <>
                        <p className="job-output-summary">
                          {job.result.outputs.length === 1
                            ? "1 output file is ready"
                            : `${job.result.outputs.length} output files are ready`}
                        </p>
                        <button
                          className="save-button"
                          onClick={() => void saveJobOutput(job)}
                          type="button"
                        >
                          <Download size={16} />
                          Save...
                        </button>
                      </>
                    ) : null}
                  </div>
                ))}
              </div>
            </section>
          </aside>
        </div>
        )}
      </section>
    </main>
  );
}

function SettingsView({
  appearance,
  dependencies,
  operationOptions,
  onAppearanceChange,
  onRefreshRuntime,
}: {
  appearance: AppearanceMode;
  dependencies: DependencySet[keyof DependencySet][];
  operationOptions: OperationOptions[];
  onAppearanceChange: (appearance: AppearanceMode) => void;
  onRefreshRuntime: () => void;
}) {
  const runtimeRows = dependencies.length > 0 ? dependencies : [];
  const unavailableTools = operationOptions.filter((option) => option.unavailableReason);

  return (
    <div className="settings-grid">
      <section className="settings-panel">
        <div className="settings-heading">
          <h3>Appearance</h3>
        </div>
        <div className="segmented-control" aria-label="Appearance">
          {(["system", "light", "dark"] as AppearanceMode[]).map((mode) => (
            <button
              className={appearance === mode ? "selected" : ""}
              key={mode}
              onClick={() => onAppearanceChange(mode)}
              type="button"
            >
              {titleCase(mode)}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-panel runtime-debug-panel">
        <div className="settings-heading">
          <h3>Runtime Debug</h3>
          <button className="save-button compact" onClick={onRefreshRuntime} type="button">
            <RefreshCw size={15} />
            Refresh
          </button>
        </div>

        <div className="debug-table">
          {runtimeRows.map((dependency) => (
            <div className="debug-row" key={dependency.name}>
              <span>{dependency.name}</span>
              <strong>{dependency.available ? dependency.source : "unavailable"}</strong>
              <code>{dependency.command || "not found"}</code>
            </div>
          ))}
        </div>

        <div className="debug-block">
          <h4>Unavailable Tools</h4>
          {unavailableTools.length === 0 ? (
            <p>No unavailable tools reported.</p>
          ) : (
            unavailableTools.map((option) => (
              <p key={option.tool}>
                <strong>{toolById[option.tool].title}</strong>
                <span>{option.unavailableReason}</span>
              </p>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function FileDropZone({
  dragging,
  files,
  multiple,
  onPick,
  onRemove,
  title,
}: {
  dragging: boolean;
  files: string[];
  multiple: boolean;
  onPick: () => void;
  onRemove: (path: string) => void;
  title: string;
}) {
  return (
    <section className={`drop-zone ${dragging ? "dragging" : ""}`}>
      <button className="drop-action" onClick={onPick} type="button">
        <FilePlus2 size={24} />
        <span>{title}</span>
        <small>{multiple ? "Files stay in the order shown below" : "One file is used for this tool"}</small>
      </button>

      {files.length > 0 ? (
        <div className="selected-files">
          {files.map((path) => (
            <div className="selected-file" key={path}>
              <span>{basename(path)}</span>
              <small>{path}</small>
              <button onClick={() => onRemove(path)} title="Remove" type="button">
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function RuntimeInfo({ dependencies }: { dependencies: DependencySet[keyof DependencySet][] }) {
  const missingCount = dependencies.filter((dependency) => !dependency.available).length;
  const bundledCount = dependencies.filter((dependency) => dependency.source === "bundled").length;

  return (
    <div className="runtime-info">
      <button className="runtime-trigger" type="button" aria-label="Runtime details">
        <Info size={17} />
        <span>{missingCount > 0 ? `${missingCount} unavailable` : `${bundledCount} bundled`}</span>
      </button>
      <div className="runtime-popover" role="tooltip">
        {dependencies.map((dependency) => (
          <div className="dependency" key={dependency.name}>
            {dependency.available ? (
              <CheckCircle2 size={17} className="ok" />
            ) : (
              <CircleAlert size={17} className="missing" />
            )}
            <span>{dependency.name}</span>
            <small>
              {dependency.available ? `${dependency.source}: ${basename(dependency.command)}` : "not available"}
            </small>
          </div>
        ))}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function buildRequest(id: string, tool: ToolId, form: FormState) {
  const operation = (() => {
    switch (tool) {
      case "mergePdf":
        return { kind: "mergePdf", inputs: form.inputs };
      case "splitPdf":
        return {
          kind: "splitPdf",
          input: form.input,
          ranges: form.ranges,
          outputPattern: form.outputPattern,
        };
      case "organizePdf":
        return {
          kind: "organizePdf",
          input: form.input,
          pages: expandPages(form.ranges).map((sourcePage) => ({
            sourcePage,
            rotateDegrees: 0,
          })),
        };
      case "compressPdf":
        return { kind: "compressPdf", input: form.input, profile: form.profile };
      case "pdfToJpg":
        return {
          kind: "pdfToJpg",
          input: form.input,
          dpi: form.dpi,
          firstPage: null,
          lastPage: null,
          quality: form.quality,
        };
      case "jpgToPdf":
        return {
          kind: "jpgToPdf",
          inputs: form.inputs,
          pageSize: form.pageSize,
          fitMode: form.fitMode,
          marginMm: form.marginMm,
        };
      case "pptToPdf":
        return { kind: "pptToPdf", input: form.input };
      case "wordToPdf":
        return { kind: "wordToPdf", input: form.input };
      case "unlockPdf":
        return { kind: "unlockPdf", input: form.input, password: form.password };
      case "protectPdf":
        return {
          kind: "protectPdf",
          input: form.input,
          userPassword: form.userPassword,
          ownerPassword: form.ownerPassword,
          permissions: {
            allowPrinting: form.allowPrinting,
            allowCopying: form.allowCopying,
            allowModification: form.allowModification,
          },
        };
    }
  })();

  return {
    id,
    operation,
    output: null,
  };
}

function dialogFilters(tool: ToolId) {
  if (tool === "jpgToPdf") return [{ name: "Images", extensions: ["jpg", "jpeg"] }];
  if (tool === "pptToPdf") return [{ name: "Presentations", extensions: ["ppt", "pptx", "odp"] }];
  if (tool === "wordToPdf") return [{ name: "Documents", extensions: ["doc", "docx", "odt"] }];
  return [{ name: "PDF", extensions: ["pdf"] }];
}

function availabilityMessage(reason: string) {
  if (reason.toLowerCase().includes("planned")) return reason;
  return `${reason}. Install the required local engine, then refresh runtime.`;
}

function outputFilters(tool: ToolId) {
  if (tool === "pdfToJpg") return [{ name: "JPEG", extensions: ["jpg", "jpeg"] }];
  return [{ name: "PDF", extensions: ["pdf"] }];
}

function suggestedOutputName(tool: ToolId, source: string) {
  if (tool === "pdfToJpg") return basename(source);
  return `${toolById[tool].title.replace(/\s+/g, "-").toLowerCase()}.pdf`;
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function titleCase(value: string) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function unique(value: string, index: number, values: string[]) {
  return values.indexOf(value) === index;
}

function expandPages(value: string): number[] {
  return value
    .split(",")
    .flatMap((part) => {
      const trimmed = part.trim();
      if (!trimmed.includes("-")) return [Number(trimmed)];
      const [start, end] = trimmed.split("-").map(Number);
      return Array.from({ length: end - start + 1 }, (_, index) => start + index);
    })
    .filter((page) => Number.isInteger(page) && page > 0);
}
