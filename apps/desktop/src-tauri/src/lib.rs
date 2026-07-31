// 벼린 — Tauri 2 library entry point.
// Keeping the runtime in `lib.rs` makes mobile targets (iOS/Android) trivial later.

mod tcp_bridge;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("안녕하세요, {name}! 벼린입니다.")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(tcp_bridge::TcpBridgeState::default())
        .invoke_handler(tauri::generate_handler![
            greet,
            tcp_bridge::tcp_open,
            tcp_bridge::tcp_write,
            tcp_bridge::tcp_close
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
