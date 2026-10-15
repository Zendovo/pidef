import { getVersion } from "@tauri-apps/api/app";
import {
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Download,
  Eye,
  FilePlus2,
  Files,
  Home,
  Loader2,
  RefreshCw,
  Settings,
  Copy,
  RotateCw,
  Trash2,
  X,
} from "lucide-react";
import { type CSSProperties, PointerEvent, type ReactNode, useEffect, useMemo, useState } from "react";
import {
  canReopenRecentFiles,
  pickFiles as pickFilesFromPlatform,
  saveFileOutput,
  saveMultiOutputs,
  subscribeToFileDrop,
} from "./platform";
import { invokeCommand, isTauriRuntime } from "./runtime";
import { toolById, tools, type ToolDefinition, type ToolId } from "./tools";
import type { DependencySet, JobResult, JobState, OperationOptions, PdfPreview } from "./types";
import { checkForUpdates, installPendingUpdate, type UpdateState } from "./updater";

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
type SplitGroup = {
  label: string;
  pages: number[];
};
type SplitPlan = {
  groups: SplitGroup[];
  effectiveRanges: string;
  trimmed: boolean;
};
type ZoomState = {
  status: "loading" | "ready" | "error";
  pageNumber: number;
  rotateDegrees: number;
  title: string;
  src: string | null;
  message: string | null;
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
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">("light");
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
  const [mergePreviews, setMergePreviews] = useState<Record<string, string>>({});
  const [draggedMergePath, setDraggedMergePath] = useState<string | null>(null);
  const [sourceFileSize, setSourceFileSize] = useState<number | null>(null);
  const [zoomState, setZoomState] = useState<ZoomState | null>(null);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<UpdateState>({
    status: "idle",
    version: null,
    message: null,
  });

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
    if (!isTauriRuntime()) return;
    void getVersion().then(setAppVersion).catch(() => setAppVersion(null));
    void checkForUpdates().then(setUpdateState);
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const applyAppearance = () => {
      const resolved = appearance === "system" ? (media.matches ? "dark" : "light") : appearance;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.appearance = appearance;
      localStorage.setItem("appearance", appearance);
      setResolvedTheme(resolved === "light" ? "light" : "dark");
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
    if (selectedToolId !== "mergePdf" || form.inputs.length === 0) {
      setMergePreviews({});
      return;
    }

    let isCancelled = false;
    for (const input of form.inputs) {
      setMergePreviews((current) => (input in current ? current : { ...current, [input]: "" }));
      void invokeCommand<PdfPreview>("get_pdf_preview", {
        request: { input, maxPages: 1, width: 180, quality: 74 },
      })
        .then((preview) => {
          if (isCancelled) return;
          const thumbnail = preview.pages[0]?.dataUrl;
          if (thumbnail) {
            setMergePreviews((current) => ({ ...current, [input]: thumbnail }));
          }
        })
        .catch(() => {
          if (!isCancelled) {
            setMergePreviews((current) => {
              const next = { ...current };
              delete next[input];
              return next;
            });
          }
        });
    }

    return () => {
      isCancelled = true;
    };
  }, [selectedToolId, form.inputs.join("|")]);

  useEffect(() => {
    if (selectedToolId !== "compressPdf" || !form.input) {
      setSourceFileSize(null);
      return;
    }

    let isCancelled = false;
    void invokeCommand<number>("get_file_size", { path: form.input })
      .then((size) => {
        if (!isCancelled) setSourceFileSize(size);
      })
      .catch(() => {
        if (!isCancelled) setSourceFileSize(null);
      });

    return () => {
      isCancelled = true;
    };
  }, [selectedToolId, form.input]);

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
    return subscribeToFileDrop({
      onOver: () => setIsDraggingFiles(true),
      onLeave: () => setIsDraggingFiles(false),
      onDrop: (paths) => {
        if (paths.length > 0) {
          applySelectedFiles(paths);
        }
      },
    });
  }, [activeView, selectedToolId, form]);

  const dependencyList = useMemo(
    () =>
      dependencies
        ? [dependencies.qpdf, dependencies.pdfRenderer]
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
    const picked = await pickFilesFromPlatform({
      title: `Choose files for ${selectedTool.title}`,
      multiple: selectedTool.needsMultipleInputs,
      filters: dialogFilters(selectedToolId),
    });

    if (picked.length === 0) return;
    applySelectedFiles(picked);
  }

  async function pickCommandCenterFiles() {
    const picked = await pickFilesFromPlatform({
      title: "Choose files for Pidef",
      multiple: true,
      filters: commandCenterFilters(),
    });

    if (picked.length === 0) return;
    applyCommandCenterFiles(picked);
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
    setZoomState(null);
  }

  async function openPageZoom(input: string, pageNumber: number, title: string, rotateDegrees = 0) {
    setZoomState({
      status: "loading",
      pageNumber,
      rotateDegrees,
      title,
      src: null,
      message: null,
    });
    try {
      const preview = await invokeCommand<PdfPreview>("get_pdf_preview", {
        request: { input, pages: [pageNumber], width: 980, quality: 86 },
      });
      const src = preview.pages[0]?.dataUrl ?? null;
      setZoomState((current) =>
        current && current.pageNumber === pageNumber
          ? {
              ...current,
              status: src ? "ready" : "error",
              src,
              message: src ? null : "Could not render this page.",
            }
          : current,
      );
    } catch (error) {
      setZoomState((current) =>
        current && current.pageNumber === pageNumber
          ? { ...current, status: "error", message: String(error) }
          : current,
      );
    }
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

    invalidateToolJobs(selectedToolId);

    if (selectedTool.needsMultipleInputs) {
      setForm((current) => ({
        ...current,
        inputs: [...current.inputs, ...paths].filter(unique),
      }));
    } else {
      setForm((current) => ({ ...current, input: paths[0] ?? "" }));
    }
  }

  function invalidateToolJobs(tool: ToolId) {
    setJobs((current) => current.filter((job) => job.tool !== tool));
  }

  function removeFile(path: string) {
    invalidateToolJobs(selectedToolId);
    if (selectedTool.needsMultipleInputs) {
      setForm((current) => ({
        ...current,
        inputs: current.inputs.filter((input) => input !== path),
      }));
    } else {
      setForm((current) => ({ ...current, input: "" }));
    }
  }

  function startOver() {
    setForm(initialForm(selectedTool));
    invalidateToolJobs(selectedToolId);
    setOrganizeItems([]);
    setPdfPreview(null);
    setPreviewError(null);
    setPreviewVisibleCount(DEFAULT_VISIBLE_PAGES);
    setMergePreviews({});
    setSourceFileSize(null);
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

  function moveMergeItem(sourcePath: string, targetPath: string) {
    if (sourcePath === targetPath) return;
    setForm((current) => {
      const sourceIndex = current.inputs.indexOf(sourcePath);
      const targetIndex = current.inputs.indexOf(targetPath);
      if (sourceIndex < 0 || targetIndex < 0) return current;
      const inputs = [...current.inputs];
      const [moved] = inputs.splice(sourceIndex, 1);
      inputs.splice(targetIndex, 0, moved);
      return { ...current, inputs };
    });
  }

  async function runSelectedJob() {
    if (!canRunSelectedTool) return;

    const id = crypto.randomUUID();
    const request = buildRequest(id, selectedToolId, form, organizeItems);
    if (selectedToolId === "splitPdf" && splitPlan) {
      // Keep the job in sync with the groups shown in the preview: ranges
      // past the last page are trimmed instead of failing in qpdf.
      (request.operation as unknown as { ranges: string }).ranges =
        splitPlan.effectiveRanges;
    }

    const newJob: JobState = {
      id,
      tool: selectedToolId,
      title: selectedTool.title,
      status: "running",
      message:
        selectedToolId === "compressPdf"
          ? "Compressing PDF…"
          : "Generating to a temporary location",
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
      const saved = await saveFileOutput(source, {
        title: `Save As ${job.title}`,
        defaultName: suggestedOutputName(job.tool, source),
        filters: outputFilters(job.tool),
      });
      if (!saved) return false;
      markSaved(job.id, saved, job.tool);
      return true;
    }

    const saved = await saveMultiOutputs(job.result.outputs, {
      title: `Save As ${job.title} outputs`,
      baseName: toolById[job.tool].title.replace(/\s+/g, "-").toLowerCase(),
    });
    if (!saved) return false;
    markSaved(job.id, saved, job.tool);
    return true;
  }

  async function saveAsCurrentOutput() {
    if (activeJob?.result) {
      await saveJobOutput(activeJob);
    }
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

  const splitPlan = useMemo(
    () =>
      selectedToolId === "splitPdf"
        ? parseSplitPlan(form.ranges, pdfPreview?.pageCount ?? 0)
        : null,
    [selectedToolId, form.ranges, pdfPreview?.pageCount],
  );
  const splitGroups = splitPlan?.groups ?? null;
  const splitPageGroups = useMemo(() => {
    const pageToGroup = new Map<number, number>();
    splitPlan?.groups.forEach((group, index) => {
      group.pages.forEach((page) => pageToGroup.set(page, index + 1));
    });
    return pageToGroup;
  }, [splitPlan]);

  const canRun = !disabledReason && selectedFiles.length > 0;
  const canRunSelectedTool =
    selectedToolId === "organizePdf"
      ? canRun && organizeItems.length > 0
      : selectedToolId === "splitPdf"
        ? canRun && Boolean(splitPlan)
        : canRun;
  const isSettingsView = activeView === "settings";
  const isHomeView = activeView === "home";
  const restorableRecentFiles = canReopenRecentFiles() ? recentFiles : [];
  const activeJob = jobs.find((job) => job.tool === selectedToolId) ?? null;
  const hasOutput = Boolean(activeJob?.status === "complete" && activeJob.result);

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

        <div className="sidebar-footer">
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

          <div className="theme-toggle-row">
            <span>Dark mode</span>
            <button
              aria-checked={resolvedTheme === "dark"}
              className={`theme-switch ${resolvedTheme === "dark" ? "on" : ""}`}
              onClick={() => setAppearance(resolvedTheme === "dark" ? "light" : "dark")}
              role="switch"
              type="button"
            >
              <span className="theme-switch-knob" />
            </button>
          </div>
        </div>
      </section>

      <section className={isHomeView ? "workspace workspace-home" : "workspace"}>
        {isHomeView ? (
          <div aria-hidden="true" className="home-orb-layer">
            <div className="home-orb home-orb-a" />
            <div className="home-orb home-orb-b" />
            <div className="home-orb home-orb-c" />
          </div>
        ) : null}
        {!isHomeView ? (
          <header className="topbar">
            <div data-tauri-drag-region>
              <h2>
                {activeView === "history"
                  ? "History"
                  : isSettingsView
                    ? "Settings"
                    : selectedTool.title}
              </h2>
              <p>
                {activeView === "history"
                  ? "Recent work, opened files, and saved outputs."
                  : isSettingsView
                    ? "Runtime diagnostics and updates."
                    : selectedTool.description}
              </p>
            </div>
            <button className="icon-button" onClick={refreshRuntime} type="button" title="Refresh">
              <RefreshCw size={18} />
            </button>
          </header>
        ) : null}

        {isHomeView ? (
          <HomeView
            dragging={isDraggingFiles}
            files={commandFiles}
            operationOptions={operationOptions}
            recentFiles={restorableRecentFiles}
            onOpenFile={(path) => applyCommandCenterFiles([path])}
            onPickFiles={pickCommandCenterFiles}
            onRemoveFile={removeCommandFile}
            onSelectTool={(toolId) => activateTool(toolId, commandFiles)}
            onShowHistory={() => setActiveView("history")}
          />
        ) : activeView === "history" ? (
          <HistoryView
            entries={historyEntries}
            onOpenFile={(path) => applySelectedFiles([path])}
          />
        ) : isSettingsView ? (
          <SettingsView
            dependencies={dependencyList}
            operationOptions={operationOptions}
            appVersion={appVersion}
            updateState={updateState}
            onRefreshRuntime={refreshRuntime}
            onCheckForUpdates={async () => setUpdateState(await checkForUpdates())}
            onInstallUpdate={async () => setUpdateState(await installPendingUpdate())}
          />
        ) : (
          <div className="workbench" style={{ "--tool-accent": selectedTool.accent } as CSSProperties}>
            <section
              className={`${hasSelectedFiles ? "preview-stage" : "empty-stage"}${
                selectedToolId === "splitPdf" && hasSelectedFiles ? " split-stage" : ""
              }`}
            >
              {!hasSelectedFiles ? (
                <>
                  <FileDropZone
                    dragging={isDraggingFiles}
                    multiple={selectedTool.needsMultipleInputs}
                    onPick={pickFiles}
                    title={
                      selectedTool.needsMultipleInputs
                        ? "Drop files here or choose files"
                        : "Drop a file here or choose a file"
                    }
                  />
                  <RecentFiles files={restorableRecentFiles} onOpenFile={(path) => applySelectedFiles([path])} />
                </>
              ) : (
                <>
                  {!selectedTool.needsMultipleInputs && form.input ? (
                    <StageFileBar file={form.input} onRemove={removeFile} />
                  ) : null}
                  {selectedToolId === "organizePdf" ? (
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
                  onZoomPage={(page, rotateDegrees) =>
                    void openPageZoom(form.input, page, selectedTool.title, rotateDegrees)
                  }
                  onShowAll={() => setPreviewVisibleCount(SHOW_ALL_PREVIEW_LIMIT)}
                  onShowMore={() =>
                    setPreviewVisibleCount((current) => current + DEFAULT_VISIBLE_PAGES)
                  }
                />
              ) : selectedToolId === "mergePdf" ? (
                <MergeBoard
                  files={form.inputs}
                  thumbnails={mergePreviews}
                  draggedId={draggedMergePath}
                  onDragEnd={() => setDraggedMergePath(null)}
                  onDragStart={setDraggedMergePath}
                  onMove={moveMergeItem}
                  onRemove={removeFile}
                  onZoomFile={(path) => void openPageZoom(path, 1, basename(path))}
                />
              ) : selectedToolId === "splitPdf" ? (
                <>
                  <SplitGroupsBoard groups={splitGroups} preview={pdfPreview} />
                  <PdfPreviewGrid
                    preview={pdfPreview}
                    isLoading={isPreviewLoading}
                    error={previewError}
                    visibleCount={previewVisibleCount}
                    groupByPage={splitPageGroups}
                    onZoomPage={(page) => void openPageZoom(form.input, page, selectedTool.title)}
                    onShowAll={() => setPreviewVisibleCount(SHOW_ALL_PREVIEW_LIMIT)}
                    onShowMore={() =>
                      setPreviewVisibleCount((current) => current + DEFAULT_VISIBLE_PAGES)
                    }
                  />
                </>
              ) : isPdfPreviewTool(selectedToolId) ? (
                <PdfPreviewGrid
                  preview={pdfPreview}
                  isLoading={isPreviewLoading}
                  error={previewError}
                  visibleCount={previewVisibleCount}
                  onZoomPage={(page) => void openPageZoom(form.input, page, selectedTool.title)}
                  onShowAll={() => setPreviewVisibleCount(SHOW_ALL_PREVIEW_LIMIT)}
                  onShowMore={() =>
                    setPreviewVisibleCount((current) => current + DEFAULT_VISIBLE_PAGES)
                  }
                />
              ) : (
                <SelectedFileStage files={selectedFiles} onRemove={removeFile} />
              )}
                </>
              )}
            </section>

            <aside className="options-panel">
              <div className="panel-heading">
                <h3>Options</h3>
              </div>

              {hasOutput && activeJob ? (
                <OutputPanel
                  job={activeJob}
                  onSaveAs={() => void saveAsCurrentOutput()}
                  onStartOver={startOver}
                />
              ) : (
                <>
                  {disabledReason ? (
                    <div className="notice warning">
                      <CircleAlert size={18} />
                      <span>{availabilityMessage(disabledReason)}</span>
                    </div>
                  ) : null}

                  {selectedTool.needsMultipleInputs && hasSelectedFiles ? (
                    <div className="file-selection-summary">
                      <span>{`${selectedFiles.length} files selected`}</span>
                      <button className="save-button compact" onClick={pickFiles} type="button">
                        <FilePlus2 size={15} />
                        Add files
                      </button>
                    </div>
                  ) : (
                    <button className="save-button" onClick={pickFiles} type="button">
                      <FilePlus2 size={16} />
                      {selectedTool.needsMultipleInputs ? "Add files" : "Add file"}
                    </button>
                  )}

                  <OperationFields selectedToolId={selectedToolId} form={form} onChange={setForm} />

                  {selectedToolId === "splitPdf" && form.input ? (
                    splitPlan?.trimmed ? (
                      <p className="field-hint">
                        Ranges past page {pdfPreview?.pageCount ?? "?"} were ignored.
                      </p>
                    ) : !splitPlan && form.ranges.trim() ? (
                      <p className="field-hint">No pages match these ranges.</p>
                    ) : null
                  ) : null}

                  {selectedToolId === "compressPdf" && form.input ? (
                    <p className="source-size-note">
                      <strong>{sourceFileSize ? formatBytes(sourceFileSize) : "—"}</strong>
                      <span>current file size</span>
                    </p>
                  ) : null}

                  <OperationRunButton
                    disabled={!canRunSelectedTool}
                    tool={selectedToolId}
                    onRun={() => void runSelectedJob()}
                  />
                  <CurrentJobStatus job={activeJob} />
                </>
              )}
            </aside>
          </div>
        )}
      </section>
      {zoomState ? <PageZoomModal zoom={zoomState} onClose={() => setZoomState(null)} /> : null}
    </main>
  );
}

