mod midi;

use std::time::Duration;

/// How long a closed window may take to shut down before the process is ended.
/// WebKitGTK can hang tearing down a webview whose audio is still running, which
/// leaves the window stuck open with nothing left to close it.
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(midi::MidiState::default())
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                std::thread::spawn(|| {
                    std::thread::sleep(CLOSE_TIMEOUT);
                    std::process::exit(0);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            midi::midi_inputs,
            midi::midi_connect,
            midi::midi_disconnect,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tonefield");
}
