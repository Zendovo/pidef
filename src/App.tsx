import { getVersion } from "@tauri-apps/api/app";
import {
  ArrowLeftRight,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Copy,
  Download,
  Eye,
  FilePlus2,
  FileText,
  Files,
  GripVertical,
  Home,
  Lightbulb,
  ListOrdered,
  Loader2,
  Menu,
  Moon,
  Plus,
  RefreshCw,
  RotateCw,
  Settings,
  SlidersHorizontal,
  Split,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  canReopenRecentFiles,
  pickFiles as pickFilesFromPlatform,
  saveFileOutput,
  saveMultiOutputs,
  saveZipOutputs,
  subscribeToFileDrop,
} from "./platform";
import { invokeCommand, isTauriRuntime } from "./runtime";
import { hasRegisteredFile } from "./web/registry";
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
const DEFAULT_SPLIT_GROUPS = ["1-2"];
const STUDIO_TOOLS: ToolId[] = [
  "mergePdf",
  "splitPdf",
  "organizePdf",
  "compressPdf",
  "pdfToJpg",
  "jpgToPdf",
  "unlockPdf",
  "protectPdf",
];
const isStudioTool = (tool: ToolId) => STUDIO_TOOLS.includes(tool);

const BROWSER_CHROME_COLORS = {
  light: "#f5f1ea",
  dark: "#0e0d0c",
} as const;

/**
 * iOS Safari derives its top/bottom chrome tint from body's background color.
 * It does not reliably re-sample after an SPA theme flip, so nudge the
 * theme-color meta with a near-identical value for one frame to force it.
 */
