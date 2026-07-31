#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use tauri::{Manager, Runtime};

    unsafe extern "C" {
        fn install_mac_native_shell(window: *mut c_void);
    }

    pub fn install<R: Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
        if let Some(window) = app.get_webview_window("main") {
            let ns_window = window.ns_window()?;
            unsafe { install_mac_native_shell(ns_window) };
        }

        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::Runtime;

    pub fn install<R: Runtime>(_app: &mut tauri::App<R>) -> tauri::Result<()> {
        Ok(())
    }
}

pub use imp::install;
