export type SyncState =
  | "synced"
  | "ahead"
  | "behind"
  | "diverged"
  | "no_upstream"
  | "no_remote"
  | "error";

import type { OpenTarget } from "./open-targets";

export type Vcs = "git" | "svn";

export type RepoEntry = {
  name: string;
  path: string;
  url?: string | null;
};

export type RepoConfig = {
  repos: RepoEntry[];
  open_target?: OpenTarget;
  /** Off hides the Git section; the registered list is kept. Missing means on. */
  git_enabled?: boolean;
  /** SVN section stays hidden until switched on in settings. */
  svn_enabled?: boolean;
  svn_repos?: RepoEntry[];
  /** Off means the widget behaves like a normal window and can go behind others. */
  always_on_top?: boolean;
  /** Git's share of the list space when both sections show; missing splits by repo count. */
  section_split?: number | null;
};

export type RepoStatus = {
  vcs: Vcs;
  name: string;
  path: string;
  branch: string | null;
  dirty: boolean;
  changed_count: number;
  ahead: number;
  behind: number;
  sync_state: SyncState;
  badge: string;
  error: string | null;
  /** UI placeholder while git scan is pending (no prior data) */
  loading?: boolean;
  /** Re-scan in progress; stale data may still be shown */
  refreshing?: boolean;
};

export type ScanResult = {
  repos: RepoStatus[];
  scanned_at: string;
  summary: string;
};

export type ValidateResult = {
  ok: boolean;
  message: string;
  resolved_path: string | null;
  suggested_name: string | null;
  remote_url: string | null;
};

/** One repo's quick-pull result. Only `ok: false` rows reach the report popup. */
export type PullOutcome = {
  ok: boolean;
  message: string;
};

export type PullFailure = {
  vcs: Vcs;
  name: string;
  path: string;
  message: string;
};