function syncBrowserChrome(theme: "light" | "dark") {
  const color = BROWSER_CHROME_COLORS[theme];
  document.documentElement.style.backgroundColor = color;
  document.body.style.backgroundColor = color;

  const meta = document.getElementById("theme-color");
  if (!meta) return;

  meta.setAttribute("content", color);
  requestAnimationFrame(() => {
    meta.setAttribute("content", `${color}fe`);
    requestAnimationFrame(() => {
      meta.setAttribute("content", color);
    });
  });
}

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
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);
  const workspaceRef = useRef<HTMLElement | null>(null);
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
  const [mergeFrames, setMergeFrames] = useState<
    Record<string, { pages: { page: number; dataUrl: string }[]; pageCount: number; size: number | null }>
  >({});
  const [draggedMergePath, setDraggedMergePath] = useState<string | null>(null);
  const [sourceFileSize, setSourceFileSize] = useState<number | null>(null);
  const [splitGroups, setSplitGroups] = useState<string[]>(DEFAULT_SPLIT_GROUPS);
  const [packageZip, setPackageZip] = useState(true);
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
      document.documentElement.style.colorScheme = resolved;
      syncBrowserChrome(resolved);
      localStorage.setItem("appearance", appearance);
      setResolvedTheme(resolved === "light" ? "light" : "dark");
    };

    applyAppearance();
    void invokeCommand("set_appearance", {
      appearance,
      resolved: appearance === "system" ? (media.matches ? "dark" : "light") : appearance,
    });
    media.addEventListener("change", applyAppearance);
    return () => media.removeEventListener("change", applyAppearance);
  }, [appearance]);

  useEffect(() => {
    if (!isMobileNavOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMobileNavOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [isMobileNavOpen]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    workspace.scrollTop = 0;
    workspace.scrollLeft = 0;
    for (const region of workspace.querySelectorAll<HTMLElement>(
      ".home-screen, .split-studio, .history-feed",
    )) {
      region.scrollTop = 0;
    }
  }, [activeView, selectedToolId]);

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
    if (
      (selectedToolId !== "mergePdf" && selectedToolId !== "jpgToPdf") ||
      form.inputs.length === 0
    ) {
      setMergeFrames({});
      return;
    }

    let isCancelled = false;
    for (const input of form.inputs) {
      setMergeFrames((current) =>
        input in current ? current : { ...current, [input]: { pages: [], pageCount: 0, size: null } },
      );
      const isImage = /\.(jpe?g)$/i.test(input);
      const framesPromise = isImage
        ? invokeCommand<string>("get_image_thumbnail", { path: input, width: 140 }).then(
            (dataUrl) => ({ pages: [{ page: 1, dataUrl }], pageCount: 1 }),
          )
        : invokeCommand<PdfPreview>("get_pdf_preview", {
            request: { input, maxPages: 6, width: 140, quality: 70 },
          }).then((preview) => ({
            pages: preview.pages.map((page) => ({ page: page.pageNumber, dataUrl: page.dataUrl })),
            pageCount: preview.pageCount,
          }));
      const sizePromise = invokeCommand<number>("get_file_size", { path: input }).catch(
        () => null,
      );

      void Promise.all([framesPromise, sizePromise])
        .then(([frames, size]) => {
          if (!isCancelled) {
            setMergeFrames((current) => ({ ...current, [input]: { ...frames, size } }));
          }
        })
        .catch(() => {
          if (!isCancelled) {
            setMergeFrames((current) => {
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
    if (!isStudioTool(selectedToolId) || !form.input) {
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

    const handleNativeThemeChanged = (event: Event) => {
      const dark = Boolean((event as CustomEvent<{ dark?: boolean }>).detail?.dark);
      setAppearance(dark ? "dark" : "light");
    };

    window.addEventListener("native-tool-selected", handleNativeToolSelected);
    window.addEventListener("native-theme-changed", handleNativeThemeChanged);
    return () => {
      window.removeEventListener("native-tool-selected", handleNativeToolSelected);
      window.removeEventListener("native-theme-changed", handleNativeThemeChanged);
    };
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
    setIsMobileNavOpen(false);
    setForm(nextForm);
    setPdfPreview(null);
    setOrganizeItems([]);
    setPreviewError(null);
    setPreviewVisibleCount(DEFAULT_VISIBLE_PAGES);
    setZoomState(null);
    setSplitGroups([...DEFAULT_SPLIT_GROUPS]);
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
      const isImage = /\.(jpe?g)$/i.test(input);
      const src = isImage
        ? await invokeCommand<string>("get_image_thumbnail", { path: input, width: 960 })
        : ((
            await invokeCommand<PdfPreview>("get_pdf_preview", {
              request: { input, pages: [pageNumber], width: 980, quality: 86 },
            })
          ).pages[0]?.dataUrl ?? null);
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

  function clearAllFiles() {
    invalidateToolJobs(selectedToolId);
    setForm((current) => ({ ...current, input: "", inputs: [] }));
    setMergeFrames({});
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
    setSplitGroups([...DEFAULT_SPLIT_GROUPS]);
    setOrganizeItems([]);
    setPdfPreview(null);
    setPreviewError(null);
    setPreviewVisibleCount(DEFAULT_VISIBLE_PAGES);
    setMergeFrames({});
    setSourceFileSize(null);
  }

  function resetSplitConfiguration() {
    setSplitGroups([...DEFAULT_SPLIT_GROUPS]);
    setForm((current) => ({
      ...current,
      outputPattern: toolById.splitPdf.defaults.outputPattern,
    }));
  }

  async function saveStudioRow(job: JobState, output: string) {
    const saved = await saveFileOutput(output, {
      title: `Save As ${basename(output)}`,
      defaultName: suggestedOutputName(job.tool, output),
      filters: outputFilters(job.tool),
    });
    if (saved) markSaved(job.id, saved, job.tool);
  }

  async function saveStudioAll(job: JobState) {
    if (!job.result) return;
    const outputs = job.result.outputs;
    const stem = basename(form.input).replace(/\.[^.]+$/, "") || "pidef";
    let saved: string | null = null;
    if (outputs.length === 1) {
      saved = await saveFileOutput(outputs[0], {
        title: `Save As ${job.title}`,
        defaultName: suggestedOutputName(job.tool, outputs[0]),
        filters: outputFilters(job.tool),
      });
    } else if (packageZip && (job.tool === "splitPdf" || job.tool === "pdfToJpg")) {
      saved = await saveZipOutputs(outputs, {
        title: "Save bundle",
        zipName: `${stem}-${job.tool === "pdfToJpg" ? "images" : "parts"}.zip`,
      });
    } else {
      saved = await saveMultiOutputs(outputs, {
        title: "Save outputs",
        baseName: stem,
      });
    }
    if (saved) markSaved(job.id, saved, job.tool);
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
        ? parseSplitPlan(splitGroups.join(", "), pdfPreview?.pageCount ?? 0)
        : null,
    [selectedToolId, splitGroups, pdfPreview?.pageCount],
  );
  const canRun = !disabledReason && selectedFiles.length > 0;
  const canRunSelectedTool =
    selectedToolId === "organizePdf"
      ? canRun && organizeItems.length > 0
      : selectedToolId === "splitPdf"
        ? canRun && Boolean(splitPlan)
        : canRun;
  const isSettingsView = activeView === "settings";
  const isHomeView = activeView === "home";
  const restorableRecentFiles = canReopenRecentFiles()
    ? recentFiles
    : recentFiles.filter(hasRegisteredFile);
  const activeJob = jobs.find((job) => job.tool === selectedToolId) ?? null;
  const hasOutput = Boolean(activeJob?.status === "complete" && activeJob.result);
  const isStudioView = isStudioTool(selectedToolId);
  const studioRunLabel = (() => {
    if (selectedToolId === "splitPdf") {
      const count = splitPlan?.groups.length ?? 0;
      return count > 0 ? `Split PDF into ${count} File${count === 1 ? "" : "s"}` : "Split PDF";
    }
    return runActionLabel(selectedToolId);
  })();
  const studioSummary: Array<{ label: string; value: string }> = (() => {
    switch (selectedToolId) {
      case "organizePdf":
        return [
          {
            label: "Pages in Output",
            value: `${organizeItems.length} of ${pdfPreview?.pageCount ?? "?"} pages`,
          },
        ];
      case "compressPdf":
        return [
          {
            label: "Compression Preset",
            value:
              form.profile === "safe"
                ? "Safe"
                : form.profile === "balanced"
                  ? "Balanced"
                  : "Small",
          },
          {
            label: "Current File Size",
            value: sourceFileSize ? formatBytes(sourceFileSize) : "—",
          },
        ];
      case "pdfToJpg":
        return [
          { label: "Pages to Export", value: `${pdfPreview?.pageCount ?? "?"}` },
          { label: "Export DPI", value: `${form.dpi}` },
        ];
      case "mergePdf": {
        const knownPages = form.inputs.reduce(
          (sum, path) => sum + (mergeFrames[path]?.pageCount ?? 0),
          0,
        );
        const sizes = form.inputs.map((path) => mergeFrames[path]?.size ?? null);
        const allSizesKnown = form.inputs.length > 0 && sizes.every((size) => size !== null);
        const totalSize = allSizesKnown
          ? sizes.reduce((sum, size) => (sum ?? 0) + (size ?? 0), 0)
          : null;
        return [
          {
            label: "Input Documents",
            value: `${form.inputs.length} file${form.inputs.length === 1 ? "" : "s"}`,
          },
          {
            label: "Total Combined Pages",
            value: knownPages > 0 ? `${knownPages} pages` : "—",
          },
          {
            label: "Estimated Output Size",
            value: totalSize !== null ? `~${formatBytes(totalSize)}` : "—",
          },
        ];
      }
      case "jpgToPdf":
        return [
          {
            label: "Input Images",
            value: `${form.inputs.length} image${form.inputs.length === 1 ? "" : "s"}`,
          },
          {
            label: "Page Size",
            value:
              form.pageSize === "auto" ? "Auto" : form.pageSize === "a4" ? "A4" : "Letter",
          },
        ];
      case "unlockPdf":
        return [{ label: "Output", value: "Decrypted copy" }];
      case "protectPdf":
        return [
          { label: "Encryption", value: "AES-256" },
          {
            label: "Permissions",
            value:
              [
                form.allowPrinting ? "print" : null,
                form.allowCopying ? "copy" : null,
                form.allowModification ? "edit" : null,
              ]
                .filter(Boolean)
                .join(", ") || "no access",
          },
        ];
      default: {
        const files = splitPlan?.groups.length ?? 0;
        const covered = splitPlan
          ? splitPlan.groups.reduce((total, group) => total + group.pages.length, 0)
          : 0;
        return [
          { label: "Total Resulting Files", value: `${files} PDF${files === 1 ? "" : "s"}` },
          {
            label: "Total Pages Covered",
            value: `${covered} of ${pdfPreview?.pageCount ?? "?"} pages`,
          },
          { label: "Estimated Download", value: "—" },
        ];
      }
    }
  })();
  const studioFields = (
    <>
      {selectedToolId === "mergePdf" ? (
        <>
          <label className="split-setting-field">
            <span>Output File Name</span>
            <input
              onChange={(event) =>
                setForm((current) => ({ ...current, output: event.target.value }))
              }
              placeholder="merged.pdf"
              value={form.output}
            />
          </label>
          <p className="split-setting-hint">
            Used as the suggested name when saving the merged PDF.
          </p>
          <div className="split-attribute-card">
            <strong>Preserve Document Bookmarks</strong>
            <small>Keeps original outlines and internal navigation in the merged document.</small>
          </div>
        </>
      ) : null}
      {selectedToolId === "jpgToPdf" ? (
        <>
          <div className="split-field-grid">
            <label className="split-setting-field">
              <span>Page Size</span>
              <select
                onChange={(event) =>
                  setForm((current) => ({ ...current, pageSize: event.target.value }))
                }
                value={form.pageSize}
              >
                <option value="auto">Auto</option>
                <option value="a4">A4</option>
                <option value="letter">Letter</option>
              </select>
            </label>
            <label className="split-setting-field">
              <span>Fit Mode</span>
              <select
                onChange={(event) =>
                  setForm((current) => ({ ...current, fitMode: event.target.value }))
                }
                value={form.fitMode}
              >
                <option value="fit">Fit</option>
                <option value="fill">Fill</option>
              </select>
            </label>
          </div>
          <label className="split-setting-field">
            <span>Margin (mm)</span>
            <input
              max={50}
              min={0}
              onChange={(event) =>
                setForm((current) => ({ ...current, marginMm: Number(event.target.value) }))
              }
              type="number"
              value={form.marginMm}
            />
          </label>
        </>
      ) : null}
      {selectedToolId === "compressPdf" ? (
        <label className="split-setting-field">
          <span>Compression Profile</span>
          <select
            onChange={(event) =>
              setForm((current) => ({
                ...current,
                profile: event.target.value as FormState["profile"],
              }))
            }
            value={form.profile}
          >
            <option value="safe">Safe — lossless optimization</option>
            <option value="balanced">Balanced — recommended</option>
            <option value="small">Small — softest images</option>
          </select>
        </label>
      ) : null}
      {selectedToolId === "pdfToJpg" ? (
        <div className="split-field-grid">
          <label className="split-setting-field">
            <span>DPI</span>
            <input
              max={600}
              min={72}
              onChange={(event) =>
                setForm((current) => ({ ...current, dpi: Number(event.target.value) }))
              }
              type="number"
              value={form.dpi}
            />
          </label>
          <label className="split-setting-field">
            <span>JPG Quality</span>
            <input
              max={100}
              min={1}
              onChange={(event) =>
                setForm((current) => ({ ...current, quality: Number(event.target.value) }))
              }
              type="number"
              value={form.quality}
            />
          </label>
        </div>
      ) : null}
      {selectedToolId === "unlockPdf" ? (
        <label className="split-setting-field">
          <span>Password</span>
          <input
            onChange={(event) =>
              setForm((current) => ({ ...current, password: event.target.value }))
            }
            type="password"
            value={form.password}
          />
        </label>
      ) : null}
      {selectedToolId === "protectPdf" ? (
        <>
          <label className="split-setting-field">
            <span>User Password</span>
            <input
              onChange={(event) =>
                setForm((current) => ({ ...current, userPassword: event.target.value }))
              }
              type="password"
              value={form.userPassword}
            />
          </label>
          <label className="split-setting-field">
            <span>Owner Password</span>
            <input
              onChange={(event) =>
                setForm((current) => ({ ...current, ownerPassword: event.target.value }))
              }
              type="password"
              value={form.ownerPassword}
            />
          </label>
          <label className="split-zip-row">
            <span>
              <strong>Allow printing</strong>
            </span>
            <input
              checked={form.allowPrinting}
              onChange={(event) =>
                setForm((current) => ({ ...current, allowPrinting: event.target.checked }))
              }
              type="checkbox"
            />
          </label>
          <label className="split-zip-row">
            <span>
              <strong>Allow copying</strong>
            </span>
            <input
              checked={form.allowCopying}
              onChange={(event) =>
                setForm((current) => ({ ...current, allowCopying: event.target.checked }))
              }
              type="checkbox"
            />
          </label>
          <label className="split-zip-row">
            <span>
              <strong>Allow modification</strong>
            </span>
            <input
              checked={form.allowModification}
              onChange={(event) =>
                setForm((current) => ({ ...current, allowModification: event.target.checked }))
              }
              type="checkbox"
            />
          </label>
        </>
      ) : null}
    </>
  );
  const studioMain = (
    <>
      {selectedToolId === "mergePdf" || selectedToolId === "jpgToPdf" ? (
        <MergeQueueCard
          draggedId={draggedMergePath}
          files={form.inputs}
          frames={mergeFrames}
          tool={selectedToolId}
          onAddFiles={pickFiles}
          onDragEnd={() => setDraggedMergePath(null)}
          onDragStart={setDraggedMergePath}
          onMove={moveMergeItem}
          onRemove={removeFile}
        />
      ) : null}
      {selectedToolId === "splitPdf" ? (
        <SplitGroupsCard
          groups={splitGroups}
          pageCount={pdfPreview?.pageCount ?? null}
          plan={splitPlan}
          onGroupsChange={setSplitGroups}
        />
      ) : null}
      {selectedToolId === "organizePdf" ? (
        <section className="studio-card split-preview-card">
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
        </section>
      ) : null}
    </>
  );
  const studioPreview =
    selectedToolId === "organizePdf" ? null : selectedToolId === "mergePdf" ||
      selectedToolId === "jpgToPdf" ? (
      <PageFlowCard
        files={form.inputs}
        frames={mergeFrames}
        tool={selectedToolId}
        visibleCount={previewVisibleCount}
        onExpand={() => setPreviewVisibleCount(SHOW_ALL_PREVIEW_LIMIT)}
        onZoomFile={(path, page) => void openPageZoom(path, page, basename(path))}
      />
    ) : (
      <section className="studio-card split-preview-card">
        <PdfPreviewGrid
          error={previewError}
          isLoading={isPreviewLoading}
          onShowAll={() => setPreviewVisibleCount(SHOW_ALL_PREVIEW_LIMIT)}
          onShowMore={() =>
            setPreviewVisibleCount((current) => current + DEFAULT_VISIBLE_PAGES)
          }
          onZoomPage={(page) => void openPageZoom(form.input, page, selectedTool.title)}
          preview={pdfPreview}
          title="Document Preview"
          titleIcon={<BookOpen size={16} />}
          visibleCount={previewVisibleCount}
        />
      </section>
    );

  useEffect(() => {
    if (!isStudioTool(selectedToolId) || activeView !== selectedToolId) return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "enter" && canRunSelectedTool) {
        event.preventDefault();
        void runSelectedJob();
      } else if (key === "o") {
        event.preventDefault();
        void pickFiles();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [activeView, canRunSelectedTool, form, splitGroups]);


  return (
    <main
      className={`app-shell ${isNativeSidebarCollapsed ? "native-sidebar-collapsed" : ""}${
        isMobileNavOpen ? " mobile-nav-open" : ""
      }`}
    >
      <div className="window-drag-strip" data-tauri-drag-region />
      <header className="mobile-bar">
        <button
          aria-expanded={isMobileNavOpen}
          aria-label="Open navigation"
          className="mobile-bar-button"
          onClick={() => setIsMobileNavOpen(true)}
          type="button"
        >
          <Menu size={20} />
        </button>
        <span className="mobile-bar-brand">Pidef</span>
        <button
          aria-label={resolvedTheme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          className="mobile-bar-button"
          onClick={() => setAppearance(resolvedTheme === "dark" ? "light" : "dark")}
          type="button"
        >
          {resolvedTheme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </header>
      <div
        aria-hidden="true"
        className={`sidebar-backdrop ${isMobileNavOpen ? "visible" : ""}`}
        onClick={() => setIsMobileNavOpen(false)}
      />
      <section className={`sidebar ${isMobileNavOpen ? "open" : ""}`}>
        <div className="brand" data-tauri-drag-region>
          <div>
            <h1>Pidef</h1>
          </div>
          <button
            aria-label="Close navigation"
            className="sidebar-close"
            onClick={() => setIsMobileNavOpen(false)}
            type="button"
          >
            <X size={17} />
          </button>
        </div>

        <div className="tool-list">
          <button
            className={`tool-button ${isHomeView ? "selected" : ""}`}
            onClick={() => {
              setActiveView("home");
              setIsMobileNavOpen(false);
            }}
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
            onClick={() => {
              setActiveView("history");
              setIsMobileNavOpen(false);
            }}
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
            onClick={() => {
              setActiveView("settings");
              setIsMobileNavOpen(false);
            }}
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

      <section
        ref={workspaceRef}
        className={
          isHomeView
            ? "workspace workspace-home"
            : isStudioView && activeView === selectedToolId
              ? "workspace workspace-split"
              : "workspace"
        }
      >
        {isHomeView || (isStudioView && activeView === selectedToolId) ? (
          <div aria-hidden="true" className="home-orb-layer">
            <div className="home-orb home-orb-a" />
            <div className="home-orb home-orb-b" />
            <div className="home-orb home-orb-c" />
            <div className="home-orb home-orb-d" />
            <div className="home-orb home-orb-e" />
          </div>
        ) : null}
        {!isHomeView ? (
          <header
            className={`topbar${
              isStudioView && activeView === selectedToolId
                ? hasSelectedFiles
                  ? " split-topbar-loaded"
                  : " split-topbar-empty"
                : ""
            }`}
          >
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
            {isStudioView && activeView === selectedToolId && hasSelectedFiles ? (
              selectedTool.needsMultipleInputs ? (
                <div className="topbar-actions">
                  <button className="topbar-ghost-pill" onClick={clearAllFiles} type="button">
                    Clear All
                  </button>
                  <button className="topbar-solid-pill" onClick={pickFiles} type="button">
                    <Plus size={14} />
                    Add More Files
                  </button>
                </div>
              ) : (
                <SplitFileChip
                  file={form.input}
                  fileSize={sourceFileSize}
                  pageCount={pdfPreview?.pageCount ?? null}
                  onReplace={pickFiles}
                />
              )
            ) : (
              <button className="icon-button" onClick={refreshRuntime} type="button" title="Refresh">
                <RefreshCw size={18} />
              </button>
            )}
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
        ) : isStudioView ? (
          <OperationStudio
            canRun={canRunSelectedTool}
            dragging={isDraggingFiles}
            fields={studioFields}
            hasFile={hasSelectedFiles}
            mainCards={studioMain}
            packageZip={packageZip}
            packageZipAvailable={selectedToolId === "splitPdf" || selectedToolId === "pdfToJpg"}
            pattern={form.outputPattern}
            previewCard={studioPreview}
            recentFiles={restorableRecentFiles}
            running={activeJob?.status === "running"}
            runLabel={studioRunLabel}
            showPattern={selectedToolId === "splitPdf"}
            summary={studioSummary}
            tool={selectedToolId}
            onPackageZipChange={setPackageZip}
            onPatternChange={(pattern) =>
              setForm((current) => ({ ...current, outputPattern: pattern }))
            }
            onPickFiles={pickFiles}
            onReset={selectedToolId === "splitPdf" ? resetSplitConfiguration : undefined}
            onRun={() => void runSelectedJob()}
            onSelectRecent={(path) => applySelectedFiles([path])}
          />
        ) : null}
      </section>
      {activeJob &&
      isStudioTool(activeJob.tool) &&
      activeJob.status === "complete" &&
      activeJob.result ? (
        <StudioOutputModal
          canPreview={activeJob.tool !== "pdfToJpg"}
          chips={
            activeJob.tool === "mergePdf"
              ? form.inputs.map((path, index) => {
                  const pages = mergeFrames[path]?.pageCount ?? 0;
                  const start =
                    1 +
                    form.inputs
                      .slice(0, index)
                      .reduce((sum, item) => sum + (mergeFrames[item]?.pageCount ?? 0), 0);
                  const range =
                    pages === 1
                      ? ` (p. ${start})`
                      : pages > 1
                        ? ` (pp. ${start}-${start + pages - 1})`
                        : "";
                  return `${index + 1}. ${basename(path)}${range}`;
                })
              : undefined
          }
          chipsLabel="Included documents in order"
          job={activeJob}
          packageZip={packageZip}
          readyTitle={activeJob.tool === "mergePdf" ? "Merged PDF Ready for Export" : undefined}
          rowLabels={
            activeJob.tool === "splitPdf"
              ? (splitPlan?.groups.map((group) => group.label) ?? [])
              : activeJob.tool === "pdfToJpg"
                ? activeJob.result.outputs.map((_, index) => `Page ${index + 1}`)
                : activeJob.tool === "mergePdf"
                  ? [
                      `${form.inputs.reduce(
                        (sum, path) => sum + (mergeFrames[path]?.pageCount ?? 0),
                        0,
                      )} pages`,
                    ]
                  : []
          }
          showZip={activeJob.tool === "splitPdf" || activeJob.tool === "pdfToJpg"}
          summaryLine={
            activeJob.tool === "compressPdf"
              ? activeJob.message
              : activeJob.tool === "mergePdf"
                ? `${form.inputs.length} documents consolidated into one PDF with page fidelity preserved.`
                : null
          }
          onClose={() => invalidateToolJobs(activeJob.tool)}
          onPreview={(output) => void openPageZoom(output, 1, basename(output))}
          onSaveAll={() => void saveStudioAll(activeJob)}
          onSaveRow={(output) => void saveStudioRow(activeJob, output)}
        />
      ) : null}
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

function groupPageCount(group: string, pageCount: number): number | null {
  const plan = parseSplitPlan(group, pageCount);
  if (!plan) return null;
  return plan.groups.reduce((total, item) => total + item.pages.length, 0);
}

type StudioCopy = {
  dropCopy: string;
  dropTitle: string;
  cta: string;
  steps: Array<[string, string, string]>;
  tip: ReactNode;
};

function studioCopy(tool: ToolId): StudioCopy {
  switch (tool) {
    case "organizePdf":
      return {
        dropCopy: "Reorder, rotate, duplicate, or remove pages, then export the arranged document.",
        dropTitle: "Drop your PDF here",
        cta: "Choose File",
        steps: [
          ["01", "Arrange Pages", "Drag page cards to reorder whole sections, or fine-tune individual boundaries."],
          ["02", "Rotate & Prune", "Rotate sideways scans, duplicate repeated pages, or delete what you do not need."],
          ["03", "One-Click Export", "The arranged document is written locally with page fidelity preserved."],
        ],
        tip: "Use the eye button on any page card to inspect it at full size before exporting.",
      };
    case "compressPdf":
      return {
        dropCopy: "Choose a preset and shrink this PDF without the file leaving your machine.",
        dropTitle: "Drop your PDF here",
        cta: "Choose File",
        steps: [
          ["01", "Choose a Preset", "Safe stays fully lossless; Balanced and Small re-encode oversized photos."],
          ["02", "Smart Downsampling", "High-resolution images are resampled only when they exceed practical DPI."],
          ["03", "Verify Savings", "You see the exact reduction before deciding where to save the result."],
        ],
        tip: "Balanced is a good default. Small re-encodes photos more aggressively and may soften fine detail.",
      };
    case "pdfToJpg":
      return {
        dropCopy: "Render every page into a crisp JPG image, either as loose files or one ZIP bundle.",
        dropTitle: "Drop your PDF here",
        cta: "Choose File",
        steps: [
          ["01", "Pick Resolution", "200 DPI matches a crisp screen; 300 DPI stands up to print."],
          ["02", "True-to-Page Rendering", "Each page is rasterized exactly as it renders, annotations included."],
          ["03", "Individual or Zipped", "Save every page on its own, or bundle the whole document as a ZIP."],
        ],
        tip: "Lower the quality to keep a whole photo-heavy document under a size limit.",
      };
    case "unlockPdf":
      return {
        dropCopy: "Remove a known password so the document opens anywhere, verified entirely on-device.",
        dropTitle: "Drop your PDF here",
        cta: "Choose File",
        steps: [
          ["01", "Provide the Password", "Pidef asks for the document password you already know."],
          ["02", "Local Decryption", "The decryption happens on this machine — nothing is uploaded."],
          ["03", "Save the Copy", "Write an unprotected copy and keep the original untouched."],
        ],
        tip: "Pidef cannot guess passwords; it only removes protection you can already open.",
      };
    case "protectPdf":
      return {
        dropCopy: "Encrypt this PDF with a password and decide exactly what readers may do with it.",
        dropTitle: "Drop your PDF here",
        cta: "Choose File",
        steps: [
          ["01", "Set Passwords", "A user password to open, and an owner password for full control."],
          ["02", "Choose Permissions", "Allow or block printing, copying, and modification independently."],
          ["03", "AES-256 Encryption", "Modern encryption, applied locally with no upload."],
        ],
        tip: "Keep the owner password somewhere safe — without it, permissions cannot be changed later.",
      };
    case "mergePdf":
      return {
        dropCopy:
          "Select multiple PDF documents from your workstation to arrange order, unify page flow, and merge into a single master document.",
        dropTitle: "Drop multiple PDFs here",
        cta: "Choose Files",
        steps: [
          ["01", "Sequence & Reorder", "Drag documents into target reading order or sort alphabetically with custom priority."],
          ["02", "Bookmark & Outline Sync", "Retain original document outlines, table of contents hierarchy, and internal navigational links."],
          ["03", "Full Quality Retention", "Maintain vector paths, embedded typography, high-resolution imagery, and exact color profiles."],
        ],
        tip: "You can drag and drop additional PDFs directly into the Document Queue to append them instantly without restarting.",
      };
    case "jpgToPdf":
      return {
        dropCopy: "Select JPG images from your workstation to arrange them into one clean PDF document.",
        dropTitle: "Drop your JPG images here",
        cta: "Choose Files",
        steps: [
          ["01", "Image Sequence", "Drag image cards into reading order; each image becomes one page."],
          ["02", "Page Layout", "Choose a page size and how images fit the sheet, with an optional margin."],
          ["03", "One-Click Export", "All images are assembled locally into a single PDF document."],
        ],
        tip: "Auto page size matches each sheet exactly to the image dimensions.",
      };
    case "splitPdf":
      default:
      return {
        dropCopy: "Select a PDF document from your workstation to configure segments, single-page splits, or customized range sequences.",
        dropTitle: "Drop your PDF here",
        cta: "Choose File",
        steps: [
          ["01", "Target Ranges", "Define discrete brackets such as 1-4, 5-8, or standalone single pages to generate isolated volumes."],
          ["02", "Visual Page Grid", "Inspect every page below, zoom thumbnails, and verify boundaries before you commit the split."],
          ["03", "One-Click Export", "Receive a structured .zip bundle with intelligent naming, or save each document individually."],
        ],
        tip: (
          <>
            Quickly split by entering comma-separated numbers or hyphenated spans like{" "}
            <code>1-3, 5, 7-10</code> in any group.
          </>
        ),
      };
  }
}

function OperationStudio({
  canRun,
  dragging,
  fields,
  hasFile,
  mainCards,
  packageZip,
  packageZipAvailable,
  pattern,
  previewCard,
  recentFiles,
  running,
  runLabel,
  showPattern,
  summary,
  tool,
  onPackageZipChange,
  onPatternChange,
  onPickFiles,
  onReset,
  onRun,
  onSelectRecent,
}: {
  canRun: boolean;
  dragging: boolean;
  fields: ReactNode;
  hasFile: boolean;
  mainCards: ReactNode;
  packageZip: boolean;
  packageZipAvailable: boolean;
  pattern: string;
  previewCard: ReactNode;
  recentFiles: string[];
  running: boolean;
  runLabel: string;
  showPattern: boolean;
  summary: Array<{ label: string; value: string }>;
  tool: ToolId;
  onPackageZipChange: (value: boolean) => void;
  onPatternChange: (value: string) => void;
  onPickFiles: () => void;
  onReset?: () => void;
  onRun: () => void;
  onSelectRecent: (path: string) => void;
}) {
  const copy = studioCopy(tool);
  const Icon = toolById[tool].icon;

  return (
    <div className={`split-studio ${hasFile || recentFiles.length > 0 ? "" : "split-studio-solo"}`}>
      <div className="split-studio-main">
        {hasFile ? (
          <>
            {mainCards}
            {previewCard}
          </>
        ) : (
          <StudioDropCard
            copy={copy}
            dragging={dragging}
            icon={<Icon size={22} strokeWidth={1.7} />}
            onPickFiles={onPickFiles}
          />
        )}
      </div>
      {hasFile || recentFiles.length > 0 ? (
        <aside className="split-studio-aside">
          {hasFile ? (
            <>
              <StudioOutputSettings
                canRun={canRun}
                fields={fields}
                packageZip={packageZip}
                packageZipAvailable={packageZipAvailable}
                pattern={pattern}
                runLabel={runLabel}
                running={running}
                showPattern={showPattern}
                summary={summary}
                onPackageZipChange={onPackageZipChange}
                onPatternChange={onPatternChange}
                onReset={onReset}
                onRun={onRun}
              />
              <StudioTipCard>{copy.tip}</StudioTipCard>
            </>
          ) : (
            <SplitRecentPanel files={recentFiles} onSelect={onSelectRecent} />
          )}
        </aside>
      ) : null}
      {!hasFile ? (
        <div className="split-studio-full">
          <StudioInfoCards steps={copy.steps} />
        </div>
      ) : null}
    </div>
  );
}

function StudioDropCard({
  copy,
  dragging,
  icon,
  onPickFiles,
}: {
  copy: StudioCopy;
  dragging: boolean;
  icon: ReactNode;
  onPickFiles: () => void;
}) {
  return (
    <section className={`studio-card split-drop-card ${dragging ? "dragging" : ""}`}>
      <div className="split-drop-body">
        <span className="split-drop-icon">
          {icon}
          <em>+</em>
        </span>
        <h2>{copy.dropTitle}</h2>
        <p>{copy.dropCopy}</p>
        <button className="split-drop-cta" onClick={onPickFiles} type="button">
          <FilePlus2 size={15} />
          {copy.cta}
          <kbd>&#8984;O</kbd>
        </button>
      </div>
    </section>
  );
}

function StudioInfoCards({ steps }: { steps: Array<[string, string, string]> }) {
  return (
    <section className="split-info-cards">
      {steps.map(([number, title, copy]) => (
        <div className="split-info-card" key={number}>
          <span className="split-info-number">{number}</span>
          <div>
            <strong>{title}</strong>
            <p>{copy}</p>
          </div>
        </div>
      ))}
    </section>
  );
}

function MergeQueueCard({
  files,
  frames,
  draggedId,
  tool,
  onAddFiles,
  onDragEnd,
  onDragStart,
  onMove,
  onRemove,
}: {
  files: string[];
  frames: Record<string, { pages: { page: number; dataUrl: string }[]; pageCount: number; size: number | null }>;
  draggedId: string | null;
  tool: ToolId;
  onAddFiles: () => void;
  onDragEnd: () => void;
  onDragStart: (path: string) => void;
  onMove: (sourcePath: string, targetPath: string) => void;
  onRemove: (path: string) => void;
}) {
  const isImages = tool === "jpgToPdf";

  function startRowDrag(event: PointerEvent<HTMLElement>, path: string) {
    if ((event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    onDragStart(path);
  }

  return (
    <section className="studio-card">
      <div className="studio-card-heading">
        <h3>
          <ListOrdered size={16} />
          {isImages ? "Image Queue" : "Document Queue"}
        </h3>
        <span className="queue-hint">
          <GripVertical size={13} />
          Drag rows to reorder
        </span>
      </div>
      <p className="queue-caption">
        {files.length} {isImages ? "images" : "documents"} arranged in assembly order
      </p>
      <div className="split-queue-rows">
        {files.map((path, index) => {
          const frame = frames[path];
          const metaParts = [
            frame && frame.pageCount > 0
              ? `${frame.pageCount} page${frame.pageCount === 1 ? "" : "s"}`
              : null,
            frame?.size ? formatBytes(frame.size) : null,
          ].filter(Boolean);
          return (
            <div
              className={`split-queue-row ${draggedId === path ? "dragging" : ""}`}
              key={path}
              onPointerCancel={onDragEnd}
              onPointerDown={(event) => startRowDrag(event, path)}
              onPointerEnter={(event) => {
                event.stopPropagation();
                if (draggedId) onMove(draggedId, path);
              }}
              onPointerUp={(event) => {
                event.stopPropagation();
                onDragEnd();
              }}
            >
              <span className="split-queue-grip">
                <GripVertical size={15} />
              </span>
              <span className="split-group-index">{index + 1}</span>
              <div className="split-queue-meta">
                <strong>{basename(path)}</strong>
                <small>{metaParts.length > 0 ? metaParts.join(" • ") : "…"}</small>
              </div>
              <button
                className="split-group-remove"
                onClick={() => onRemove(path)}
                title="Remove"
                type="button"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button className="split-group-add" onClick={onAddFiles} type="button">
        <Plus size={15} />
        Add {isImages ? "Image" : "Document"} to Queue
      </button>
    </section>
  );
}

function PageFlowCard({
  files,
  frames,
  tool,
  visibleCount,
  onExpand,
  onZoomFile,
}: {
  files: string[];
  frames: Record<string, { pages: { page: number; dataUrl: string }[]; pageCount: number; size: number | null }>;
  tool: ToolId;
  visibleCount: number;
  onExpand: () => void;
  onZoomFile: (path: string, page: number) => void;
}) {
  const entries: Array<{ path: string; page: number; dataUrl: string; docIndex: number }> = [];
  files.forEach((path, docIndex) => {
    for (const frame of frames[path]?.pages ?? []) {
      entries.push({ path, page: frame.page, dataUrl: frame.dataUrl, docIndex });
    }
  });
  const totalPages = files.reduce((sum, path) => sum + (frames[path]?.pageCount ?? 0), 0);
  if (entries.length === 0) return null;

  const shown = entries.slice(0, visibleCount);
  const remaining = totalPages - shown.length;
  const isImages = tool === "jpgToPdf";

  return (
    <section className="studio-card split-preview-card">
      <div className="preview-heading">
        <strong>
          <BookOpen size={16} />
          <span>{isImages ? "Unified Image Flow" : "Unified Page Flow"}</span>
          <em className="flow-chip">{totalPages} Total Pages</em>
        </strong>
        <span className="flow-hint">
          <Eye size={13} />
          Click any page to preview high-res
        </span>
      </div>
      <div className="preview-grid">
        {shown.map((entry) => (
          <figure
            className="preview-thumb clickable"
            key={`${entry.path}-${entry.page}`}
            onClick={() => onZoomFile(entry.path, entry.page)}
          >
            <img alt={`Page ${entry.page}`} draggable={false} src={entry.dataUrl} />
            <span
              className={`thumb-doc-badge hue-${GROUP_HUES[entry.docIndex % GROUP_HUES.length]}`}
            >
              {isImages ? `Img ${entry.docIndex + 1}` : `Doc ${entry.docIndex + 1}`}
            </span>
            <figcaption>Pg {entry.page}</figcaption>
          </figure>
        ))}
      </div>
      {remaining > 0 ? (
        <div className="flow-footer">
          <span className="flow-dots">
            {GROUP_HUES.slice(0, Math.min(3, files.length)).map((hue) => (
              <i className={`hue-${hue}`} key={hue} />
            ))}
          </span>
          <span>
            … and {remaining} more page{remaining === 1 ? "" : "s"} following the{" "}
            {isImages ? "image" : "document"} sequence
          </span>
          <button className="flow-expand" onClick={onExpand} type="button">
            Expand grid view <ArrowRight size={13} />
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SplitGroupsCard({
  groups,
  pageCount,
  plan,
  onGroupsChange,
}: {
  groups: string[];
  pageCount: number | null;
  plan: SplitPlan | null;
  onGroupsChange: (groups: string[]) => void;
}) {
  const resolvedPageCount = pageCount ?? 0;
  const rowCounts = groups.map((group) => groupPageCount(group, resolvedPageCount));

  return (
    <section className="studio-card">
      <div className="studio-card-heading">
        <h3>
          <ListOrdered size={16} />
          Split Groups
        </h3>
        <span>
          {plan
            ? `${plan.groups.length} partition${plan.groups.length === 1 ? "" : "s"}`
            : "define ranges"}
        </span>
      </div>
      <div className="split-group-rows">
        {groups.map((group, index) => {
          const count = rowCounts[index];
          const invalid = group.trim().length > 0 && count === null;
          return (
            <div className={`split-group-row ${invalid ? "invalid" : ""}`} key={index}>
              <span className="split-group-index">{index + 1}</span>
              <input
                aria-label={`Split group ${index + 1}`}
                className="split-group-input"
                onChange={(event) =>
                  onGroupsChange(
                    groups.map((value, position) =>
                      position === index ? event.target.value : value,
                    ),
                  )
                }
                placeholder="1-3, 5, 7-10"
                value={group}
              />
              <span className="split-group-count">
                {count === null ? "—" : `${count} page${count === 1 ? "" : "s"}`}
              </span>
              <button
                className="split-group-remove"
                onClick={() =>
                  onGroupsChange(
                    groups.length === 1
                      ? [""]
                      : groups.filter((_, position) => position !== index),
                  )
                }
                title="Remove group"
                type="button"
              >
                <X size={14} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        className="split-group-add"
        onClick={() => onGroupsChange([...groups, ""])}
        type="button"
      >
        <Plus size={15} />
        Add Split Group
      </button>
      {plan?.trimmed ? (
        <p className="field-hint">Ranges past page {pageCount ?? "?"} were ignored.</p>
      ) : !plan && groups.some((group) => group.trim()) ? (
        <p className="field-hint">No pages match these ranges.</p>
      ) : null}
    </section>
  );
}

function StudioOutputSettings({
  canRun,
  fields,
  packageZip,
  packageZipAvailable,
  pattern,
  runLabel,
  running,
  showPattern,
  summary,
  onPackageZipChange,
  onPatternChange,
  onReset,
  onRun,
}: {
  canRun: boolean;
  fields: ReactNode;
  packageZip: boolean;
  packageZipAvailable: boolean;
  pattern: string;
  runLabel: string;
  running: boolean;
  showPattern: boolean;
  summary: Array<{ label: string; value: string }>;
  onPackageZipChange: (value: boolean) => void;
  onPatternChange: (value: string) => void;
  onReset?: () => void;
  onRun: () => void;
}) {
  return (
    <section className="studio-card">
      <div className="studio-card-heading">
        <h3>
          <SlidersHorizontal size={16} />
          Output Settings
        </h3>
      </div>
      {showPattern ? (
        <>
          <label className="split-setting-field">
            <span>File Naming Format</span>
            <input onChange={(event) => onPatternChange(event.target.value)} value={pattern} />
          </label>
          <p className="split-setting-hint">
            Variables: <code>{"{filename}"}</code>, <code>{"{n}"}</code>,{" "}
            <code>{"{range}"}</code>
          </p>
        </>
      ) : null}
      {fields}
      {packageZipAvailable ? (
        <label className="split-zip-row">
          <span>
            <strong>Package into ZIP archive</strong>
            <small>Bundle all generated files together</small>
          </span>
          <input
            checked={packageZip}
            onChange={(event) => onPackageZipChange(event.target.checked)}
            type="checkbox"
          />
        </label>
      ) : null}
      <div className="split-summary">
        {summary.map((row) => (
          <div key={row.label}>
            <span>{row.label}</span>
            <strong>{row.value}</strong>
          </div>
        ))}
      </div>
      <button
        className="split-run-pill"
        disabled={!canRun || running}
        onClick={onRun}
        type="button"
      >
        {running ? <Loader2 className="spin" size={15} /> : <ListOrdered size={15} />}
        <span>{running ? "Working…" : runLabel}</span>
        <kbd>&#8984;&#8629;</kbd>
      </button>
      {onReset ? (
        <button className="split-reset-button" onClick={onReset} type="button">
          Reset Configuration
        </button>
      ) : null}
    </section>
  );
}

function StudioTipCard({ children }: { children: ReactNode }) {
  return (
    <section className="studio-card split-tip-card">
      <Lightbulb size={16} />
      <p>{children}</p>
    </section>
  );
}

function SplitFileChip({
  file,
  fileSize,
  pageCount,
  onReplace,
}: {
  file: string;
  fileSize: number | null;
  pageCount: number | null;
  onReplace: () => void;
}) {
  return (
    <div className="split-file-chip">
      <span className="split-file-chip-icon">
        <FileText size={16} />
      </span>
      <div className="split-file-chip-meta">
        <strong>{basename(file)}</strong>
        <small>
          {pageCount
            ? `${pageCount} ${pageCount === 1 ? "Page" : "Pages"}`
            : "Reading…"}
          {fileSize ? ` · ${formatBytes(fileSize)}` : ""}
        </small>
      </div>
      <button className="split-chip-replace" onClick={onReplace} type="button">
        <ArrowLeftRight size={13} />
        Replace
      </button>
    </div>
  );
}

function SplitRecentPanel({
  files,
  onSelect,
}: {
  files: string[];
  onSelect: (path: string) => void;
}) {
  const [sizes, setSizes] = useState<Record<string, number>>({});

  useEffect(() => {
    let isCancelled = false;
    for (const file of files) {
      void invokeCommand<number>("get_file_size", { path: file })
        .then((size) => {
          if (!isCancelled) {
            setSizes((current) => ({ ...current, [file]: size }));
          }
        })
        .catch(() => {});
    }
    return () => {
      isCancelled = true;
    };
  }, [files.join("|")]);

  return (
    <section className="studio-card split-recent-panel">
      <div className="studio-card-heading">
        <h3>
          <Clock3 size={15} />
          Recent Documents
        </h3>
      </div>
      <div className="split-recent-list">
        {files.slice(0, 3).map((path) => (
          <div className="split-recent-row" key={path}>
            <span className="split-recent-icon">
              <FileText size={15} />
            </span>
            <div className="split-recent-meta">
              <strong>{basename(path)}</strong>
              <small>{sizes[path] ? formatBytes(sizes[path]) : "…"}</small>
            </div>
            <button className="split-recent-select" onClick={() => onSelect(path)} type="button">
              Select
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function StudioOutputModal({
  canPreview,
  chips,
  chipsLabel,
  job,
  packageZip,
  readyTitle,
  rowLabels,
  showZip,
  summaryLine,
  onClose,
  onPreview,
  onSaveAll,
  onSaveRow,
}: {
  canPreview: boolean;
  chips?: string[];
  chipsLabel?: string;
  job: JobState;
  packageZip: boolean;
  readyTitle?: string;
  rowLabels: string[];
  showZip: boolean;
  summaryLine?: string | null;
  onClose: () => void;
  onPreview: (output: string) => void;
  onSaveAll: () => void;
  onSaveRow: (output: string) => void;
}) {
  const result = job.result;
  const [sizes, setSizes] = useState<Record<string, number>>({});

  useEffect(() => {
    if (!result) return;
    let isCancelled = false;
    for (const output of result.outputs) {
      void invokeCommand<number>("get_file_size", { path: output })
        .then((size) => {
          if (!isCancelled) {
            setSizes((current) => ({ ...current, [output]: size }));
          }
        })
        .catch(() => {});
    }
    return () => {
      isCancelled = true;
    };
  }, [result?.outputs.join("|")]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  if (!result) return null;

  const count = result.outputs.length;
  const total = result.outputBytes ? formatBytes(result.outputBytes) : "—";
  const zipActive = showZip && packageZip && count > 1;
  const primaryLabel =
    count === 1
      ? `Save As (${total})`
      : zipActive
        ? `Download All (ZIP • ${total})`
        : `Save All (${total})`;

  return (
    <div className="split-modal-overlay" onClick={onClose} role="presentation">
      <div className="split-modal" onClick={(event) => event.stopPropagation()} role="dialog">
        <button className="split-modal-close" onClick={onClose} title="Close" type="button">
          <X size={15} />
        </button>
        <div className="split-modal-heading">
          <span className="split-modal-check">
            <CheckCircle2 size={22} />
          </span>
          <div>
            <em>{toolById[job.tool].title} complete</em>
            <h2>
              {readyTitle ??
                (count === 1 ? "1 File Ready for Export" : `${count} Files Ready for Export`)}
            </h2>
            <p>
              {summaryLine ??
                "Your documents have been generated locally with page fidelity preserved."}
            </p>
          </div>
        </div>
        <div className="split-modal-list-heading">
          <span>Generated documents</span>
          <span>Total: {total}</span>
        </div>
        <div className="split-modal-list">
          {result.outputs.map((output, index) => (
            <div className="split-modal-row" key={output}>
              <span className="split-modal-row-icon">
                <FileText size={16} />
              </span>
              <div className="split-modal-row-meta">
                <strong>{basename(output)}</strong>
                <small>
                  {rowLabels[index] ? `${rowLabels[index]} · ` : ""}
                  {sizes[output] ? formatBytes(sizes[output]) : "…"}
                </small>
              </div>
              {canPreview ? (
                <button className="split-modal-preview" onClick={() => onPreview(output)} type="button">
                  <Eye size={14} />
                  <span>Preview</span>
                </button>
              ) : null}
              <button
                className="split-modal-download"
                onClick={() => onSaveRow(output)}
                title="Save"
                type="button"
              >
                <Download size={15} />
              </button>
            </div>
          ))}
        </div>
        {chips && chips.length > 0 ? (
          <>
            <div className="split-modal-list-heading">
              <span>{chipsLabel ?? "Included files in order"}</span>
              <span>
                {chips.length} {chips.length === 1 ? "File" : "Files"} Consumed
              </span>
            </div>
            <div className="split-modal-chips">
              {chips.map((chip) => (
                <span className="split-modal-chip" key={chip}>
                  {chip}
                </span>
              ))}
            </div>
          </>
        ) : null}
        <div className="split-modal-actions">
          <button className="split-modal-primary" onClick={onSaveAll} type="button">
            <Download size={15} />
            {primaryLabel}
          </button>
          <button className="split-modal-done" onClick={onClose} type="button">
            Done
          </button>
        </div>
      </div>
    </div>
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
  title = "Preview",
  titleIcon,
}: {
  preview: PdfPreview | null;
  isLoading: boolean;
  error: string | null;
  visibleCount: number;
  onShowAll: () => void;
  onShowMore: () => void;
  groupByPage?: Map<number, number>;
  onZoomPage?: (pageNumber: number) => void;
  title?: string;
  titleIcon?: ReactNode;
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
        <strong>
          {titleIcon}
          <span>{title}</span>
        </strong>
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
