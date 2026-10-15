import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatSummaryIcons, renderStatusIcons, rowClass } from "./status-icons";
import { DEFAULT_OPEN_TARGET } from "./open-targets";
import type { OpenTarget } from "./open-targets";
import type { PullFailure, PullOutcome, RepoConfig, RepoEntry, RepoStatus, Vcs } from "./types";

const PREVIEW = new URLSearchParams(window.location.search).has("preview");

let openTarget: OpenTarget = DEFAULT_OPEN_TARGET;

const PREVIEW_SCAN: RepoStatus[] = [
  {
    vcs: "git",
    name: "rag",
    path: "C:\\Users\\cykim\\repo\\rag",
    branch: "main",
    dirty: true,
    changed_count: 3,
    ahead: 0,
    behind: 0,
    sync_state: "synced",
    badge: "dirty ·3",
    error: null,
  },
  {
    vcs: "git",
    name: "TeenipingTycoon",
    path: "C:\\Users\\cykim\\repo\\TeenipingTycoon",
    branch: "develop",
    dirty: false,
    changed_count: 0,
    ahead: 0,
    behind: 2,
    sync_state: "behind",
    badge: "pull ·2",
    error: null,
  },
  {
    vcs: "git",
    name: "system-crew",
    path: "C:\\Users\\cykim\\repo\\system-crew",
    branch: "main",
    dirty: false,
    changed_count: 0,
    ahead: 1,
    behind: 0,
    sync_state: "ahead",
    badge: "push ·1",
    error: null,
  },
];

const PREVIEW_SVN_SCAN: RepoStatus[] = [
  {
    vcs: "svn",
    name: "ArtSource",
    path: "D:\\svn\\ArtSource",
    branch: "^/trunk/ArtSource",
    dirty: true,
    changed_count: 12,
    ahead: 0,
    behind: 4,
    sync_state: "behind",
    badge: "dirty ·12 · pull ·4",
    error: null,
  },
];

/** Fallbacks only — the real geometry is measured from the rendered DOM. */
const BASE_HEIGHT = 72;
const ROW_HEIGHT = 36;
const LABEL_HEIGHT = 24;
/** Row budget for a single visible section vs. two stacked ones. */
const MAX_VISIBLE_ROWS = 5;
const MAX_VISIBLE_ROWS_SPLIT = 4;
const SCROLL_ACCEL_BASE = 0.07;
const SCROLL_ACCEL_STEP = 0.035;
const SCROLL_ACCEL_BURST_MAX = 7;
const WHEEL_BURST_MS = 140;
const SCROLL_FRICTION = 0.92;
const SCROLL_MIN_VELOCITY = 0.18;
const SCROLL_MAX_VELOCITY = 28;
/**
 * The window's resize event can arrive after the resize invoke has already
 * returned, so a flag cleared on return misreads our own auto-fit as the user
 * dragging the edge — and auto-fit would then stop for good.
 */
const RESIZE_ECHO_MS = 500;

const SECTIONS: readonly Vcs[] = ["git", "svn"];

/** Per section, so a pull stops only its own section's scan and the other keeps refreshing. */
const scanGeneration: Record<Vcs, number> = { git: 0, svn: 0 };
let scrollBound = false;
let lastGitRepos: RepoStatus[] = [];
let lastSvnRepos: RepoStatus[] = [];
let gitEnabled = true;
let svnEnabled = false;
let windowAutoSized = false;
let userResizedWindow = false;
/** Resize events before this time are echoes of our own auto-fit. */
let programmaticResizeUntil = 0;
let lastAutoSizedSignature = "";
let contextRepoTarget: RepoStatus | null = null;

/**
 * Every scan invoke still talking to the backend, per section and repo path —
 * a superseded refresh keeps running until its current invoke returns. A pull
 * waits out the scans of its own repos so no `git fetch` races its merge, but
 * not a fetch stuck on some other repo (a sign-in prompt nobody answers).
 */
const scansInFlight: Record<Vcs, Map<string, Set<Promise<unknown>>>> = {
  git: new Map(),
  svn: new Map(),
};
/** The refresh that owns each section's pending scan; a pull that stops it re-runs it afterwards. */
const runningScan: Record<Vcs, { doFetch: boolean } | null> = { git: null, svn: null };
/** A section scan asked for while that section was pulling; it runs when the pull ends. */
const deferredScan: Record<Vcs, { doFetch: boolean } | null> = { git: null, svn: null };

