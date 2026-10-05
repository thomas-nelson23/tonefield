// Prevents an extra console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // WebKitGTK's DMA-BUF renderer kills the app with "Error 71 (Protocol error)"
    // on NVIDIA + Wayland. Turn it off before the webview starts, unless the user
    // set the variable themselves, so launches from the app menu work too.
    #[cfg(target_os = "linux")]
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    physics_playground_lib::run()
}
