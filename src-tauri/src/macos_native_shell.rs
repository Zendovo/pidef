#[cfg(target_os = "macos")]
mod imp {
    use std::ffi::c_void;
    use tauri::{Manager, Runtime};

    unsafe extern "C" {
        fn install_mac_native_shell(window: *mut c_void);
        fn set_mac_native_sidebar_collapsed(window: *mut c_void, is_collapsed: i32);
    }

    pub fn install<R: Runtime>(app: &mut tauri::App<R>) -> tauri::Result<()> {
        if let Some(window) = app.get_webview_window("main") {
            let ns_window = window.ns_window()?;
            unsafe { install_mac_native_shell(ns_window) };
        }

        Ok(())
    }

    pub fn set_sidebar_collapsed<R: Runtime>(
        app: &tauri::AppHandle<R>,
        is_collapsed: bool,
    ) -> Result<(), String> {
        let Some(window) = app.get_webview_window("main") else {
            return Ok(());
        };
        let ns_window = window.ns_window().map_err(|error| error.to_string())?;
        unsafe { set_mac_native_sidebar_collapsed(ns_window, if is_collapsed { 1 } else { 0 }) };
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use tauri::Runtime;

    pub fn install<R: Runtime>(_app: &mut tauri::App<R>) -> tauri::Result<()> {
        Ok(())
    }

    pub fn set_sidebar_collapsed<R: Runtime>(
        _app: &tauri::AppHandle<R>,
        _is_collapsed: bool,
    ) -> Result<(), String> {
        Ok(())
    }
}

pub use imp::install;
pub use imp::set_sidebar_collapsed;