/**
 * SVN keeps no local copy of the server state (git has its remote-tracking
 * refs), so a scan without the server round trip always says "behind 0". Each
 * working copy is asked once — the first time it is scanned — and later local
 * scans carry that answer forward until the next fetch poll.
 */
const svnRemoteKnown = new Set<string>();

type PullRun = { done: number; total: number; paths: Set<string> };
const pullRuns: Record<Vcs, PullRun | null> = { git: null, svn: null };

/** Git pulls and SVN updates share one flow; only the wording and command differ. */
const PULL_UI: Record<Vcs, { buttonId: string; command: string; verb: string; hint: string }> = {
  git: {
    buttonId: "git-pull-btn",
    command: "pull_git_repo",
    verb: "풀",
    hint: "fast-forward 우선, 안 되면 merge · 충돌 나면 취소하고 다음 저장소로",
  },
  svn: {
    buttonId: "svn-pull-btn",
    command: "update_svn_repo",
    verb: "업데이트",
    hint: "svn update · 실패하면 건너뛰고 다음 작업본으로",
  },
};

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

/**
 * Git and SVN each own a scroll viewport, so the inertia state that used to be
 * module-level is now per-area — otherwise one wheel gesture would drag both.
 */
type ScrollArea = {
  scroll: HTMLElement;
  wrap: HTMLElement;
  fadeTop: HTMLElement;
  fadeBottom: HTMLElement;
  velocity: number;
  burst: number;
  lastWheelAt: number;
  animId: number | null;
};

const scrollAreas: ScrollArea[] = [];

function createScrollArea(prefix: string): ScrollArea {
  return {
    scroll: $(`${prefix}-scroll`),
    wrap: $(`${prefix}-scroll-wrap`),
    fadeTop: $(`${prefix}-fade-top`),
    fadeBottom: $(`${prefix}-fade-bottom`),
    velocity: 0,
    burst: 0,
    lastWheelAt: 0,
    animId: null,
  };
}

function formatTime(unixSeconds: number): string {
  const date = new Date(unixSeconds * 1000);
  return date.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function placeholderStatus(entry: RepoEntry, vcs: Vcs): RepoStatus {
  return {
    vcs,
    name: entry.name,
    path: entry.path,
    branch: null,
    dirty: false,
    changed_count: 0,
    ahead: 0,
    behind: 0,
    sync_state: "synced",
    badge: "…",
    error: null,
    loading: true,
  };
}

function sectionRows(vcs: Vcs): RepoStatus[] {
  return vcs === "svn" ? lastSvnRepos : lastGitRepos;
}

function setSectionRows(vcs: Vcs, rows: RepoStatus[]) {
  if (vcs === "svn") lastSvnRepos = rows;
  else lastGitRepos = rows;
}

/**
 * Scans and pulls finish at different times, so each one patches its own row
 * in the live list — writing back a copy taken before an await would undo
 * whatever another flow changed meanwhile.
 */
function updateRow(vcs: Vcs, path: string, patch: (row: RepoStatus) => RepoStatus): boolean {
  const rows = sectionRows(vcs);
  const idx = rows.findIndex((r) => r.path === path);
  if (idx === -1) return false;
  const next = [...rows];
  next[idx] = patch(rows[idx]);
  setSectionRows(vcs, next);
  return true;
}

function freshRow(updated: RepoStatus): RepoStatus {
  return { ...updated, refreshing: false, loading: false };
}

/** A local-only SVN scan reports behind 0; keep the last server answer instead. */
function withKnownSvnRemote(prev: RepoStatus, updated: RepoStatus): RepoStatus {
  if (updated.error || prev.error || prev.loading || prev.behind === 0) return freshRow(updated);
  return { ...freshRow(updated), behind: prev.behind, sync_state: "behind" };
}

/** Whether this scan of the row must include the server round trip. */
function scanFetches(vcs: Vcs, path: string, doFetch: boolean): boolean {
  return doFetch || (vcs === "svn" && !svnRemoteKnown.has(path));
}

/** Applies one scan result to its row, minding the SVN server state rule above. */
function applyScan(vcs: Vcs, path: string, updated: RepoStatus, fetched: boolean) {
  if (vcs === "svn" && fetched) svnRemoteKnown.add(path);
  // The name comes from the live row: the entry may have been renamed while this scan ran.
  updateRow(vcs, path, (prev) => ({
    ...(vcs === "svn" && !fetched ? withKnownSvnRemote(prev, updated) : freshRow(updated)),
    name: prev.name,
  }));
}

function errorRow(row: RepoStatus, e: unknown): RepoStatus {
  return {
    ...row,
    loading: false,
    refreshing: false,
    error: String(e),
    badge: "ERR",
    sync_state: "error",
  };
}

function renderRepoList(listId: string, repos: RepoStatus[]) {
  const list = $(listId);
  list.replaceChildren();
  for (const repo of repos) {
    const li = document.createElement("li");
    li.className = `repo-item ${rowClass(repo)}`;

    const nameWrap = document.createElement("span");
    nameWrap.className = "repo-name-wrap";

    const name = document.createElement("span");
    name.className = "repo-name";
    name.textContent = repo.name;
    nameWrap.append(name);

    if (repo.refreshing) {
      const indicator = document.createElement("span");
      indicator.className = "repo-refresh-indicator";
      indicator.setAttribute("role", "status");
      indicator.setAttribute("aria-label", "최신화 중");
      nameWrap.append(indicator);
    }

    const branch = document.createElement("span");
    branch.className = "repo-branch";
    branch.textContent = repo.loading
      ? "…"
      : (repo.error ?? repo.branch ?? "—");

    li.append(nameWrap, branch, renderStatusIcons(repo));

    if (!repo.loading && !repo.error) {
      li.classList.add("repo-item--openable");
      li.title = "우클릭하여 메뉴";
      li.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        contextRepoTarget = repo;
        showRepoContextMenu(e.clientX, e.clientY);
      });
    }

    list.append(li);
  }
}

