fn main() {
    #[cfg(target_os = "macos")]
    {
        // Some SwiftUI features (and newer toolchains) reference the Swift
        // concurrency runtime through @rpath; without this the packaged app
        // fails at launch with "no LC_RPATH's found".
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");

        swift_rs::SwiftLinker::new("14.0")
            .with_package("MacNativeShell", "macos")
            .link();
    }

    tauri_build::build()
}