function SettingsView({
  dependencies,
  operationOptions,
  appVersion,
  updateState,
  onRefreshRuntime,
  onCheckForUpdates,
  onInstallUpdate,
}: {
  dependencies: DependencySet[keyof DependencySet][];
  operationOptions: OperationOptions[];
  appVersion: string | null;
  updateState: UpdateState;
  onRefreshRuntime: () => void;
  onCheckForUpdates: () => Promise<void>;
  onInstallUpdate: () => Promise<void>;
}) {
  const runtimeRows = dependencies.length > 0 ? dependencies : [];
  const unavailableTools = operationOptions.filter((option) => option.unavailableReason);
  const showUpdates = isTauriRuntime();

  const updateCopy: Record<UpdateState["status"], string> = {
    idle: "Updates are checked automatically when Pidef starts.",
    checking: "Checking for updates…",
    downloading: "Downloading update…",
    installing: "Installing update and restarting…",
    upToDate: `Pidef ${appVersion ?? ""} is up to date.`.replace("  ", " "),
    available: `Pidef ${updateState.version ?? ""} is available.`,
    error: updateState.message ?? "Update check failed.",
  };
  const updateBusy = updateState.status === "checking" || updateState.status === "downloading";

  return (
    <div className="settings-grid">
      {showUpdates ? (
        <section className="settings-panel">
          <div className="settings-heading">
            <h3>Updates</h3>
            <button
              className="save-button compact"
              disabled={updateBusy || updateState.status === "installing"}
              onClick={() => void onCheckForUpdates()}
              type="button"
            >
              {updateBusy ? <Loader2 className="spin" size={15} /> : <RefreshCw size={15} />}
              {updateState.status === "available" ? "Refresh" : "Check now"}
            </button>
          </div>
          <p className="update-status">{updateCopy[updateState.status]}</p>
          {updateState.status === "available" ? (
            <button className="save-button" onClick={() => void onInstallUpdate()} type="button">
              <Download size={15} />
              Download and restart
            </button>
          ) : null}
        </section>
      ) : null}

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
  onShowHistory,
}: {
  dragging: boolean;
  files: string[];
  operationOptions: OperationOptions[];
  recentFiles: string[];
  onOpenFile: (path: string) => void;
  onPickFiles: () => void;
  onRemoveFile: (path: string) => void;
  onSelectTool: (toolId: ToolId) => void;
  onShowHistory: () => void;
}) {
  const suggestions = [
    ...commandCenterSuggestions(files),
    ...tools.map((tool) => tool.id),
  ]
    .filter(unique)
    .slice(0, 6);

  return (
    <section className="home-screen">
      <section className="home-hero">
        <h1>Welcome to Pidef</h1>
        <p>Fast, secure, local-first PDF processing. Your files never leave this machine.</p>
      </section>

      <section className={`home-drop-zone ${dragging ? "dragging" : ""}`}>
        <div className="home-drop-card">
          <span className="home-drop-icon">
            <FilePlus2 size={22} />
          </span>
          <h2>
            {files.length > 0
              ? `${files.length} ${files.length === 1 ? "file" : "files"} ready`
              : "Drop your PDF files here"}
          </h2>
          <p>
            {files.length > 0
              ? "Pick an action below, or add more files to the workspace."
              : "Process single files or select multiple pages. Everything stays on-device."}
          </p>
          <button className="home-drop-cta" onClick={onPickFiles} type="button">
            <FilePlus2 size={15} />
            {files.length > 0 ? "Add or replace files" : "Choose files"}
          </button>
          <div className="home-drop-chips">
            <span>PDF</span>
            <span>JPG</span>
            <em>Processed locally — no uploads</em>
          </div>
        </div>

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
          <h3>{files.length > 0 ? "Suggested Actions" : "Primary Tools"}</h3>
          <span>{files.length > 0 ? "Based on selected files" : "Common PDF workflows"}</span>
        </div>

        <div className="home-tool-grid">
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
                  <Icon size={17} />
                </span>
                <ArrowRight className="home-action-arrow" size={16} />
                <strong>{tool.title}</strong>
                <small>{unavailableReason ? "Needs setup" : tool.description}</small>
                <span className="home-action-badge">{tool.badge}</span>
              </button>
            );
          })}
        </div>
      </section>

      {recentFiles.length > 0 ? (
        <section className="home-section">
          <div className="home-section-heading">
            <h3>Recent</h3>
            <button className="home-section-link" onClick={onShowHistory} type="button">
              View history
            </button>
          </div>
          <div className="recent-list">
            {recentFiles.slice(0, 4).map((path) => (
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
  multiple,
  onPick,
  title,
}: {
  dragging: boolean;
  multiple: boolean;
  onPick: () => void;
  title: string;
}) {
  return (
    <section className={`drop-zone ${dragging ? "dragging" : ""}`}>
      <button className="drop-action" onClick={onPick} type="button">
        <FilePlus2 size={24} />
        <span>{title}</span>
        <small>{multiple ? "Files stay in the order shown below" : "One file is used for this tool"}</small>
      </button>
    </section>
  );
}

function StageFileBar({
  file,
  onRemove,
}: {
  file: string;
  onRemove: (path: string) => void;
}) {
  return (
    <div className="stage-file-bar">
      <span>{basename(file)}</span>
      <button onClick={() => onRemove(file)} title="Remove file" type="button">
        <X size={14} />
      </button>
    </div>
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

function SelectedFileStage({
  files,
  onRemove,
}: {
  files: string[];
  onRemove: (path: string) => void;
}) {
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
            <button onClick={() => onRemove(path)} title="Remove" type="button">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function OperationRunButton({
  tool,
  disabled,
  onRun,
}: {
  tool: ToolId;
  disabled: boolean;
  onRun: () => void;
}) {
  return (
    <button className="run-button" disabled={disabled} onClick={onRun} type="button">
      <ArrowRight size={16} />
      {runActionLabel(tool)}
    </button>
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

function OutputPanel({
  job,
  onSaveAs,
  onStartOver,
}: {
  job: JobState;
  onSaveAs: () => void;
  onStartOver: () => void;
}) {
  const result = job.result;
  if (!result) return null;
  const single = result.outputs.length === 1;
  const sizeSummary =
    job.tool === "compressPdf"
      ? null
      : result.outputBytes
        ? formatBytes(result.outputBytes)
        : null;

  return (
    <section className="output-panel">
      <div className="output-heading">
        <CheckCircle2 size={18} className="ok" />
        <div>
          <strong>{job.title} complete</strong>
          <small>{job.message}</small>
        </div>
      </div>
      <div className="output-meta">
        <span>
          {single ? basename(result.outputs[0]) : `${result.outputs.length} files ready`}
        </span>
        {sizeSummary ? <small>{sizeSummary}</small> : null}
      </div>
      <button className="save-button" onClick={onSaveAs} type="button">
        <Download size={15} />
        Save As…
      </button>
      <button className="start-over-button" onClick={onStartOver} type="button">
        <RefreshCw size={15} />
        Start over
      </button>
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
  groupByPage,
  onZoomPage,
}: {
  preview: PdfPreview | null;
  isLoading: boolean;
  error: string | null;
  visibleCount: number;
  onShowAll: () => void;
  onShowMore: () => void;
  groupByPage?: Map<number, number>;
  onZoomPage?: (pageNumber: number) => void;
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
        {visiblePages.map((page) => {
          const group = groupByPage?.get(page.pageNumber);
          return (
            <figure
              className={`preview-thumb ${onZoomPage ? "clickable" : ""}`}
              key={page.pageNumber}
              onClick={onZoomPage ? () => onZoomPage(page.pageNumber) : undefined}
            >
              <img
                alt={`Page ${page.pageNumber}`}
                draggable={false}
                src={page.dataUrl}
              />
              {group ? (
                <span
                  className={`thumb-group-badge hue-${GROUP_HUES[(group - 1) % GROUP_HUES.length]}`}
                >
                  {group}
                </span>
              ) : null}
              <figcaption>{page.pageNumber}</figcaption>
            </figure>
          );
        })}
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
  onZoomPage,
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
  onZoomPage: (pageNumber: number, rotateDegrees: number) => void;
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
              <span className="order-badge">{index + 1}</span>
              <img
                alt={`Page ${item.sourcePage}`}
                draggable={false}
                src={item.thumbnail}
                style={{ transform: `rotate(${item.rotateDegrees}deg)` }}
              />
            </div>
            <div className="organize-card-footer">
              <span>Page {item.sourcePage}</span>
              {item.rotateDegrees ? <small>{item.rotateDegrees} deg</small> : null}
            </div>
            <div className="organize-actions">
              <button
                onClick={() => onZoomPage(item.sourcePage, item.rotateDegrees)}
                title="View larger"
                type="button"
              >
                <Eye size={15} />
              </button>
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

function MergeBoard({
  files,
  thumbnails,
  draggedId,
  onDragEnd,
  onDragStart,
  onMove,
  onRemove,
  onZoomFile,
}: {
  files: string[];
  thumbnails: Record<string, string>;
  draggedId: string | null;
  onDragEnd: () => void;
  onDragStart: (path: string) => void;
  onMove: (sourcePath: string, targetPath: string) => void;
  onRemove: (path: string) => void;
  onZoomFile: (path: string) => void;
}) {
  function startFileDrag(event: PointerEvent<HTMLElement>, path: string) {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    onDragStart(path);
  }

  function moveOverFile(event: PointerEvent<HTMLElement>, path: string) {
    event.stopPropagation();
    if (draggedId) onMove(draggedId, path);
  }

  function endFileDrag(event: PointerEvent<HTMLElement>) {
    event.stopPropagation();
    onDragEnd();
  }

  if (files.length === 0) return null;

  return (
    <section className="merge-board" onPointerLeave={onDragEnd} onPointerUp={onDragEnd}>
      <div className="preview-heading">
        <strong>Merge order</strong>
        <span>Drag cards to reorder — files merge top to bottom</span>
      </div>
      <div className="merge-grid">
        {files.map((path, index) => (
          <article
            className={`merge-card ${draggedId === path ? "dragging" : ""}`}
            key={path}
            onPointerCancel={endFileDrag}
            onPointerDown={(event) => startFileDrag(event, path)}
            onPointerEnter={(event) => moveOverFile(event, path)}
            onPointerUp={endFileDrag}
          >
            <span className="order-badge">{index + 1}</span>
            <div className="merge-thumb">
              {thumbnails[path] ? (
                <img alt={basename(path)} draggable={false} src={thumbnails[path]} />
              ) : (
                <Files size={22} />
              )}
            </div>
            <div className="merge-card-footer">
              <span>{basename(path)}</span>
              <div className="merge-card-actions">
                <button onClick={() => onZoomFile(path)} title="View larger" type="button">
                  <Eye size={14} />
                </button>
                <button onClick={() => onRemove(path)} title="Remove" type="button">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function SplitGroupsBoard({
  groups,
  preview,
}: {
  groups: SplitGroup[] | null;
  preview: PdfPreview | null;
}) {
  if (!preview || !groups) return null;
  const pageThumbnails = new Map(
    preview.pages.map((page) => [page.pageNumber, page.dataUrl] as const),
  );

  return (
    <section className="split-groups-board">
      <div className="preview-heading">
        <strong>Split groups</strong>
        <span>
          {groups.length === 1 ? "1 output file" : `${groups.length} output files`} from the
          ranges above
        </span>
      </div>
      <div className="split-groups-grid">
        {groups.map((group, index) => {
          const visiblePages = group.pages.slice(0, 8);
          return (
            <article
              className={`split-group-card hue-${GROUP_HUES[index % GROUP_HUES.length]}`}
              key={`${group.label}-${index}`}
            >
              <header>
                <span className="split-group-number">{index + 1}</span>
                <div>
                  <strong>{group.label}</strong>
                  <small>
                    {group.pages.length} {group.pages.length === 1 ? "page" : "pages"}
                  </small>
                </div>
              </header>
              <div className="split-group-pages">
                {visiblePages.map((page) => {
                  const thumbnail = pageThumbnails.get(page);
                  return (
                    <figure key={page}>
                      {thumbnail ? (
                        <img alt={`Page ${page}`} draggable={false} src={thumbnail} />
                      ) : (
                        <span className="split-page-fallback">{page}</span>
                      )}
                      <figcaption>{page}</figcaption>
                    </figure>
                  );
                })}
                {group.pages.length > visiblePages.length ? (
                  <span className="split-group-more">
                    +{group.pages.length - visiblePages.length}
                  </span>
                ) : null}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PageZoomModal({ zoom, onClose }: { zoom: ZoomState; onClose: () => void }) {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="zoom-overlay" onClick={onClose} role="presentation">
      <div className="zoom-modal" onClick={(event) => event.stopPropagation()} role="dialog">
        <header>
          <div>
            <strong>{zoom.title}</strong>
            <span>Page {zoom.pageNumber}</span>
          </div>
          <button onClick={onClose} title="Close" type="button">
            <X size={16} />
          </button>
        </header>
        <div className="zoom-body">
          {zoom.status === "loading" ? (
            <div className="zoom-state">
              <Loader2 className="spin" size={18} />
              <span>Rendering page…</span>
            </div>
          ) : null}
          {zoom.status === "error" ? (
            <div className="zoom-state error">
              <CircleAlert size={16} />
              <span>{zoom.message ?? "Could not render this page."}</span>
            </div>
          ) : null}
          {zoom.status === "ready" && zoom.src ? (
            <img
              alt={`Page ${zoom.pageNumber} enlarged`}
              src={zoom.src}
              style={
                zoom.rotateDegrees
                  ? { transform: `rotate(${zoom.rotateDegrees}deg)` }
                  : undefined
              }
            />
          ) : null}
        </div>
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
  return [{ name: "PDF", extensions: ["pdf"] }];
}

function commandCenterFilters() {
  return [
    { name: "Supported Files", extensions: ["pdf", "jpg", "jpeg"] },
    { name: "PDF", extensions: ["pdf"] },
    { name: "Images", extensions: ["jpg", "jpeg"] },
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

  return ["mergePdf", "jpgToPdf"];
}

function availabilityMessage(reason: string) {
  if (reason.toLowerCase().includes("planned")) return reason;
  return `${reason}. Install the required local engine, then refresh runtime.`;
}

function isPdfPreviewTool(tool: ToolId) {
  return [
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
  if (tool === "compressPdf") {
    return compressionSummary(result) ?? "Output ready.";
  }
  return "Output ready.";
}

function runActionLabel(tool: ToolId) {
  switch (tool) {
    case "mergePdf":
      return "Merge PDFs";
    case "splitPdf":
      return "Split PDF";
    case "organizePdf":
      return "Apply changes";
    case "compressPdf":
      return "Compress PDF";
    case "pdfToJpg":
      return "Export JPGs";
    case "jpgToPdf":
      return "Create PDF";
    case "unlockPdf":
      return "Unlock PDF";
    case "protectPdf":
      return "Protect PDF";
  }
}

function compressionSummary(result: JobResult) {
  if (!result.inputBytes || !result.outputBytes) return null;
  if (result.outputBytes < result.inputBytes) {
    const percent = Math.max(1, Math.round((1 - result.outputBytes / result.inputBytes) * 100));
    return `${formatBytes(result.inputBytes)} → ${formatBytes(result.outputBytes)} · ${percent}% smaller`;
  }
  return `${formatBytes(result.outputBytes)} · about the same as the ${formatBytes(result.inputBytes)} input`;
}

const GROUP_HUES = ["violet", "blue", "teal", "amber", "pink", "green"];

function parseSplitPlan(ranges: string, pageCount: number): SplitPlan | null {
  const trimmedInput = ranges.trim();
  if (!trimmedInput || pageCount <= 0) return null;

  const groups: SplitGroup[] = [];
  const effective: string[] = [];
  let trimmed = false;

  for (const rawPart of trimmedInput.split(",")) {
    const part = rawPart.trim();
    if (!part) continue;

    const bounds = part.split("-");
    let start: number;
    let end: number;
    if (bounds.length === 2) {
      start = Number(bounds[0]);
      end = Number(bounds[1]);
    } else if (bounds.length === 1) {
      start = Number(bounds[0]);
      end = start;
    } else {
      return null;
    }

    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      bounds.some((value) => value.trim() === "")
    ) {
      return null;
    }

    if (start > pageCount) {
      trimmed = true;
      continue;
    }
    const clampedEnd = Math.min(end, pageCount);
    if (clampedEnd < end) {
      trimmed = true;
    }

    const pages: number[] = [];
    for (let page = start; page <= clampedEnd; page += 1) {
      pages.push(page);
    }
    groups.push({
      label: start === clampedEnd ? `Page ${start}` : `Pages ${start}–${clampedEnd}`,
      pages,
    });
    effective.push(start === clampedEnd ? `${start}` : `${start}-${clampedEnd}`);
  }

  if (groups.length === 0) return null;
  return { groups, effectiveRanges: effective.join(", "), trimmed };
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