function updateScrollFade() {
  requestAnimationFrame(() => {
    for (const area of scrollAreas) {
      const canScroll = area.scroll.scrollHeight > area.scroll.clientHeight + 1;
      const atTop = area.scroll.scrollTop <= 1;
      const atBottom =
        area.scroll.scrollTop + area.scroll.clientHeight >= area.scroll.scrollHeight - 1;

      area.fadeTop.classList.toggle("visible", canScroll && !atTop);
      area.fadeBottom.classList.toggle("visible", canScroll && !atBottom);
    }
  });
}

function isProgrammaticResize(): boolean {
  return performance.now() < programmaticResizeUntil;
}

function maxScrollTop(scroll: HTMLElement): number {
  return Math.max(0, scroll.scrollHeight - scroll.clientHeight);
}

function clampScrollVelocity(velocity: number): number {
  return Math.max(-SCROLL_MAX_VELOCITY, Math.min(SCROLL_MAX_VELOCITY, velocity));
}

function ensureScrollAnimation(area: ScrollArea) {
  if (area.animId !== null) return;

  const tick = () => {
    if (Math.abs(area.velocity) < SCROLL_MIN_VELOCITY) {
      area.animId = null;
      area.velocity = 0;
      updateScrollFade();
      return;
    }

    const max = maxScrollTop(area.scroll);
    const prev = area.scroll.scrollTop;
    const next = Math.max(0, Math.min(max, prev + area.velocity));
    area.scroll.scrollTop = next;

    if (next !== prev) {
      area.velocity *= SCROLL_FRICTION;
    } else {
      area.velocity *= 0.4;
    }

    if (area.scroll.scrollTop <= 0 || area.scroll.scrollTop >= max) {
      area.velocity *= 0.55;
    }

    updateScrollFade();
    area.animId = requestAnimationFrame(tick);
  };

  area.animId = requestAnimationFrame(tick);
}

function applyWheelScroll(area: ScrollArea, deltaY: number) {
  const now = performance.now();
  if (now - area.lastWheelAt < WHEEL_BURST_MS) {
    area.burst = Math.min(SCROLL_ACCEL_BURST_MAX, area.burst + 1);
  } else {
    area.burst = 0;
  }
  area.lastWheelAt = now;

  const accel = SCROLL_ACCEL_BASE + area.burst * SCROLL_ACCEL_STEP;
  area.velocity = clampScrollVelocity(area.velocity + deltaY * accel);
  ensureScrollAnimation(area);
}

function setupRepoScroll() {
  if (scrollBound) return;
  scrollBound = true;

  scrollAreas.push(createScrollArea("repo"), createScrollArea("svn"));

  window.addEventListener("resize", () => {
    if (!isProgrammaticResize() && windowAutoSized) {
      userResizedWindow = true;
    }
    updateScrollFade();
  });

  for (const area of scrollAreas) {
    area.scroll.addEventListener("scroll", updateScrollFade, { passive: true });
    area.wrap.addEventListener(
      "wheel",
      (e) => {
        if (area.scroll.scrollHeight <= area.scroll.clientHeight + 1) return;
        e.preventDefault();
        applyWheelScroll(area, e.deltaY);
      },
      { passive: false },
    );
  }
}

