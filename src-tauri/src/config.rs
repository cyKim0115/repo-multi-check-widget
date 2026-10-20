use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum OpenTarget {
    #[default]
    Fork,
    Cmd,
    GitBash,
    Cursor,
    VsCode,
    Explorer,
}

/// Which version control system a repository row is backed by.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Vcs {
    #[default]
    Git,
    Svn,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoEntry {
    pub name: String,
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

/// Widgets shipped as always-on-top, so a config written before the setting
/// existed must keep that behaviour instead of falling back to `false`.
fn default_always_on_top() -> bool {
    true
}

/// The Git section predates its toggle, so a config without the key keeps it on.
fn default_git_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoConfig {
    pub repos: Vec<RepoEntry>,
    #[serde(default)]
    pub open_target: OpenTarget,
    /// Off hides the Git section; the registered list is kept for when it comes back.
    #[serde(default = "default_git_enabled")]
    pub git_enabled: bool,
    /// SVN section stays hidden until the user turns it on in settings.
    #[serde(default)]
    pub svn_enabled: bool,
    #[serde(default)]
    pub svn_repos: Vec<RepoEntry>,
    /// Off means the widget behaves like a normal window and can go behind others.
    #[serde(default = "default_always_on_top")]
    pub always_on_top: bool,
    /// Git's share of the list space when both sections show, set by dragging
    /// the handle between them. `None` splits by repo count.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub section_split: Option<f64>,
}

impl Default for RepoConfig {
    fn default() -> Self {
        Self {
            repos: Vec::new(),
            open_target: OpenTarget::default(),
            git_enabled: default_git_enabled(),
            svn_enabled: false,
            svn_repos: Vec::new(),
            always_on_top: default_always_on_top(),
            section_split: None,
        }
    }
}

/// Per-user data folder under %LOCALAPPDATA%.
pub const APP_DIR: &str = "RepoMultiCheckWidget";
/// Folder name before the project was renamed from git-multi-check-widget.
pub const LEGACY_APP_DIR: &str = "GitMultiCheckWidget";

fn local_app_data() -> PathBuf {
    std::env::var("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
}

pub fn user_config_path() -> PathBuf {
    local_app_data().join(APP_DIR).join("repos.json")
}

/// The widget used to keep its repo list under the old folder name. Copy it
/// over once so the rename does not lose the user's repos (the old file stays).
fn migrate_legacy_config() {
    let new_path = user_config_path();
    let old_path = local_app_data().join(LEGACY_APP_DIR).join("repos.json");
    if new_path.is_file() || !old_path.is_file() {
        return;
    }
    if let Some(parent) = new_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::copy(&old_path, &new_path);
}

fn default_config_candidates() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        paths.push(cwd.join("config").join("repos.default.json"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            paths.push(parent.join("config").join("repos.default.json"));
            paths.push(parent.join("..").join("config").join("repos.default.json"));
        }
    }
    paths
}

fn seed_config() -> RepoConfig {
    RepoConfig {
        repos: vec![
            RepoEntry {
                name: "rag".into(),
                path: "C:\\Users\\cykim\\repo\\rag".into(),
                url: Some("https://github.com/cyKim0115/rag".into()),
            },
            RepoEntry {
                name: "TeenipingTycoon".into(),
                path: "C:\\Users\\cykim\\repo\\TeenipingTycoon".into(),
                url: None,
            },
        ],
        open_target: OpenTarget::default(),
        git_enabled: default_git_enabled(),
        svn_enabled: false,
        svn_repos: Vec::new(),
        always_on_top: default_always_on_top(),
        section_split: None,
    }
}

pub fn load_config() -> RepoConfig {
    migrate_legacy_config();
    let user_path = user_config_path();
    if user_path.is_file() {
        if let Ok(text) = fs::read_to_string(&user_path) {
            if let Ok(cfg) = serde_json::from_str::<RepoConfig>(&text) {
                return cfg;
            }
        }
    }

    for path in default_config_candidates() {
        if path.is_file() {
            if let Ok(text) = fs::read_to_string(&path) {
                if let Ok(cfg) = serde_json::from_str::<RepoConfig>(&text) {
                    return cfg;
                }
            }
        }
    }

    seed_config()
}

pub fn save_config(config: &RepoConfig) -> Result<(), String> {
    let path = user_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("config dir: {e}"))?;
    }
    let text = serde_json::to_string_pretty(config).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, text).map_err(|e| format!("write config: {e}"))?;
    Ok(())
}

pub fn repo_name_from_path(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("repo")
        .to_string()
}

pub fn extract_repo_name_from_url(url: &str) -> Option<String> {
    let trimmed = url.trim().trim_end_matches('/');
    let last = trimmed.rsplit(['/', ':']).next()?;
    let name = last.trim_end_matches(".git");
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

pub fn is_git_remote_url(input: &str) -> bool {
    let s = input.trim();
    s.starts_with("https://")
        || s.starts_with("http://")
        || s.starts_with("git@")
        || s.starts_with("ssh://")
}

pub fn resolve_local_clone_path(repo_name: &str) -> Option<PathBuf> {
    let roots = [
        std::env::var("USERPROFILE")
            .ok()
            .map(|h| PathBuf::from(h).join("repo")),
        Some(PathBuf::from("C:\\Users\\cykim\\repo")),
    ];
    for root in roots.into_iter().flatten() {
        let candidate = root.join(repo_name);
        if candidate.join(".git").exists() {
            return Some(candidate);
        }
    }
    None
}
