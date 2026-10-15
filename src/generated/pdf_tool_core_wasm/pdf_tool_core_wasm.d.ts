/* tslint:disable */
/* eslint-disable */

export class OptimizeResult {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly bytes: Uint8Array;
    readonly changed: number;
}

export class ProfileImageSettings {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    readonly jpeg_quality: number;
    readonly target_dpi: number;
    readonly trigger_dpi: number;
}

/**
 * qpdf arguments for a compression preset.
 */
export function compress_arguments_for(profile: string): string[];

/**
 * Builds a PDF from an array of JPEG image byte arrays.
 */
export function jpg_to_pdf(files: Array<any>, page_size: string, fit_mode: string, margin_mm: number): Uint8Array;

/**
 * Downsamples oversized JPEG images inside a qdf-staged PDF.
 */
export function optimize_qdf(data: Uint8Array, target_dpi: number, trigger_dpi: number, jpeg_quality: number): OptimizeResult;

/**
 * qpdf page specs for organize ("3", "3:rotate=+90"), with rotations in
 * degrees matching `pages` element-wise.
 */
export function organize_page_specs(pages: Uint32Array, rotations: Int16Array): string[];

/**
 * Image resampling settings for a preset, or undefined for lossless `safe`.
 */
export function profile_image_settings(profile: string): ProfileImageSettings | undefined;

/**
 * qpdf `--encrypt` arguments for protect.
 */
export function protect_arguments_for(user_password: string, owner_password: string, allow_printing: boolean, allow_copying: boolean, allow_modification: boolean): string[];

/**
 * qpdf page-range strings ("1", "3-5") for a ranges text input.
 */
export function qpdf_ranges(ranges: string): string[];

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_optimizeresult_free: (a: number, b: number) => void;
    readonly __wbg_profileimagesettings_free: (a: number, b: number) => void;
    readonly compress_arguments_for: (a: number, b: number) => [number, number, number, number];
    readonly jpg_to_pdf: (a: any, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly optimize_qdf: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly optimizeresult_bytes: (a: number) => [number, number];
    readonly optimizeresult_changed: (a: number) => number;
    readonly organize_page_specs: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly profile_image_settings: (a: number, b: number) => [number, number, number];
    readonly profileimagesettings_jpeg_quality: (a: number) => number;
    readonly profileimagesettings_target_dpi: (a: number) => number;
    readonly profileimagesettings_trigger_dpi: (a: number) => number;
    readonly protect_arguments_for: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number];
    readonly qpdf_ranges: (a: number, b: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