function renderSummary() {
  const summaryEl = $("summary");
  const rows = [...lastGitRepos, ...lastSvnRepos];
  // With no rows at all (sections off, nothing registered) the pending icon would
  // claim a check is still running, so the summary stays empty instead.
  summaryEl.replaceChildren(rows.length > 0 ? formatSummaryIcons(rows) : "");
}

function visibleRowBudget(): number {
  return gitEnabled && svnEnabled ? MAX_VISIBLE_ROWS_SPLIT : MAX_VISIBLE_ROWS;
}

function visibleRows(count: number): number {
  return Math.min(Math.max(1, count), visibleRowBudget());
}

function cssPx(value: string): number {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Row height used to be a constant that undershot the real row, so the window
 * was always a little too short and rows got clipped. Measuring the rendered
 * DOM keeps the window height and the CSS layout agreeing on one set of numbers.
 */
function measureLayout(): {
  chrome: number;
  row: number;
  label: number;
  gap: number;
  empty: number;
} {
  const widget = document.querySelector<HTMLElement>(".widget");
  const sections = $("sections");

  const measuredChrome = widget ? widget.offsetHeight - sections.offsetHeight : 0;
  const chrome = measuredChrome > 0 ? measuredChrome : BASE_HEIGHT;

  // A switched-off section keeps its old rows in the DOM, so only visible ones count.
  const item = document.querySelector<HTMLElement>(".repo-section:not(.hidden) .repo-item");
  const row =
    item && item.parentElement && item.offsetHeight > 0
      ? item.offsetHeight + cssPx(getComputedStyle(item.parentElement).rowGap)
      : ROW_HEIGHT;

  const labelEl = document.querySelector<HTMLElement>(".repo-section:not(.hidden) .section-label");
  const label =
    labelEl && labelEl.offsetHeight > 0
      ? labelEl.offsetHeight + cssPx(getComputedStyle(labelEl).marginBottom)
      : LABEL_HEIGHT;

  const emptyEl = $("sections-empty");
  const empty = emptyEl.offsetHeight > 0 ? emptyEl.offsetHeight : ROW_HEIGHT;

  return { chrome, row, label, gap: cssPx(getComputedStyle(sections).rowGap), empty };
}

async function maybeAutoResizeWindow() {
  if (userResizedWindow) return;

  const counts: number[] = [];
  if (gitEnabled) counts.push(Math.max(1, lastGitRepos.length));
  if (svnEnabled) counts.push(Math.max(1, lastSvnRepos.length));
  const layout = measureLayout();
  const signature = `${gitEnabled}:${svnEnabled}:${counts.join(",")}:${Math.round(layout.row)}`;
  if (windowAutoSized && signature === lastAutoSizedSignature) return;

  // Each visible section is its label plus its row budget; sections are spaced by the gap.
  let height = layout.chrome;
  if (counts.length === 0) {
    height += layout.empty;
  } else {
    for (const count of counts) {
      height += layout.label + visibleRows(count) * layout.row;
    }
    height += layout.gap * (counts.length - 1);
  }

  try {
    programmaticResizeUntil = performance.now() + RESIZE_ECHO_MS;
    await invoke("resize_main_window", { height });
    windowAutoSized = true;
    lastAutoSizedSignature = signature;
  } catch {
    /* dev without tauri */
  } finally {
    programmaticResizeUntil = performance.now() + RESIZE_ECHO_MS;
  }
}

function needsPull(repo: RepoStatus): boolean {
  // Git counts a diverged repo as behind too, so `behind` alone covers both.
  return !repo.loading && !repo.error && repo.behind > 0;
}

function isPulling(): boolean {
  return pullRuns.git !== null || pullRuns.svn !== null;
}

/** Shown while the section has something to pull, or while its pull is running. */
function renderQuickPull(vcs: Vcs) {
  const ui = PULL_UI[vcs];
  const btn = $(ui.buttonId) as HTMLButtonElement;
  const run = pullRuns[vcs];
  const pending = sectionRows(vcs).filter(needsPull).length;

  btn.classList.toggle("hidden", run === null && pending === 0);
  btn.disabled = run !== null;

  // Rebuilding on every render would restart the spinner animation each time.
  const state = run ? `run:${run.done}/${run.total}` : `idle:${pending}`;
  if (btn.dataset.state === state) return;
  btn.dataset.state = state;

  if (run) {
    const spinner = document.createElement("span");
    spinner.className = "quick-pull-spinner";
    btn.replaceChildren(spinner, `${run.done}/${run.total}`);
    btn.title = `${ui.verb} 중… ${run.done}/${run.total}`;
    btn.setAttribute("aria-label", `${ui.verb} 진행 중 ${run.done}/${run.total}`);
  } else {
    btn.replaceChildren(pullIcon(), String(pending));
    btn.title = `${pending}개 저장소 한 번에 ${ui.verb}\n${ui.hint}`;
    btn.setAttribute("aria-label", `${pending}개 저장소 한 번에 ${ui.verb}`);
  }
}

/** Arrow down into a tray — the button's label; the verb lives in the tooltip. */
function pullIcon(): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("class", "quick-pull-icon");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M8 2v8M4.5 6.5 8 10l3.5-3.5M3 13.5h10");
  svg.append(path);
  return svg;
}

