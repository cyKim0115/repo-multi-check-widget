mod app_launch;
mod config;
mod git_scan;
mod glass;
mod install;
mod pull;
mod svn_scan;
mod tray;

use install::{
    autostart_disable, autostart_enable, autostart_is_enabled, cleanup_stale_debug_autostart,
    ensure_installed_release, migrate_legacy_autostart,
};

use config::{load_config, save_config, OpenTarget, RepoConfig, RepoEntry};
use git_scan::{scan_one, scan_repos, validate_repo_input, RepoStatus, ScanResult, ValidateResult};
use pull::{PullFailure, PullOutcome};
use std::sync::Mutex;
use tauri::{Emitter, Manager, WindowEvent};
use tauri_plugin_window_state::StateFlags;

const POLL_INTERVAL_MS: u64 = 300_000;
const SETTINGS_LABEL: &str = "settings";
const PULL_REPORT_LABEL: &str = "pull-report";

/// 빠른 풀 결과 팝업에 띄울 실패 목록. 팝업 창이 열릴 때 가져간다.
#[derive(Default)]
struct PullReport(Mutex<Vec<PullFailure>>);

#[tauri::command]
fn get_config() -> RepoConfig {
    load_config()
}

#[tauri::command]
fn set_config(config: RepoConfig) -> Result<(), String> {
    // The split belongs to the widget's handle, not the settings form: keep the
    // saved one so a settings window opened before a drag cannot roll it back.
    let config = RepoConfig {
        section_split: load_config().section_split,
        ..config
    };
    save_config(&config)
}

/// Saves the Git/SVN split from the widget's handle. No `config-saved` event:
/// nothing needs a rescan, and the widget already shows the new split.
#[tauri::command]
fn set_section_split(split: Option<f64>) -> Result<(), String> {
    let mut config = load_config();
    config.section_split = split.filter(|s| s.is_finite()).map(|s| s.clamp(0.0, 1.0));
    save_config(&config)
}

#[tauri::command]
fn scan_all_repos() -> ScanResult {
    let config = load_config();
    scan_repos(&config.repos, true)
}

/// fetch가 몇 초씩 걸려도 창(위젯·팝업)이 멈추지 않게 메인 스레드가 아닌 스레드 풀에서 돈다.
#[tauri::command(async)]
fn scan_one_repo(name: String, path: String, do_fetch: bool) -> RepoStatus {
    let entry = RepoEntry {
        name,
        path,
        url: None,
    };
    scan_one(&entry, do_fetch)
}

#[tauri::command]
fn validate_repo(input: String) -> ValidateResult {
    validate_repo_input(&input)
}

/// `svn status -u`는 서버를 거쳐 수 초 걸리므로 스캔도 스레드 풀에서 돈다.
#[tauri::command(async)]
fn scan_one_svn_repo(name: String, path: String, do_fetch: bool) -> RepoStatus {
    let entry = RepoEntry {
        name,
        path,
        url: None,
    };
    svn_scan::scan_one(&entry, do_fetch)
}

#[tauri::command]
fn validate_svn_repo(input: String) -> ValidateResult {
    svn_scan::validate_input(&input)
}

/// fetch·merge는 몇 초씩 걸리므로 메인 스레드가 아닌 스레드 풀에서 돈다.
#[tauri::command(async)]
fn pull_git_repo(path: String) -> PullOutcome {
    pull::pull_git(&path)
}

/// 대형 작업본 업데이트는 몇 분도 걸린다. 메인 스레드를 막지 않게 스레드 풀에서 돈다.
#[tauri::command(async)]
fn update_svn_repo(path: String) -> PullOutcome {
    pull::update_svn(&path)
}

