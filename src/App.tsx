import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Download,
  FilePlus2,
  Home,
  Info,
  Loader2,
  RefreshCw,
  Settings,
  Copy,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { type CSSProperties, PointerEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import { invokeCommand, isTauriRuntime } from "./runtime";
import { toolById, tools, type ToolDefinition, type ToolId } from "./tools";
import type { DependencySet, JobResult, JobState, OperationOptions, PdfPreview } from "./types";

type AppearanceMode = "system" | "light" | "dark";
type AppView = ToolId | "home" | "history" | "settings";
type HistoryEntryKind = "opened" | "saved";
type HistoryEntry = {
  id: string;
  kind: HistoryEntryKind;
  tool: ToolId | null;
  path: string;
  createdAt: number;
};
type OrganizeItem = {
  id: string;
  sourcePage: number;
  rotateDegrees: number;
  thumbnail: string;
};

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

const RECENT_FILES_KEY = "pidef.recentFiles";
const HISTORY_KEY = "pidef.history";
const DEFAULT_VISIBLE_PAGES = 20;
const SHOW_ALL_PREVIEW_LIMIT = 65_535;

export function App() {
  const [selectedToolId, setSelectedToolId] = useState<ToolId>("mergePdf");
  const [activeView, setActiveView] = useState<AppView>("home");
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
  const [pdfPreview, setPdfPreview] = useState<PdfPreview | null>(null);
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [organizeItems, setOrganizeItems] = useState<OrganizeItem[]>([]);
  const [draggedOrganizeId, setDraggedOrganizeId] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<string[]>(() => readJson(RECENT_FILES_KEY, []));
  const [commandFiles, setCommandFiles] = useState<string[]>([]);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>(() =>
    readJson<HistoryEntry[]>(HISTORY_KEY, []).filter(
      (entry) => entry.kind === "opened" || entry.kind === "saved",
    ),
  );
  const [previewVisibleCount, setPreviewVisibleCount] = useState(DEFAULT_VISIBLE_PAGES);
  const [isAddFileMenuOpen, setIsAddFileMenuOpen] = useState(false);

  const selectedTool = toolById[selectedToolId];
  const selectedOption = operationOptions.find((option) => option.tool === selectedToolId);
  const disabledReason = selectedOption?.unavailableReason ?? null;
  const selectedFiles = selectedTool.needsMultipleInputs
    ? form.inputs
    : form.input
      ? [form.input]
      : [];
  const hasSelectedFiles = selectedFiles.length > 0;

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
    const input = selectedFiles[0];
    if (!input || !isPdfPreviewTool(selectedToolId)) {
      setPdfPreview(null);
      setOrganizeItems([]);
      setPreviewError(null);
      return;
    }

    let isCancelled = false;
    setIsPreviewLoading(true);
    setPreviewError(null);
    void invokeCommand<PdfPreview>("get_pdf_preview", {
      request: {
        input,
        ...(selectedToolId === "organizePdf"
          ? {}
          : { maxPages: Math.min(previewVisibleCount, SHOW_ALL_PREVIEW_LIMIT) }),
        width: selectedToolId === "organizePdf" ? 180 : 220,
        quality: 74,
      },
    })
      .then((preview) => {
        if (isCancelled) return;
        setPdfPreview(preview);
        if (selectedToolId === "organizePdf") {
          setOrganizeItems(
            preview.pages.map((page) => ({
              id: `page-${page.pageNumber}`,
              sourcePage: page.pageNumber,
              rotateDegrees: 0,
              thumbnail: page.dataUrl,
            })),
          );
        }
      })
      .catch((error) => {
        if (isCancelled) return;
        setPdfPreview(null);
        setOrganizeItems([]);
        setPreviewError(String(error));
      })
      .finally(() => {
        if (!isCancelled) setIsPreviewLoading(false);
      });

    return () => {
      isCancelled = true;
    };
  }, [selectedToolId, selectedFiles.join("|"), previewVisibleCount]);

  useEffect(() => {
    localStorage.setItem(RECENT_FILES_KEY, JSON.stringify(recentFiles.slice(0, 12)));
  }, [recentFiles]);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(historyEntries.slice(0, 50)));
  }, [historyEntries]);

  useEffect(() => {
    const handleNativeToolSelected = (event: Event) => {
      const tool = (event as CustomEvent<{ tool?: AppView }>).detail?.tool;
      if (tool === "home" || tool === "settings" || tool === "history") {
        setActiveView(tool);
        return;
      }
      if (!tool || !toolById[tool]) return;
      activateTool(tool);
    };

    window.addEventListener("native-tool-selected", handleNativeToolSelected);
    return () => window.removeEventListener("native-tool-selected", handleNativeToolSelected);
  }, [activeView]);

  useEffect(() => {
    const syncNativeSidebarState = () => {
      const nativeSidebar = document.body.dataset.nativeSidebar;
      if (nativeSidebar === "collapsed" || nativeSidebar === "expanded") {
        setIsNativeSidebarCollapsed(nativeSidebar === "collapsed");
      }
    };

    const handleNativeSidebarVisibility = (event: Event) => {
      const collapsed = Boolean(
        (event as CustomEvent<{ collapsed?: boolean }>).detail?.collapsed,
      );
      setIsNativeSidebarCollapsed(collapsed);
    };

    syncNativeSidebarState();
    window.addEventListener("native-shell-ready", syncNativeSidebarState);
    window.addEventListener("native-sidebar-visibility", handleNativeSidebarVisibility);
    return () => {
      window.removeEventListener("native-shell-ready", syncNativeSidebarState);
      window.removeEventListener("native-sidebar-visibility", handleNativeSidebarVisibility);
    };
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
          if (event.payload.paths.length > 0) {
            applySelectedFiles(event.payload.paths);
          }
        }
        setIsDraggingFiles(false);
      })
      .then((listener) => {
        unlisten = listener;
      });

    return () => unlisten?.();
  }, [activeView, selectedToolId, form]);

  const dependencyList = useMemo(
    () =>
      dependencies
        ? [dependencies.qpdf, dependencies.pdfRenderer, dependencies.libreoffice]
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

  async function pickCommandCenterFiles() {
    const picked = await open({
      title: "Choose files for Pidef",
      multiple: true,
      filters: commandCenterFilters(),
      fileAccessMode: "scoped",
    });

    if (!picked) return;
    applyCommandCenterFiles(Array.isArray(picked) ? picked : [picked]);
  }

  function activateTool(toolId: ToolId, paths: string[] = []) {
    const tool = toolById[toolId];
    const nextForm = initialForm(tool);
    if (paths.length > 0) {
      if (tool.needsMultipleInputs) {
        nextForm.inputs = paths.filter(unique);
      } else {
        nextForm.input = paths[0] ?? "";
      }
    }

    setSelectedToolId(toolId);
    setActiveView(toolId);
    setForm(nextForm);
    setPdfPreview(null);
    setOrganizeItems([]);
    setPreviewError(null);
    setPreviewVisibleCount(DEFAULT_VISIBLE_PAGES);
    setIsAddFileMenuOpen(false);
  }

  function applyCommandCenterFiles(paths: string[]) {
    if (paths.length === 0) return;
    const nextFiles = paths.filter(unique);
    rememberOpenedFiles(nextFiles, null);
    setActiveView("home");
    setCommandFiles(nextFiles);
  }

  function applySelectedFiles(paths: string[]) {
    if (paths.length === 0) return;

    if (activeView === "home" || activeView === "history" || activeView === "settings") {
      applyCommandCenterFiles(paths);
      return;
    }

    rememberOpenedFiles(paths);

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

  function removeCommandFile(path: string) {
    setCommandFiles((current) => current.filter((input) => input !== path));
  }

  function rotateOrganizeItem(id: string) {
    setOrganizeItems((current) =>
      current.map((item) =>
        item.id === id ? { ...item, rotateDegrees: (item.rotateDegrees + 90) % 360 } : item,
      ),
    );
  }

  function duplicateOrganizeItem(id: string) {
    setOrganizeItems((current) => {
      const index = current.findIndex((item) => item.id === id);
      if (index < 0) return current;
      const copy = { ...current[index], id: `${current[index].id}-copy-${crypto.randomUUID()}` };
      return [...current.slice(0, index + 1), copy, ...current.slice(index + 1)];
    });
  }

  function deleteOrganizeItem(id: string) {
    setOrganizeItems((current) => current.filter((item) => item.id !== id));
  }

  function moveOrganizeItem(sourceId: string, targetId: string) {
    if (sourceId === targetId) return;
    setOrganizeItems((current) => {
      const sourceIndex = current.findIndex((item) => item.id === sourceId);
      const targetIndex = current.findIndex((item) => item.id === targetId);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(sourceIndex, 1);
      next.splice(targetIndex, 0, moved);
      return next;
    });
  }

  async function runSelectedJob() {
    if (!canRunSelectedTool) return;

    const id = crypto.randomUUID();
    const request = buildRequest(id, selectedToolId, form, organizeItems);

    const newJob: JobState = {
      id,
      tool: selectedToolId,
      title: selectedTool.title,
      status: "running",
      message: "Generating to a temporary location",
    };
    setJobs((current) => [newJob, ...current]);

    try {
      const result = await invokeCommand<JobResult>("execute_job", { request });
      const completeMessage = jobCompleteMessage(selectedToolId, result);
      setJobs((current) =>
        current.map((job) =>
          job.id === id
            ? {
                ...job,
                status: "complete",
                message: completeMessage,
                result,
              }
            : job,
        ),
      );
      const completedJob: JobState = {
        ...newJob,
        status: "complete",
        message: completeMessage,
        result,
      };
      const saved = await saveJobOutput(completedJob);
      if (!saved) {
        setJobs((current) =>
          current.map((job) =>
            job.id === id ? { ...job, message: "Ready to save." } : job,
          ),
        );
      }
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

  async function saveJobOutput(job: JobState): Promise<boolean> {
    if (!job.result || job.result.outputs.length === 0) return false;

    if (job.result.outputs.length === 1) {
      const source = job.result.outputs[0];
      const destination = await save({
        title: `Save As ${job.title}`,
        defaultPath: suggestedOutputName(job.tool, source),
        filters: outputFilters(job.tool),
      });
      if (!destination) return false;
      await invokeCommand("save_output", { source, destination });
      markSaved(job.id, destination, job.tool);
      return true;
    }

    const folder = await open({
      title: `Choose Save As folder for ${job.title} outputs`,
      directory: true,
      multiple: false,
      canCreateDirectories: true,
    });
    if (!folder || Array.isArray(folder)) return false;

    for (const source of job.result.outputs) {
      await invokeCommand("save_output", {
        source,
        destination: `${folder}/${basename(source)}`,
      });
    }
    markSaved(job.id, folder, job.tool);
    return true;
  }

  async function saveAsCurrentOutput() {
    if (latestVisibleJob?.result) {
      await saveJobOutput(latestVisibleJob);
      return;
    }

    await runSelectedJob();
  }

  function markSaved(jobId: string, _destination: string, tool: ToolId | null) {
    setJobs((current) =>
      current.map((job) =>
        job.id === jobId ? { ...job, message: `Saved as ${basename(_destination)}.` } : job,
      ),
    );
    if (_destination) {
      addHistoryEntries([{ kind: "saved", path: _destination, tool }]);
    }
  }

  function rememberOpenedFiles(paths: string[], tool: ToolId | null = selectedToolId) {
    setRecentFiles((current) => [...paths, ...current].filter(unique).slice(0, 12));
    addHistoryEntries(paths.map((path) => ({ kind: "opened", path, tool })));
  }

  function addHistoryEntries(entries: Array<Omit<HistoryEntry, "id" | "createdAt">>) {
    if (entries.length === 0) return;
    const timestamp = Date.now();
    setHistoryEntries((current) =>
      [
        ...entries.map((entry, index) => ({
          ...entry,
          id: `${timestamp}-${index}-${entry.kind}`,
          createdAt: timestamp - index,
        })),
        ...current,
      ].slice(0, 50),
    );
  }

  const canRun = !disabledReason && selectedFiles.length > 0;
  const canRunSelectedTool =
    selectedToolId === "organizePdf" ? canRun && organizeItems.length > 0 : canRun;
  const isSettingsView = activeView === "settings";
  const isHomeView = activeView === "home";
  const latestVisibleJob = jobs.find((job) => job.tool === selectedToolId) ?? jobs[0] ?? null;

  return (
    <main className={`app-shell ${isNativeSidebarCollapsed ? "native-sidebar-collapsed" : ""}`}>
      <div className="window-drag-strip" data-tauri-drag-region />
      <section className="sidebar">
        <div className="brand" data-tauri-drag-region>
          <div>
            <h1>Pidef</h1>
          </div>
        </div>

        <div className="tool-list">
          <button
            className={`tool-button ${isHomeView ? "selected" : ""}`}
            onClick={() => setActiveView("home")}
            type="button"
          >
            <span className="tool-icon">
              <Home size={18} />
            </span>
            <span>
              <strong>Home</strong>
            </span>
          </button>

          <div className="tool-section-label">Tools</div>

          {tools.map((tool) => {
            const Icon = tool.icon;
            const option = operationOptions.find((item) => item.tool === tool.id);
            const unavailable = Boolean(option?.unavailableReason);
            return (
              <button
                key={tool.id}
                className={`tool-button ${activeView === tool.id ? "selected" : ""}`}
                onClick={() => activateTool(tool.id)}
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
          className={`tool-button history-button ${activeView === "history" ? "selected" : ""}`}
          onClick={() => setActiveView("history")}
          type="button"
        >
          <span className="tool-icon">
            <Clock3 size={18} />
          </span>
          <span>
            <strong>History</strong>
          </span>
        </button>

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
            <h2>
              {isHomeView
                ? "Pidef"
                : activeView === "history"
                ? "History"
                : isSettingsView
                  ? "Settings"
                  : selectedTool.title}
            </h2>
            <p>
              {isHomeView
                ? "Drop files, choose an action, and keep moving."
                : activeView === "history"
                ? "Recent work, opened files, and saved outputs."
                : isSettingsView
                ? "Appearance and runtime diagnostics."
                : selectedTool.description}
            </p>
          </div>
          <button className="icon-button" onClick={refreshRuntime} type="button" title="Refresh">
            <RefreshCw size={18} />
          </button>
        </header>

        {isHomeView ? (
          <HomeView
            dragging={isDraggingFiles}
            files={commandFiles}
            operationOptions={operationOptions}
            recentFiles={recentFiles}
            onOpenFile={(path) => applyCommandCenterFiles([path])}
            onPickFiles={pickCommandCenterFiles}
            onRemoveFile={removeCommandFile}
            onSelectTool={(toolId) => activateTool(toolId, commandFiles)}
          />
        ) : activeView === "history" ? (
          <HistoryView
            entries={historyEntries}
            onOpenFile={(path) => applySelectedFiles([path])}
          />
        ) : isSettingsView ? (
          <SettingsView
            appearance={appearance}
            dependencies={dependencyList}
            operationOptions={operationOptions}
            onAppearanceChange={setAppearance}
            onRefreshRuntime={refreshRuntime}
          />
        ) : (
          <div className="workbench" style={{ "--tool-accent": selectedTool.accent } as CSSProperties}>
            <section className={hasSelectedFiles ? "preview-stage" : "empty-stage"}>
              {!hasSelectedFiles ? (
                <>
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
                  <RecentFiles files={recentFiles} onOpenFile={(path) => applySelectedFiles([path])} />
                </>
              ) : selectedToolId === "organizePdf" ? (
                <OrganizeBoard
                  items={organizeItems}
                  isLoading={isPreviewLoading}
                  error={previewError}
                  draggedId={draggedOrganizeId}
                  pageCount={pdfPreview?.pageCount ?? 0}
                  visibleCount={previewVisibleCount}
                  onDelete={deleteOrganizeItem}
                  onDuplicate={duplicateOrganizeItem}
                  onDragEnd={() => setDraggedOrganizeId(null)}
                  onDragStart={setDraggedOrganizeId}
                  onMove={moveOrganizeItem}
                  onRotate={rotateOrganizeItem}
                  onShowAll={() => setPreviewVisibleCount(SHOW_ALL_PREVIEW_LIMIT)}
                  onShowMore={() =>
                    setPreviewVisibleCount((current) => current + DEFAULT_VISIBLE_PAGES)
                  }
                />
              ) : isPdfPreviewTool(selectedToolId) ? (
                <PdfPreviewGrid
                  preview={pdfPreview}
                  isLoading={isPreviewLoading}
                  error={previewError}
                  visibleCount={previewVisibleCount}
                  onShowAll={() => setPreviewVisibleCount(SHOW_ALL_PREVIEW_LIMIT)}
                  onShowMore={() =>
                    setPreviewVisibleCount((current) => current + DEFAULT_VISIBLE_PAGES)
                  }
                />
              ) : (
                <SelectedFileStage files={selectedFiles} />
              )}
            </section>

            <aside className="options-panel">
              <div className="panel-heading">
                <h3>Options</h3>
                <RuntimeInfo dependencies={dependencyList} />
              </div>

              {disabledReason ? (
                <div className="notice warning">
                  <CircleAlert size={18} />
                  <span>{availabilityMessage(disabledReason)}</span>
                </div>
              ) : null}

              {hasSelectedFiles ? (
                <SelectedFilesPanel
                  files={selectedFiles}
                  multiple={selectedTool.needsMultipleInputs}
                  recentFiles={recentFiles.slice(0, 5)}
                  onAddFile={pickFiles}
                  onOpenFile={pickFiles}
                  onPickRecentFile={(path) => applySelectedFiles([path])}
                  onRemove={removeFile}
                  isAddFileMenuOpen={isAddFileMenuOpen}
                  onAddFileMenuOpenChange={setIsAddFileMenuOpen}
                />
              ) : (
                <button className="save-button" onClick={pickFiles} type="button">
                  <FilePlus2 size={16} />
                  Open...
                </button>
              )}

              <OperationFields selectedToolId={selectedToolId} form={form} onChange={setForm} />

              <button
                className="run-button"
                type="button"
                disabled={!canRunSelectedTool}
                onClick={() => void saveAsCurrentOutput()}
              >
                <Download size={16} />
                Save As...
              </button>
              <CurrentJobStatus job={latestVisibleJob} />
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

function HomeView({
  dragging,
  files,
  operationOptions,
  recentFiles,
  onOpenFile,
  onPickFiles,
  onRemoveFile,
  onSelectTool,
}: {
  dragging: boolean;
  files: string[];
  operationOptions: OperationOptions[];
  recentFiles: string[];
  onOpenFile: (path: string) => void;
  onPickFiles: () => void;
  onRemoveFile: (path: string) => void;
  onSelectTool: (tool: ToolId) => void;
}) {
  const suggestions = commandCenterSuggestions(files);

  return (
    <section className="home-screen">
      <section className={`home-drop-zone ${dragging ? "dragging" : ""}`}>
        <button className="home-drop-action" onClick={onPickFiles} type="button">
          <FilePlus2 size={28} />
          <span>{files.length > 0 ? "Add or replace files" : "Drop files here or choose files"}</span>
          <small>
            {files.length > 0
              ? `${files.length} ${files.length === 1 ? "file" : "files"} ready`
              : "PDF, JPG, Word, and PowerPoint files are supported"}
          </small>
        </button>

        {files.length > 0 ? (
          <div className="selected-files">
            {files.map((path) => (
              <div className="selected-file" key={path}>
                <span>{basename(path)}</span>
                <small>{path}</small>
                <button onClick={() => onRemoveFile(path)} title="Remove" type="button">
                  <X size={14} />
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </section>

      <section className="home-section">
        <div className="home-section-heading">
          <h3>{files.length > 0 ? "Suggested Actions" : "Start With"}</h3>
          <span>{files.length > 0 ? "Based on selected files" : "Common PDF workflows"}</span>
        </div>

        <div className="home-action-grid">
          {suggestions.map((toolId) => {
            const tool = toolById[toolId];
            const Icon = tool.icon;
            const unavailableReason = operationOptions.find(
              (option) => option.tool === toolId,
            )?.unavailableReason;

            return (
              <button
                className="home-action"
                disabled={Boolean(unavailableReason)}
                key={toolId}
                onClick={() => onSelectTool(toolId)}
                style={{ "--tool-accent": tool.accent } as CSSProperties}
                type="button"
              >
                <span className="tool-icon">
                  <Icon size={18} />
                </span>
                <span>
                  <strong>{tool.title}</strong>
                  <small>{unavailableReason ? "Needs setup" : tool.description}</small>
                </span>
                <ArrowRight size={17} />
                <Icon className="home-action-watermark" size={82} strokeWidth={1.15} />
              </button>
            );
          })}
        </div>
      </section>

      {recentFiles.length > 0 ? (
        <section className="home-section">
          <div className="home-section-heading">
            <h3>Recent Files</h3>
            <span>Open one in the Command Center</span>
          </div>
          <div className="recent-list">
            {recentFiles.slice(0, 8).map((path) => (
              <button className="recent-file" key={path} onClick={() => onOpenFile(path)} type="button">
                <strong>{basename(path)}</strong>
                <small>{path}</small>
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </section>
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

function HistoryView({
  entries,
  onOpenFile,
}: {
  entries: HistoryEntry[];
  onOpenFile: (path: string) => void;
}) {
  return (
    <section className="history-feed" aria-label="Activity history">
      {entries.length === 0 ? <p className="empty">No recent activity yet</p> : null}
      <div className="history-list">
        {entries.map((entry) => (
          <button
            className="history-row"
            key={entry.id}
            onClick={() => onOpenFile(entry.path)}
            type="button"
          >
            <span>{historyLabel(entry)}</span>
            <strong>{basename(entry.path)}</strong>
            <small>{entry.path}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function RecentFiles({ files, onOpenFile }: { files: string[]; onOpenFile: (path: string) => void }) {
  if (files.length === 0) return null;

  return (
    <section className="recent-panel">
      <div className="panel-heading">
        <h3>Recently Opened</h3>
      </div>
      <div className="recent-list">
        {files.map((path) => (
          <button className="recent-file" key={path} onClick={() => onOpenFile(path)} type="button">
            <strong>{basename(path)}</strong>
            <small>{path}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function SelectedFilesPanel({
  files,
  multiple,
  recentFiles,
  onAddFile,
  onOpenFile,
  onPickRecentFile,
  onRemove,
  isAddFileMenuOpen,
  onAddFileMenuOpenChange,
}: {
  files: string[];
  multiple: boolean;
  recentFiles: string[];
  onAddFile: () => void;
  onOpenFile: () => void;
  onPickRecentFile: (path: string) => void;
  onRemove: (path: string) => void;
  isAddFileMenuOpen: boolean;
  onAddFileMenuOpenChange: (isOpen: boolean) => void;
}) {
  return (
    <section className="side-section">
      <div className="panel-heading">
        <h3>{multiple ? "Files" : "File"}</h3>
        {!multiple ? (
          <button className="save-button compact" onClick={onOpenFile} type="button">
            <FilePlus2 size={15} />
            Open...
          </button>
        ) : null}
        {multiple ? (
          <div className="menu-wrap">
            <button
              className="icon-button compact"
              onClick={() => onAddFileMenuOpenChange(!isAddFileMenuOpen)}
              title="Add file"
              type="button"
            >
              <FilePlus2 size={15} />
            </button>
            {isAddFileMenuOpen ? (
              <div className="file-menu">
                <button
                  onClick={() => {
                    onAddFileMenuOpenChange(false);
                    onAddFile();
                  }}
                  type="button"
                >
                  Choose file...
                </button>
                {recentFiles.map((path) => (
                  <button
                    key={path}
                    onClick={() => {
                      onAddFileMenuOpenChange(false);
                      onPickRecentFile(path);
                    }}
                    type="button"
                  >
                    <span>{basename(path)}</span>
                    <small>{path}</small>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="file-name-field">
        <span>File name</span>
        <strong>{files.length === 1 ? basename(files[0]) : `${files.length} files selected`}</strong>
      </div>
      <div className="selected-files compact-list">
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
    </section>
  );
}

function SelectedFileStage({ files }: { files: string[] }) {
  return (
    <section className="selected-stage">
      <div className="preview-heading">
        <strong>Selected files</strong>
        <span>{files.length === 1 ? "1 file" : `${files.length} files`}</span>
      </div>
      <div className="stage-file-list">
        {files.map((path, index) => (
          <div className="stage-file" key={path}>
            <span>{index + 1}</span>
            <strong>{basename(path)}</strong>
            <small>{path}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function CurrentJobStatus({ job }: {
  job: JobState | null;
}) {
  if (!job || job.status === "complete") return null;

  return (
    <section className={`current-job ${job.status}`}>
      <div>
        <strong>{job.title}</strong>
        <small>{job.message}</small>
      </div>
      {job.status === "running" ? <Loader2 className="spin" size={16} /> : null}
      {job.result ? (
        <p className="job-output-summary">
          {job.result.outputs.length === 1
            ? "1 output file is ready"
            : `${job.result.outputs.length} output files are ready`}
        </p>
      ) : null}
    </section>
  );
}

function OperationFields({
  selectedToolId,
  form,
  onChange,
}: {
  selectedToolId: ToolId;
  form: FormState;
  onChange: (form: FormState) => void;
}) {
  return (
    <section className="side-section">
      {selectedToolId === "splitPdf" ? (
        <>
          <Field label="Ranges">
            <input
              value={form.ranges}
              onChange={(event) => onChange({ ...form, ranges: event.target.value })}
              placeholder="1, 3-5, 8"
            />
          </Field>
          <Field label="Output pattern">
            <input
              value={form.outputPattern}
              onChange={(event) => onChange({ ...form, outputPattern: event.target.value })}
            />
          </Field>
        </>
      ) : null}

      {selectedToolId === "compressPdf" ? (
        <Field label="Compression profile">
          <select
            value={form.profile}
            onChange={(event) =>
              onChange({ ...form, profile: event.target.value as FormState["profile"] })
            }
          >
            <option value="safe">Safe — lossless optimization</option>
            <option value="balanced">Balanced — recommended</option>
            <option value="small">Small — softest images</option>
          </select>
        </Field>
      ) : null}

      {selectedToolId === "pdfToJpg" ? (
        <div className="inline-fields stacked">
          <Field label="DPI">
            <input
              min={72}
              max={600}
              type="number"
              value={form.dpi}
              onChange={(event) => onChange({ ...form, dpi: Number(event.target.value) })}
            />
          </Field>
          <Field label="JPG quality">
            <input
              min={1}
              max={100}
              type="number"
              value={form.quality}
              onChange={(event) => onChange({ ...form, quality: Number(event.target.value) })}
            />
          </Field>
        </div>
      ) : null}

      {selectedToolId === "jpgToPdf" ? (
        <div className="inline-fields stacked">
          <Field label="Page size">
            <select
              value={form.pageSize}
              onChange={(event) => onChange({ ...form, pageSize: event.target.value })}
            >
              <option value="auto">Auto</option>
              <option value="a4">A4</option>
              <option value="letter">Letter</option>
            </select>
          </Field>
          <Field label="Fit mode">
            <select
              value={form.fitMode}
              onChange={(event) => onChange({ ...form, fitMode: event.target.value })}
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
            onChange={(event) => onChange({ ...form, password: event.target.value })}
          />
        </Field>
      ) : null}

      {selectedToolId === "protectPdf" ? (
        <>
          <Field label="User password">
            <input
              type="password"
              value={form.userPassword}
              onChange={(event) => onChange({ ...form, userPassword: event.target.value })}
            />
          </Field>
          <Field label="Owner password">
            <input
              type="password"
              value={form.ownerPassword}
              onChange={(event) => onChange({ ...form, ownerPassword: event.target.value })}
            />
          </Field>
          <div className="toggle-row stacked">
            <label>
              <input
                type="checkbox"
                checked={form.allowPrinting}
                onChange={(event) => onChange({ ...form, allowPrinting: event.target.checked })}
              />
              Allow printing
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.allowCopying}
                onChange={(event) => onChange({ ...form, allowCopying: event.target.checked })}
              />
              Allow copying
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.allowModification}
                onChange={(event) => onChange({ ...form, allowModification: event.target.checked })}
              />
              Allow modification
            </label>
          </div>
        </>
      ) : null}
    </section>
  );
}

function PdfPreviewGrid({
  preview,
  isLoading,
  error,
  visibleCount,
  onShowAll,
  onShowMore,
}: {
  preview: PdfPreview | null;
  isLoading: boolean;
  error: string | null;
  visibleCount: number;
  onShowAll: () => void;
  onShowMore: () => void;
}) {
  if (isLoading) {
    return (
      <section className="preview-panel">
        <div className="preview-loading">
          <Loader2 className="spin" size={18} />
          <span>Rendering preview</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="preview-panel">
        <div className="notice warning">
          <CircleAlert size={18} />
          <span>{error}</span>
        </div>
      </section>
    );
  }

  if (!preview) return null;
  const visiblePages = preview.pages.slice(0, visibleCount);
  const canShowMore = visiblePages.length < preview.pageCount;

  return (
    <section className="preview-panel">
      <div className="preview-heading">
        <strong>Preview</strong>
        <span>
          {preview.pageCount === 1 ? "1 page" : `${preview.pageCount} pages`}
          {preview.pages.length < preview.pageCount ? `, showing first ${preview.pages.length}` : ""}
        </span>
      </div>
      <div className="preview-grid">
        {visiblePages.map((page) => (
          <figure className="preview-thumb" key={page.pageNumber}>
            <img alt={`Page ${page.pageNumber}`} src={page.dataUrl} />
            <figcaption>{page.pageNumber}</figcaption>
          </figure>
        ))}
      </div>
      {canShowMore ? (
        <div className="preview-actions">
          <button className="save-button compact" onClick={onShowMore} type="button">
            Show more
          </button>
          <button className="save-button compact" onClick={onShowAll} type="button">
            Show all
          </button>
        </div>
      ) : null}
    </section>
  );
}

function OrganizeBoard({
  items,
  isLoading,
  error,
  draggedId,
  pageCount,
  visibleCount,
  onDelete,
  onDuplicate,
  onDragEnd,
  onDragStart,
  onMove,
  onRotate,
  onShowAll,
  onShowMore,
}: {
  items: OrganizeItem[];
  isLoading: boolean;
  error: string | null;
  draggedId: string | null;
  pageCount: number;
  visibleCount: number;
  onDelete: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDragEnd: () => void;
  onDragStart: (id: string) => void;
  onMove: (sourceId: string, targetId: string) => void;
  onRotate: (id: string) => void;
  onShowAll: () => void;
  onShowMore: () => void;
}) {
  function startPageDrag(event: PointerEvent<HTMLElement>, id: string) {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    onDragStart(id);
  }

  function moveOverPage(event: PointerEvent<HTMLElement>, targetId: string) {
    event.stopPropagation();
    if (draggedId) onMove(draggedId, targetId);
  }

  function endPageDrag(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
    onDragEnd();
  }

  if (isLoading) {
    return (
      <section className="organize-panel">
        <div className="preview-loading">
          <Loader2 className="spin" size={18} />
          <span>Rendering page thumbnails</span>
        </div>
      </section>
    );
  }

  if (error) {
    return (
      <section className="organize-panel">
        <div className="notice warning">
          <CircleAlert size={18} />
          <span>{error}</span>
        </div>
      </section>
    );
  }

  if (items.length === 0) return null;
  const visibleItems = items.slice(0, visibleCount);
  const canShowMore = visibleItems.length < items.length;

  return (
    <section className="organize-panel" onPointerLeave={onDragEnd} onPointerUp={onDragEnd}>
      <div className="preview-heading">
        <strong>Organize pages</strong>
        <span>
          {items.length} selected from {pageCount} pages
        </span>
      </div>
      <div className="organize-grid">
        {visibleItems.map((item, index) => (
          <article
            className={`organize-card ${draggedId === item.id ? "dragging" : ""}`}
            key={item.id}
            onPointerCancel={endPageDrag}
            onPointerDown={(event) => startPageDrag(event, item.id)}
            onPointerEnter={(event) => moveOverPage(event, item.id)}
            onPointerUp={endPageDrag}
          >
            <div className="organize-thumb">
              <img
                alt={`Page ${item.sourcePage}`}
                draggable={false}
                src={item.thumbnail}
                style={{ transform: `rotate(${item.rotateDegrees}deg)` }}
              />
            </div>
            <div className="organize-card-footer">
              <span>
                {index + 1}. Page {item.sourcePage}
              </span>
              {item.rotateDegrees ? <small>{item.rotateDegrees} deg</small> : null}
            </div>
            <div className="organize-actions">
              <button onClick={() => onRotate(item.id)} title="Rotate" type="button">
                <RotateCw size={15} />
              </button>
              <button onClick={() => onDuplicate(item.id)} title="Duplicate" type="button">
                <Copy size={15} />
              </button>
              <button onClick={() => onDelete(item.id)} title="Delete" type="button">
                <Trash2 size={15} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {canShowMore ? (
        <div className="preview-actions">
          <button className="save-button compact" onClick={onShowMore} type="button">
            Show more
          </button>
          <button className="save-button compact" onClick={onShowAll} type="button">
            Show all
          </button>
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

function buildRequest(
  id: string,
  tool: ToolId,
  form: FormState,
  organizeItems: OrganizeItem[],
) {
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
          pages: organizeItems.map((item) => ({
            sourcePage: item.sourcePage,
            rotateDegrees: item.rotateDegrees,
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

function commandCenterFilters() {
  return [
    { name: "Supported Files", extensions: ["pdf", "jpg", "jpeg", "doc", "docx", "odt", "ppt", "pptx", "odp"] },
    { name: "PDF", extensions: ["pdf"] },
    { name: "Images", extensions: ["jpg", "jpeg"] },
    { name: "Documents", extensions: ["doc", "docx", "odt"] },
    { name: "Presentations", extensions: ["ppt", "pptx", "odp"] },
  ];
}

function commandCenterSuggestions(files: string[]): ToolId[] {
  if (files.length === 0) {
    return ["mergePdf", "organizePdf", "splitPdf", "jpgToPdf"];
  }

  if (files.every(hasPdfExtension)) {
    if (files.length > 1) return ["mergePdf", "organizePdf", "splitPdf", "pdfToJpg"];
    return ["organizePdf", "splitPdf", "pdfToJpg", "protectPdf", "unlockPdf", "compressPdf"];
  }

  if (files.every(hasJpgExtension)) return ["jpgToPdf"];
  if (files.length === 1 && hasPresentationExtension(files[0])) return ["pptToPdf"];
  if (files.length === 1 && hasDocumentExtension(files[0])) return ["wordToPdf"];

  return ["mergePdf", "jpgToPdf", "wordToPdf", "pptToPdf"];
}

function availabilityMessage(reason: string) {
  if (reason.toLowerCase().includes("planned")) return reason;
  return `${reason}. Install the required local engine, then refresh runtime.`;
}

function isPdfPreviewTool(tool: ToolId) {
  return [
    "mergePdf",
    "splitPdf",
    "organizePdf",
    "compressPdf",
    "pdfToJpg",
    "unlockPdf",
    "protectPdf",
  ].includes(tool);
}

function outputFilters(tool: ToolId) {
  if (tool === "pdfToJpg") return [{ name: "JPEG", extensions: ["jpg", "jpeg"] }];
  return [{ name: "PDF", extensions: ["pdf"] }];
}

function jobCompleteMessage(tool: ToolId, result: JobResult) {
  if (tool === "compressPdf" && result.inputBytes && result.outputBytes) {
    const original = formatBytes(result.inputBytes);
    const compressed = formatBytes(result.outputBytes);
    if (result.outputBytes < result.inputBytes) {
      const percent = Math.max(1, Math.round((1 - result.outputBytes / result.inputBytes) * 100));
      return `Reduced ${original} to ${compressed} (${percent}% smaller). Choose where to save it.`;
    }
    return `Result is ${compressed} — about the same as the original ${original}. Choose where to save it.`;
  }
  return "Generated. Choose where to save it.";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unit = "B";
  for (const next of units) {
    if (value < 1024) break;
    value /= 1024;
    unit = next;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${unit}`;
}

function suggestedOutputName(tool: ToolId, source: string) {
  if (tool === "pdfToJpg") return basename(source);
  return `${toolById[tool].title.replace(/\s+/g, "-").toLowerCase()}.pdf`;
}

function basename(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function extension(path: string) {
  const name = basename(path);
  const index = name.lastIndexOf(".");
  return index >= 0 ? name.slice(index + 1).toLowerCase() : "";
}

function hasPdfExtension(path: string) {
  return extension(path) === "pdf";
}

function hasJpgExtension(path: string) {
  return ["jpg", "jpeg"].includes(extension(path));
}

function hasPresentationExtension(path: string) {
  return ["ppt", "pptx", "odp"].includes(extension(path));
}

function hasDocumentExtension(path: string) {
  return ["doc", "docx", "odt"].includes(extension(path));
}

function titleCase(value: string) {
  return `${value[0].toUpperCase()}${value.slice(1)}`;
}

function unique(value: string, index: number, values: string[]) {
  return values.indexOf(value) === index;
}

function historyLabel(entry: HistoryEntry) {
  if (entry.kind === "opened") return "Opened";
  return entry.tool ? `${toolById[entry.tool].title} saved` : "Saved";
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
}