function renderAll() {
  $("git-section").classList.toggle("hidden", !gitEnabled);
  $("svn-section").classList.toggle("hidden", !svnEnabled);
  $("sections-empty").classList.toggle("hidden", gitEnabled || svnEnabled);

  // The window height is budgeted per section, so the sections must grow in the
  // same proportion — a plain `flex: 1` would split the space evenly instead.
  $("git-section").style.flexGrow = String(visibleRows(lastGitRepos.length));
  $("svn-section").style.flexGrow = String(visibleRows(lastSvnRepos.length));

  renderSummary();
  if (gitEnabled) {
    renderRepoList("repo-list", lastGitRepos);
    renderQuickPull("git");
  }
  if (svnEnabled) {
    renderRepoList("svn-list", lastSvnRepos);
    renderQuickPull("svn");
  }

  void maybeAutoResizeWindow();
  updateScrollFade();
}

function findPrevious(previous: RepoStatus[], entry: RepoEntry): RepoStatus | undefined {
  return previous.find((r) => r.name === entry.name && r.path === entry.path);
}

function rowsForRefresh(
  entries: RepoEntry[],
  previous: RepoStatus[],
  vcs: Vcs,
  markRefreshing = true,
): RepoStatus[] {
  return entries.map((entry) => {
    const prev = findPrevious(previous, entry);
    if (prev && !prev.loading) {
      return markRefreshing ? { ...prev, refreshing: true } : prev;
    }
    // A row that starts over (section switched back on, entry re-added) has no
    // server answer to carry, so its first scan asks again.
    if (vcs === "svn") svnRemoteKnown.delete(entry.path);
    return placeholderStatus(entry, vcs);
  });
}

/**
 * Takes the sections and repo lists from the config and returns what each
 * section should scan. Only sections about to be scanned get the spinner — a
 * section that is pulling keeps the rows its pull is updating.
 */
function applyConfig(config: RepoConfig, scanning: (vcs: Vcs) => boolean): Record<Vcs, RepoEntry[]> {
  gitEnabled = config.git_enabled ?? true;
  svnEnabled = config.svn_enabled ?? false;
  const entries: Record<Vcs, RepoEntry[]> = {
    git: gitEnabled ? config.repos : [],
    svn: svnEnabled ? (config.svn_repos ?? []) : [],
  };
  lastGitRepos = rowsForRefresh(entries.git, lastGitRepos, "git", scanning("git"));
  lastSvnRepos = rowsForRefresh(entries.svn, lastSvnRepos, "svn", scanning("svn"));
  return entries;
}

/** Fork and Git Bash are git-only; an SVN row falls back to the explorer. */
function effectiveOpenTarget(vcs: Vcs): OpenTarget {
  if (vcs === "svn" && (openTarget === "fork" || openTarget === "git_bash")) {
    return "explorer";
  }
  return openTarget;
}

async function openRepoAtPath(path: string, vcs: Vcs) {
  try {
    await invoke("open_repo", { path, openTarget: effectiveOpenTarget(vcs) });
    setStatus("opened");
  } catch (e) {
    setStatus(String(e));
  }
}

async function openRepoInExplorer(path: string) {
  try {
    await invoke("open_repo", { path, openTarget: "explorer" });
    setStatus("opened in explorer");
  } catch (e) {
    setStatus(String(e));
  }
}

function scanCommandFor(vcs: Vcs): string {
  return vcs === "svn" ? "scan_one_svn_repo" : "scan_one_repo";
}