/// 풀 한 번이 끝날 때마다 불린다. Git·SVN 풀이 따로 끝나도 한 팝업에 모이도록,
/// 열려 있는 동안 온 결과는 이어 붙인다. 이번에 시도한 레포의 예전 결과는 새 결과로
/// 바꾸므로, 이번에 성공한 레포는 열린 팝업에서도 빠진다. 팝업은 실패가 있을 때만 연다.
#[tauri::command]
fn report_pull_results(
    app: tauri::AppHandle,
    report: tauri::State<PullReport>,
    vcs: config::Vcs,
    attempted: Vec<String>,
    failures: Vec<PullFailure>,
) -> Result<(), String> {
    let window = app
        .get_webview_window(PULL_REPORT_LABEL)
        .ok_or_else(|| "pull report window not found".to_string())?;
    let already_open = window.is_visible().unwrap_or(false);
    let has_new_failures = !failures.is_empty();
    let list = {
        let mut list = report.0.lock().map_err(|e| e.to_string())?;
        if !already_open {
            list.clear();
        }
        list.retain(|old| !(old.vcs == vcs && attempted.contains(&old.path)));
        list.extend(failures);
        list.clone()
    };

    if !has_new_failures && !already_open {
        return Ok(());
    }
    if list.is_empty() {
        // 남은 실패가 없으면 열어 둔 팝업도 닫는다.
        window.hide().map_err(|e| e.to_string())?;
        return Ok(());
    }
    // 목록을 이벤트에 실어 보낸다. 팝업이 다시 물어보면 그 요청이 스캔 뒤에 줄을 서
    // 지난 내용을 띄운 채 멈춰 있을 수 있다. 보이기 전에 보내 새 내용으로 뜨게 한다.
    window
        .emit("pull-report-open", list)
        .map_err(|e| e.to_string())?;
    if has_new_failures {
        window.show().map_err(|e| e.to_string())?;
        window.unminimize().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_pull_report(report: tauri::State<PullReport>) -> Vec<PullFailure> {
    report.0.lock().map(|list| list.clone()).unwrap_or_default()
}

#[tauri::command]
fn close_pull_report(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(PULL_REPORT_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_poll_interval_ms() -> u64 {
    POLL_INTERVAL_MS
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn open_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window(SETTINGS_LABEL)
        .ok_or_else(|| "settings window not found".to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.unminimize().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    window
        .emit("settings-open", ())
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_settings_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(SETTINGS_LABEL) {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_repo(path: String, open_target: OpenTarget) -> Result<(), String> {
    app_launch::open_repo(&path, open_target)
}

#[tauri::command]
fn is_dev_build() -> bool {
    cfg!(debug_assertions)
}

#[tauri::command]
fn enable_autostart() -> Result<(), String> {
    autostart_enable()
}

#[tauri::command]
fn disable_autostart() -> Result<(), String> {
    autostart_disable()
}

#[tauri::command]
fn is_autostart_enabled() -> Result<bool, String> {
    autostart_is_enabled()
}

#[tauri::command]
fn resize_main_window(app: tauri::AppHandle, height: f64) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    window
        .set_size(tauri::Size::Physical(tauri::PhysicalSize {
            width: size.width,
            height: height.max(160.0) as u32,
        }))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The setting lives in the config, but the OS flag has to be pushed onto the
/// live window, so settings applies it right after saving and startup replays it.
#[tauri::command]
fn set_always_on_top(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    window.set_always_on_top(enabled).map_err(|e| e.to_string())
}

/// 설정은 config에 있지만 캡처는 살아 있는 창에 걸어야 해서, 위젯 부팅과 설정 창이
/// 이걸로 반영한다. 실제로 켜졌는지 돌려주고 위젯 창에도 알려 카드 투명도를 맞춘다.
#[tauri::command]
fn set_glass(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let applied = glass::apply(&window, enabled);
    window
        .emit("glass-applied", applied)
        .map_err(|e| e.to_string())?;
    Ok(applied)
}

/// 흐림 반경(CSS px). 캡처 여백을 맞추고, 위젯 창이 CSS blur 반경을 바꾸도록 알린다.
#[tauri::command]
fn set_glass_blur(app: tauri::AppHandle, px: f64) -> Result<(), String> {
    glass::set_blur(px);
    app.emit_to("main", "glass-blur", px.clamp(0.0, glass::MAX_BLUR_PX))
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn glass_supported() -> bool {
    glass::supported()
}

/// The window-state plugin keeps the widget position under the app identifier,
/// which changed with the rename. Carry the old file over before the plugin
/// reads it, so the widget reopens where the user left it.
fn migrate_legacy_window_state() {
    const STATE_FILE: &str = ".window-state.json";
    let Some(roaming) = std::env::var_os("APPDATA").map(std::path::PathBuf::from) else {
        return;
    };
    let new_path = roaming.join("com.cykim.repo-multi-check-widget").join(STATE_FILE);
    let old_path = roaming.join("com.cykim.git-multi-check-widget").join(STATE_FILE);
    if new_path.is_file() || !old_path.is_file() {
        return;
    }
    if let Some(parent) = new_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::copy(&old_path, &new_path);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    migrate_legacy_window_state();
    tauri::Builder::default()
        // 위젯 위치만 복원한다. 창 높이는 레포 개수에 따라 프런트가 매번 다시 계산하므로
        // (main.ts의 maybeAutoResizeWindow), 크기까지 저장하면 지난 실행의 레포 개수가
        // 이번 실행을 덮어써 잘못된 높이로 떴다가 줄어드는 깜빡임이 생긴다.
        // 설정 창·풀 결과 팝업은 tauri.conf.json의 center 동작을 유지한다.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::POSITION)
                .with_denylist(&[SETTINGS_LABEL, PULL_REPORT_LABEL])
                .build(),
        )
        .manage(PullReport::default())
        // 배경 흐림 캡처 프레임. 위젯 페이지가 http://glassbg.localhost/frame 으로 받아 간다.
        .register_uri_scheme_protocol("glassbg", |ctx, request| {
            glass::frame_response(ctx.webview_label(), request)
        })
        .invoke_handler(tauri::generate_handler![
            get_config,
            set_config,
            set_section_split,
            scan_all_repos,
            scan_one_repo,
            validate_repo,
            scan_one_svn_repo,
            validate_svn_repo,
            pull_git_repo,
            update_svn_repo,
            report_pull_results,
            get_pull_report,
            close_pull_report,
            get_poll_interval_ms,
            quit_app,
            open_settings_window,
            close_settings_window,
            open_repo,
            resize_main_window,
            is_dev_build,
            enable_autostart,
            disable_autostart,
            is_autostart_enabled,
            set_always_on_top,
            set_glass,
            set_glass_blur,
            glass_supported
        ])
        .setup(|app| {
            tray::install(app)?;
            cleanup_stale_debug_autostart();
            let _ = ensure_installed_release();
            migrate_legacy_autostart();
            // tauri.conf.json pins the window to always-on-top, so a user who
            // turned it off is restored here before the webview paints.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(load_config().always_on_top);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                // 배경 흐림은 창 뒤를 캡처하므로, 옮기거나 크기가 바뀌면 바로 다시 찍는다.
                if matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                    glass::wake();
                }
                return;
            }
            let WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            match window.label() {
                SETTINGS_LABEL => {
                    api.prevent_close();
                    // 창 X는 취소와 같다. 설정이 즉시 반영해 둔 창 플래그를 되돌릴 기회를 준다.
                    let _ = window.emit("settings-cancelled", ());
                    let _ = window.hide();
                }
                // 팝업 창은 시작 때 한 번 만들어 두고 계속 다시 쓰므로 닫지 않고 숨긴다.
                PULL_REPORT_LABEL => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
