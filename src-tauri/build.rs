fn main() {
    #[cfg(target_os = "macos")]
    swift_rs::SwiftLinker::new("14.0")
        .with_package("MacNativeShell", "macos")
        .link();

    tauri_build::build()
}