/** Counts the promise as a running scan of that repo until it settles, so a pull can wait for it. */
function trackScan<T>(vcs: Vcs, path: string, promise: Promise<T>): Promise<T> {
  const byPath = scansInFlight[vcs];
  const inFlight = byPath.get(path) ?? new Set<Promise<unknown>>();
  byPath.set(path, inFlight);
  inFlight.add(promise);
  void promise
    .finally(() => {
      inFlight.delete(promise);
      if (inFlight.size === 0 && byPath.get(path) === inFlight) byPath.delete(path);
    })
    .catch(() => {
      /* the caller handles the rejection */
    });
  return promise;
}

/** Status text from anything but a pull; a running pull owns the status line until it ends. */
function setStatus(text: string) {
  if (!isPulling()) $("status").textContent = text;
}

/** Rescans one row in place. Returns the scan error, or null on success. */
async function rescanRow(
  vcs: Vcs,
  target: { name: string; path: string },
  doFetch: boolean,
): Promise<string | null> {
  const fetches = scanFetches(vcs, target.path, doFetch);
  try {
    const updated = (await invoke(scanCommandFor(vcs), {
      name: target.name,
      path: target.path,
      doFetch: fetches,
    })) as RepoStatus;
    applyScan(vcs, target.path, updated, fetches);
    return null;
  } catch (e) {
    updateRow(vcs, target.path, (row) => errorRow(row, e));
    return String(e);
  }
}

async function refreshOneRepo(target: RepoStatus) {
  const statusEl = $("status");
  // The pull rescans its own repos when it ends; a fetch now would race its merge.
  if (pullRuns[target.vcs]?.paths.has(target.path)) {
    statusEl.textContent = `${PULL_UI[target.vcs].verb} 진행 중…`;
    return;
  }
  if (!updateRow(target.vcs, target.path, (row) => ({ ...row, refreshing: true }))) return;
  renderAll();
  setStatus("refreshing…");

  const error = await trackScan(target.vcs, target.path, rescanRow(target.vcs, target, true));
  setStatus(error ?? `updated ${formatTime(nowSeconds())}`);
  renderAll();
}

async function loadOpenTarget() {
  try {
    const config = (await invoke("get_config")) as RepoConfig;
    openTarget = config.open_target ?? DEFAULT_OPEN_TARGET;
  } catch {
    /* dev without tauri */
  }
}

/** Scans one section row by row, re-rendering after each like the git flow always has. */
async function scanSection(
  entries: RepoEntry[],
  vcs: Vcs,
  doFetch: boolean,
  generation: number,
): Promise<boolean> {
  for (const entry of entries) {
    if (generation !== scanGeneration[vcs]) return false;

    const fetches = scanFetches(vcs, entry.path, doFetch);
    let apply: () => void;
    try {
      const updated = (await trackScan(
        vcs,
        entry.path,
        invoke(scanCommandFor(vcs), {
          name: entry.name,
          path: entry.path,
          doFetch: fetches,
        }),
      )) as RepoStatus;
      apply = () => applyScan(vcs, entry.path, updated, fetches);
    } catch (e) {
      apply = () => updateRow(vcs, entry.path, (row) => errorRow(row, e));
    }
    if (generation !== scanGeneration[vcs]) return false;
    apply();
    renderAll();
  }
  return true;
}

function deferScan(vcs: Vcs, doFetch: boolean) {
  deferredScan[vcs] = { doFetch: (deferredScan[vcs]?.doFetch ?? false) || doFetch };
}

/**
 * Re-reads the config and rescans the given sections. A section that is
 * pulling is not scanned now — its scan waits for the pull — but the config
 * (a section switched off, repos added or removed) still shows at once.
 */
