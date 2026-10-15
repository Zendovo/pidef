import init, {
  compress_arguments_for,
  jpg_to_pdf,
  optimize_qdf,
  organize_page_specs,
  profile_image_settings,
  protect_arguments_for,
  qpdf_ranges,
  type OptimizeResult,
  type ProfileImageSettings,
} from "../generated/pdf_tool_core_wasm/pdf_tool_core_wasm";

let initPromise: Promise<void> | null = null;

export function loadCoreWasm(): Promise<void> {
  if (!initPromise) {
    initPromise = init().then(() => undefined);
  }
  return initPromise;
}

export {
  compress_arguments_for,
  jpg_to_pdf,
  optimize_qdf,
  organize_page_specs,
  profile_image_settings,
  protect_arguments_for,
  qpdf_ranges,
};
export type { OptimizeResult, ProfileImageSettings };