async function runRefresh(doFetch: boolean, sections: readonly Vcs[] = SECTIONS) {
  const mine = { doFetch };
  const generation: Record<Vcs, number> = { ...scanGeneration };
  for (const vcs of sections) {
    if (pullRuns[vcs]) {
      deferScan(vcs, doFetch);
      continue;
    }
    // Claiming the section also stops an older refresh still scanning it.
    generation[vcs] = ++scanGeneration[vcs];
    runningScan[vcs] = mine;
  }
  // False once a newer refresh or a pull has taken the section over.
  const owns = (vcs: Vcs) =>
    sections.includes(vcs) && runningScan[vcs] === mine && generation[vcs] === scanGeneration[vcs];

  try {
    if (PREVIEW) {
      gitEnabled = true;
      svnEnabled = true;
      lastGitRepos = PREVIEW_SCAN;
      lastSvnRepos = PREVIEW_SVN_SCAN;
      renderAll();
      setStatus(`updated ${formatTime(nowSeconds())}`);
      return;
    }

    let config: RepoConfig;
    try {
      config = (await invoke("get_config")) as RepoConfig;
    } catch (e) {
      setStatus(`error: ${String(e)}`);
      return;
    }

    const entries = applyConfig(config, owns);
    renderAll();

    const rows = [...lastGitRepos, ...lastSvnRepos];
    if (rows.length === 0) {
      setStatus(gitEnabled || svnEnabled ? "no repos" : "all sections off");
      return;
    }
    if (!SECTIONS.some(owns)) return;
    setStatus(rows.some((r) => r.refreshing) ? "refreshing…" : "scanning…");

    let complete = true;
    for (const vcs of sections) {
      if (!owns(vcs)) {
        complete = false;
        continue;
      }
      const finished = await scanSection(entries[vcs], vcs, doFetch, generation[vcs]);
      if (runningScan[vcs] === mine) runningScan[vcs] = null;
      if (!finished) complete = false;
    }
    if (complete) setStatus(`updated ${formatTime(nowSeconds())}`);
  } finally {
    for (const vcs of sections) {
      if (runningScan[vcs] === mine) runningScan[vcs] = null;
    }
  }
}

/** Full rescan of every section (a pulling section catches up when its pull ends). */
function refresh(options?: { doFetch?: boolean }): Promise<void> {
  return runRefresh(options?.doFetch ?? false);
}

/**
 * Stops the section's scans before a pull touches its repos: the refresh that
 * owned the section is re-run after the pull, and any scan still running on
 * one of the pulled repos is waited out.
 */
async function stopScans(vcs: Vcs, paths: Set<string>) {
  const running = runningScan[vcs];
  if (running) {
    deferScan(vcs, running.doFetch);
    runningScan[vcs] = null;
  }
  scanGeneration[vcs]++;
  const busy = [...paths].flatMap((path) => [...(scansInFlight[vcs].get(path) ?? [])]);
  await Promise.allSettled(busy);
}

/**
 * Hands one finished run to the popup. Every attempted repo is sent so an open
 * popup also drops repos that now pulled fine; it only opens when something failed.
 */
async function reportPullResults(vcs: Vcs, attempted: string[], failures: PullFailure[]) {
  try {
    await invoke("report_pull_results", { vcs, attempted, failures });
  } catch {
    // No popup window (browser preview / broken install): still tell the user.
    if (failures.length > 0) {
      window.alert(failures.map((f) => `${f.name}\n${f.message}`).join("\n\n"));
    }
  }
}

/**
 * Pulls every repo in the section that is behind, one by one. A failure leaves
 * that repo as it was and moves on; failures are listed in one popup at the
 * end, then every attempted repo is rescanned. No popup when all succeeded.
 */
async function quickPull(vcs: Vcs) {
  if (PREVIEW || pullRuns[vcs]) return;
  if (!(vcs === "svn" ? svnEnabled : gitEnabled)) return;
  const targets = sectionRows(vcs)
    .filter(needsPull)
    .map(({ name, path }) => ({ name, path }));
  if (targets.length === 0) return;

  const statusEl = $("status");
  const ui = PULL_UI[vcs];
  const run: PullRun = {
    done: 0,
    total: targets.length,
    paths: new Set(targets.map((t) => t.path)),
  };
  pullRuns[vcs] = run;
  for (const target of targets) {
    updateRow(vcs, target.path, (row) => ({ ...row, refreshing: true }));
  }
  renderAll();
  statusEl.textContent = `${ui.verb} 중…`;

  // A scan still fetching one of these repos would race the merge.
  await stopScans(vcs, run.paths);
  // A single-row refresh that was still running has just written its result
  // (and its status text) over ours.
  for (const target of targets) {
    updateRow(vcs, target.path, (row) => ({ ...row, refreshing: true }));
  }
  renderAll();
  statusEl.textContent = `${ui.verb} 중…`;

  const failures: PullFailure[] = [];
  for (const target of targets) {
    try {
      const outcome = await invoke<PullOutcome>(ui.command, { path: target.path });
      if (!outcome.ok) failures.push({ vcs, ...target, message: outcome.message });
    } catch (e) {
      failures.push({ vcs, ...target, message: String(e) });
    }
    run.done += 1;
    renderAll();
  }

  void reportPullResults(
    vcs,
    targets.map((t) => t.path),
    failures,
  );

  // Git just fetched while pulling; SVN only learns what is still behind from the server.
  for (const target of targets) {
    await rescanRow(vcs, target, vcs === "svn");
    renderAll();
  }

  pullRuns[vcs] = null;
  renderAll();
  const succeeded = targets.length - failures.length;
  statusEl.textContent =
    failures.length > 0
      ? `${ui.verb} ${succeeded}/${targets.length} · 실패 ${failures.length}`
      : `${ui.verb} 완료 ${targets.length} · ${formatTime(nowSeconds())}`;

  const pending = deferredScan[vcs];
  if (pending) {
    deferredScan[vcs] = null;
    void runRefresh(pending.doFetch, [vcs]);
  }
}

function hideContextMenu() {
  $("context-menu").classList.add("hidden");
  $("repo-context-menu").classList.add("hidden");
  $("context-backdrop").classList.add("hidden");
  contextRepoTarget = null;
}

function positionContextMenu(menu: HTMLElement, x: number, y: number) {
  const rect = menu.getBoundingClientRect();
  const maxX = Math.max(8, window.innerWidth - rect.width - 8);
  const maxY = Math.max(8, window.innerHeight - rect.height - 8);
  menu.style.left = `${Math.min(x, maxX)}px`;
  menu.style.top = `${Math.min(y, maxY)}px`;
}

function showWidgetContextMenu(x: number, y: number) {
  const backdrop = $("context-backdrop");
  const menu = $("context-menu");
  $("repo-context-menu").classList.add("hidden");
  backdrop.classList.remove("hidden");
  menu.classList.remove("hidden");
  positionContextMenu(menu, x, y);
}

function showRepoContextMenu(x: number, y: number) {
  const backdrop = $("context-backdrop");
  const menu = $("repo-context-menu");
  $("context-menu").classList.add("hidden");
  backdrop.classList.remove("hidden");
  menu.classList.remove("hidden");
  positionContextMenu(menu, x, y);
}

async function openSettings() {
  hideContextMenu();
  try {
    await invoke("open_settings_window");
  } catch (e) {
    window.alert(String(e));
  }
}

async function boot() {
  setupRepoScroll();

  document.addEventListener("contextmenu", (e) => {
    if ((e.target as Element).closest(".repo-item")) return;
    e.preventDefault();
    contextRepoTarget = null;
    showWidgetContextMenu(e.clientX, e.clientY);
  });

  const backdrop = $("context-backdrop");
  // pointerdown rather than click: a press that lands on the backdrop dismisses
  // the menu even when the pointer drifts before release.
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) hideContextMenu();
  });

  // The menus sit inside the backdrop, so their own presses must not reach the
  // dismiss handler above.
  for (const menu of [$("context-menu"), $("repo-context-menu")]) {
    menu.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  $("menu-settings").addEventListener("click", () => void openSettings());
  $("menu-refresh").addEventListener("click", () => {
    hideContextMenu();
    void refresh({ doFetch: true });
  });
  $("menu-quit").addEventListener("click", async () => {
    hideContextMenu();
    await invoke("quit_app");
  });
  $("menu-repo-open").addEventListener("click", () => {
    const target = contextRepoTarget;
    hideContextMenu();
    if (target) void openRepoAtPath(target.path, target.vcs);
  });
  $("menu-repo-refresh").addEventListener("click", () => {
    const target = contextRepoTarget;
    hideContextMenu();
    if (target) void refreshOneRepo(target);
  });
  $("menu-repo-explorer").addEventListener("click", () => {
    const target = contextRepoTarget;
    hideContextMenu();
    if (target) void openRepoInExplorer(target.path);
  });
  for (const vcs of SECTIONS) {
    $(PULL_UI[vcs].buttonId).addEventListener("click", () => void quickPull(vcs));
  }

  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });

  // A click on another window never reaches the backdrop, so losing focus is the
  // only signal that the menu should go away.
  window.addEventListener("blur", hideContextMenu);
  window.addEventListener("click", hideContextMenu);
  window.addEventListener("resize", () => {
    // Auto-fitting the window height must not close the menu on its own.
    if (!isProgrammaticResize()) hideContextMenu();
  });

  try {
    await listen("config-saved", () => {
      void loadOpenTarget();
      void refresh({ doFetch: false });
    });
  } catch {
    /* browser preview */
  }

  await loadOpenTarget();
  void refresh({ doFetch: false });

  let interval = 300_000;
  try {
    interval = await invoke<number>("get_poll_interval_ms");
  } catch {
    /* default */
  }
  window.setInterval(() => void refresh({ doFetch: true }), interval);
}

void boot();
