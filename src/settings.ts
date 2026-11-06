import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { DEFAULT_GLASS_BLUR, glassBlur, glassEnabled } from "./glass";
import { normalizeOpenTarget, renderOpenTargetPicker } from "./open-target-picker";
import { DEFAULT_OPEN_TARGET } from "./open-targets";
import type { RepoConfig, RepoEntry, ValidateResult, Vcs } from "./types";

let configDraft: RepoConfig = {
  repos: [],
  open_target: DEFAULT_OPEN_TARGET,
  git_enabled: true,
  svn_enabled: false,
  svn_repos: [],
  always_on_top: true,
  glass: true,
  glass_blur: DEFAULT_GLASS_BLUR,
};
let autostartBusy = false;
/**
 * 창 플래그는 체크 즉시 반영하지만 config는 저장할 때만 쓴다. 취소로 초안을
 * 버리면 살아 있는 창도 이 값으로 되돌린다. 설정 로드 전에는 null이다.
 */
let savedAlwaysOnTop: boolean | null = null;
/** 배경 흐림도 체크·슬라이더 즉시 위젯에 반영하고, 취소하면 이 값으로 되돌린다. */
let savedGlass: { enabled: boolean; blur: number } | null = null;
let glassSupported = true;

async function applyAlwaysOnTop(enabled: boolean) {
  try {
    await invoke("set_always_on_top", { enabled });
  } catch {
    /* browser preview */
  }
}

/** 저장하지 않고 닫는 모든 경로(취소·Esc·창 X)에서 창 플래그를 되돌린다. */
async function revertAlwaysOnTop() {
  if (savedAlwaysOnTop === null) return;
  if ((configDraft.always_on_top ?? true) === savedAlwaysOnTop) return;
  configDraft.always_on_top = savedAlwaysOnTop;
  await applyAlwaysOnTop(savedAlwaysOnTop);
}

async function applyGlass(enabled: boolean) {
  try {
    await invoke("set_glass", { enabled });
  } catch {
    /* browser preview */
  }
}

async function applyGlassBlur(px: number) {
  try {
    await invoke("set_glass_blur", { px });
  } catch {
    /* browser preview */
  }
}

/** 저장하지 않고 닫는 모든 경로에서 배경 흐림도 저장된 값으로 되돌린다. */
async function revertGlass() {
  if (savedGlass === null) return;
  const { enabled, blur } = savedGlass;
  if (glassBlur(configDraft) !== blur) {
    configDraft.glass_blur = blur;
    await applyGlassBlur(blur);
  }
  if (glassEnabled(configDraft) !== enabled) {
    configDraft.glass = enabled;
    await applyGlass(enabled);
  }
}

/**
 * Git and SVN keep separate lists and separate add forms, so every list/form
 * helper is addressed by kind instead of being duplicated.
 */
type KindUi = {
  toggleId: string;
  bodyId: string;
  listId: string;
  emptyId: string;
  nameInputId: string;
  pathInputId: string;
  addBtnId: string;
  resultId: string;
  dropZoneId: string;
  validateCommand: string;
};

const UI: Record<Vcs, KindUi> = {
  git: {
    toggleId: "git-enabled-checkbox",
    bodyId: "git-settings-body",
    listId: "settings-repo-list",
    emptyId: "settings-empty",
    nameInputId: "input-name",
    pathInputId: "input-url",
    addBtnId: "btn-add",
    resultId: "test-result",
    dropZoneId: "path-drop-zone",
    validateCommand: "validate_repo",
  },
  svn: {
    toggleId: "svn-enabled-checkbox",
    bodyId: "svn-settings-body",
    listId: "settings-svn-list",
    emptyId: "settings-svn-empty",
    nameInputId: "input-svn-name",
    pathInputId: "input-svn-path",
    addBtnId: "btn-svn-add",
    resultId: "svn-test-result",
    dropZoneId: "svn-path-drop-zone",
    validateCommand: "validate_svn_repo",
  },
};

const lastValidate: Record<Vcs, ValidateResult | null> = { git: null, svn: null };

/** A missing Git flag means on (it predates the toggle); a missing SVN flag means off. */
function isEnabled(kind: Vcs): boolean {
  return kind === "svn" ? (configDraft.svn_enabled ?? false) : (configDraft.git_enabled ?? true);
}

function setEnabled(kind: Vcs, enabled: boolean) {
  if (kind === "svn") configDraft.svn_enabled = enabled;
  else configDraft.git_enabled = enabled;
}

function entriesFor(kind: Vcs): RepoEntry[] {
  if (kind === "svn") {
    configDraft.svn_repos ??= [];
    return configDraft.svn_repos;
  }
  return configDraft.repos;
}

async function getAutostartEnabled(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_autostart_enabled");
  } catch {
    return false;
  }
}

async function getIsDevBuild(): Promise<boolean> {
  try {
    return await invoke<boolean>("is_dev_build");
  } catch {
    return false;
  }
}

async function renderAutostartSettings() {
  const checkbox = $("autostart-checkbox") as HTMLInputElement;
  const hint = $("autostart-hint");
  const isDevBuild = await getIsDevBuild();

  if (isDevBuild) {
    checkbox.checked = false;
    checkbox.disabled = true;
    hint.textContent = "개발 빌드에서는 사용할 수 없습니다. 「시작.bat」으로 설치한 뒤 릴리스에서 설정하세요.";
    hint.classList.remove("hidden");
    return;
  }

  checkbox.disabled = autostartBusy;
  hint.classList.add("hidden");
  checkbox.checked = await getAutostartEnabled();
}

async function setAutostart(enabled: boolean) {
  if (autostartBusy) return;
  autostartBusy = true;
  const checkbox = $("autostart-checkbox") as HTMLInputElement;
  checkbox.disabled = true;

  try {
    if (enabled) {
      await invoke("enable_autostart");
    } else {
      await invoke("disable_autostart");
    }
    checkbox.checked = await getAutostartEnabled();
  } catch (e) {
    checkbox.checked = await getAutostartEnabled();
    window.alert(String(e));
  } finally {
    autostartBusy = false;
    const isDevBuild = await getIsDevBuild();
    checkbox.disabled = isDevBuild;
  }
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

/**
 * 머리 줄은 본문을 갈아엎기 전에 떼어 두었다가 다시 붙인다. OS 제목 표시줄이 없어서
 * 이 줄이 사라지면 창을 끌 수 없다. 노드를 그대로 옮기므로 닫기 X·끌기 리스너도 살아 있다.
 */
function showBootError(message: string) {
  const titlebar = document.querySelector(".settings-titlebar");
  document.body.innerHTML = `
    <div class="settings-window" style="padding:0 24px 24px">
      <h1>설정 로드 실패</h1>
      <p class="test-result fail">${message}</p>
      <button id="btn-error-close" class="btn secondary wide" type="button">닫기</button>
    </div>`;
  if (titlebar) document.querySelector(".settings-window")?.prepend(titlebar);
  document.getElementById("btn-error-close")?.addEventListener("click", () => {
    void closeWindow();
  });
}

function reorderEntries(kind: Vcs, fromIndex: number, toIndex: number) {
  if (fromIndex === toIndex) return;
  const entries = entriesFor(kind);
  const [entry] = entries.splice(fromIndex, 1);
  let insertAt = toIndex;
  if (toIndex > fromIndex) insertAt -= 1;
  entries.splice(insertAt, 0, entry);
}

function getRepoDropIndex(list: HTMLElement, clientY: number): number {
  const items = [...list.querySelectorAll<HTMLElement>(".settings-repo-item")];
  for (let i = 0; i < items.length; i++) {
    const rect = items[i].getBoundingClientRect();
    if (clientY < rect.top + rect.height / 2) return i;
  }
  return items.length;
}

function bindRepoReorderHandle(kind: Vcs, handle: HTMLButtonElement, fromIndex: number) {
  handle.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();

    const list = $(UI[kind].listId);
    const pointerId = e.pointerId;
    const items = () => [...list.querySelectorAll<HTMLElement>(".settings-repo-item")];
    let dropIndex = fromIndex;

    handle.setPointerCapture(pointerId);
    items()[fromIndex]?.classList.add("settings-repo-item--dragging");

    const clearMarkers = () => {
      items().forEach((el) => {
        el.classList.remove("settings-repo-item--dragging", "settings-repo-item--drop-target");
      });
    };

    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      dropIndex = getRepoDropIndex(list, moveEvent.clientY);
      const markerIndex = Math.min(dropIndex, items().length - 1);
      items().forEach((el, i) => {
        el.classList.toggle(
          "settings-repo-item--drop-target",
          dropIndex !== fromIndex && i === markerIndex,
        );
      });
    };

    const onUp = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== pointerId) return;
      handle.releasePointerCapture(pointerId);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      clearMarkers();

      dropIndex = getRepoDropIndex(list, upEvent.clientY);
      if (dropIndex === fromIndex) return;
      reorderEntries(kind, fromIndex, dropIndex);
      renderSettingsList(kind);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });
}

function renderSettingsList(kind: Vcs) {
  const ui = UI[kind];
  const list = $(ui.listId);
  const empty = $(ui.emptyId);
  const entries = entriesFor(kind);
  list.replaceChildren();

  if (entries.length === 0) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");

  entries.forEach((repo, index) => {
    const li = document.createElement("li");
    li.className = "settings-repo-item";
    li.dataset.index = String(index);

    const dragHandle = document.createElement("button");
    dragHandle.type = "button";
    dragHandle.className = "repo-drag-handle";
    dragHandle.setAttribute("aria-label", `${repo.name} 순서 변경`);
    dragHandle.textContent = "⋮⋮";
    bindRepoReorderHandle(kind, dragHandle, index);

    const meta = document.createElement("div");
    meta.className = "settings-repo-meta";
    const title = document.createElement("strong");
    title.textContent = repo.name;
    const path = document.createElement("span");
    path.textContent = repo.path;
    if (repo.url) {
      const url = document.createElement("span");
      url.className = "settings-repo-url";
      url.textContent = repo.url;
      meta.append(title, path, url);
    } else {
      meta.append(title, path);
    }

    const actions = document.createElement("div");
    actions.className = "settings-repo-actions";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "btn danger small";
    remove.textContent = "삭제";
    remove.addEventListener("click", () => {
      entriesFor(kind).splice(index, 1);
      renderSettingsList(kind);
    });

    actions.append(remove);
    li.append(dragHandle, meta, actions);
    list.append(li);
  });
}

function resetAddForm(kind: Vcs) {
  const ui = UI[kind];
  ($(ui.nameInputId) as HTMLInputElement).value = "";
  ($(ui.pathInputId) as HTMLInputElement).value = "";
  ($(ui.addBtnId) as HTMLButtonElement).disabled = true;
  lastValidate[kind] = null;
  $(ui.resultId).textContent = "테스트로 유효성을 확인하세요.";
  $(ui.resultId).className = "test-result";
}

async function loadConfigDraft() {
  configDraft = (await invoke("get_config")) as RepoConfig;
  configDraft.open_target = normalizeOpenTarget(configDraft.open_target);
  configDraft.git_enabled ??= true;
  configDraft.svn_enabled ??= false;
  configDraft.svn_repos ??= [];
  configDraft.always_on_top ??= true;
  savedAlwaysOnTop = configDraft.always_on_top;
  configDraft.glass = glassEnabled(configDraft);
  configDraft.glass_blur = glassBlur(configDraft);
  savedGlass = { enabled: configDraft.glass, blur: configDraft.glass_blur };
}

function renderOpenTargetSettings() {
  renderOpenTargetPicker($("open-target-picker"), configDraft.open_target ?? DEFAULT_OPEN_TARGET, (target) => {
    configDraft.open_target = target;
  });
}

function renderAlwaysOnTopSettings() {
  const checkbox = $("always-on-top-checkbox") as HTMLInputElement;
  checkbox.checked = configDraft.always_on_top ?? true;
}

/**
 * 배경 흐림은 캡처에서 위젯을 빼는 기능(Windows 10 2004 이상)이 있어야 한다.
 * 저장값은 그대로 두고 토글만 막아, 지원하는 PC에서는 같은 설정이 살아 있게 한다.
 */
async function renderGlassSettings() {
  const checkbox = $("glass-checkbox") as HTMLInputElement;
  const hint = $("glass-hint");
  glassSupported = await invoke<boolean>("glass_supported").catch(() => false);
  checkbox.disabled = !glassSupported;
  checkbox.checked = glassSupported && glassEnabled(configDraft);
  hint.textContent = glassSupported
    ? "위젯 뒤 화면을 흐리게 비춥니다."
    : "이 Windows에서는 쓸 수 없습니다. Windows 10 2004 이상에서 동작합니다.";
  renderGlassBlur();
}

/** 반경 슬라이더는 배경 흐림이 켜져 있을 때만 쓴다. */
function renderGlassBlur() {
  const slider = $("glass-blur") as HTMLInputElement;
  const px = glassBlur(configDraft);
  slider.value = String(px);
  slider.disabled = !(glassSupported && glassEnabled(configDraft));
  $("glass-blur-value").textContent = `${px}px`;
}

/** The list and add form only show while the section is switched on. */
function renderEnabledToggle(kind: Vcs) {
  const checkbox = $(UI[kind].toggleId) as HTMLInputElement;
  checkbox.checked = isEnabled(kind);
  $(UI[kind].bodyId).classList.toggle("hidden", !checkbox.checked);
}

async function runTest(kind: Vcs) {
  const ui = UI[kind];
  const input = ($(ui.pathInputId) as HTMLInputElement).value.trim();
  const resultEl = $(ui.resultId);
  const addBtn = $(ui.addBtnId) as HTMLButtonElement;
  resultEl.textContent = "테스트 중…";
  resultEl.className = "test-result pending";
  addBtn.disabled = true;
  lastValidate[kind] = null;

  try {
    const result = (await invoke(ui.validateCommand, { input })) as ValidateResult;
    lastValidate[kind] = result;
    resultEl.textContent = result.message;
    resultEl.className = `test-result ${result.ok ? "ok" : "fail"}`;

    if (result.ok) {
      addBtn.disabled = false;
      const nameInput = $(ui.nameInputId) as HTMLInputElement;
      if (!nameInput.value.trim() && result.suggested_name) {
        nameInput.value = result.suggested_name;
      }
    }
  } catch (e) {
    resultEl.textContent = String(e);
    resultEl.className = "test-result fail";
  }
}

function addRepoFromForm(kind: Vcs) {
  const ui = UI[kind];
  const validated = lastValidate[kind];
  if (!validated?.ok || !validated.resolved_path) return;

  const nameInput = ($(ui.nameInputId) as HTMLInputElement).value.trim();
  const name = nameInput || validated.suggested_name || "repo";
  const path = validated.resolved_path;
  const entries = entriesFor(kind);

  if (entries.some((r) => r.path.toLowerCase() === path.toLowerCase())) {
    $(ui.resultId).textContent = "이미 등록된 경로입니다.";
    $(ui.resultId).className = "test-result fail";
    return;
  }

  entries.push({ name, path, url: validated.remote_url });
  renderSettingsList(kind);
  resetAddForm(kind);
}

async function closeWindow() {
  await revertAlwaysOnTop();
  await revertGlass();
  try {
    await invoke("close_settings_window");
  } catch {
    /* browser preview */
  }
}

async function saveAndClose() {
  await invoke("set_config", { config: configDraft });
  savedAlwaysOnTop = configDraft.always_on_top ?? true;
  savedGlass = { enabled: glassEnabled(configDraft), blur: glassBlur(configDraft) };
  await emit("config-saved");
  await closeWindow();
}

async function refreshView() {
  await loadConfigDraft();
  renderSettingsList("git");
  renderSettingsList("svn");
  renderOpenTargetSettings();
  renderAlwaysOnTopSettings();
  await renderGlassSettings();
  renderEnabledToggle("git");
  renderEnabledToggle("svn");
  await renderAutostartSettings();
  resetAddForm("git");
  resetAddForm("svn");
}

function isPointInElement(el: HTMLElement, x: number, y: number): boolean {
  const rect = el.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const logicalX = x / dpr;
  const logicalY = y / dpr;
  return (
    logicalX >= rect.left &&
    logicalX <= rect.right &&
    logicalY >= rect.top &&
    logicalY <= rect.bottom
  );
}

function applyDroppedPath(kind: Vcs, path: string) {
  const ui = UI[kind];
  ($(ui.pathInputId) as HTMLInputElement).value = path;
  ($(ui.addBtnId) as HTMLButtonElement).disabled = true;
  lastValidate[kind] = null;
  $(ui.resultId).textContent = "드롭된 경로를 테스트 중…";
  $(ui.resultId).className = "test-result pending";
  void runTest(kind);
}

/** Both add forms accept folder drops, so the drop is routed by hit-test. */
function bindPathDropZones() {
  const zones = (Object.keys(UI) as Vcs[]).map((kind) => ({
    kind,
    el: $(UI[kind].dropZoneId),
    active: false,
  }));

  const setActive = (zone: (typeof zones)[number], active: boolean) => {
    if (zone.active === active) return;
    zone.active = active;
    zone.el.classList.toggle("path-drop-zone--active", active);
  };

  const visible = (zone: (typeof zones)[number]) => zone.el.offsetParent !== null;

  void getCurrentWebview()
    .onDragDropEvent((event) => {
      const { payload } = event;

      if (payload.type === "enter" || payload.type === "over") {
        const position = "position" in payload ? payload.position : null;
        if (position) {
          for (const zone of zones) {
            setActive(zone, visible(zone) && isPointInElement(zone.el, position.x, position.y));
          }
        }
        return;
      }

      if (payload.type === "leave") {
        zones.forEach((zone) => setActive(zone, false));
        return;
      }

      if (payload.type !== "drop") return;

      const position = payload.position;
      const hit = zones.find((zone) => visible(zone) && isPointInElement(zone.el, position.x, position.y));
      zones.forEach((zone) => setActive(zone, false));
      if (!hit) return;

      const path = payload.paths[0];
      if (!path) {
        $(UI[hit.kind].resultId).textContent = "드롭된 항목에서 경로를 읽을 수 없습니다.";
        $(UI[hit.kind].resultId).className = "test-result fail";
        return;
      }

      applyDroppedPath(hit.kind, path);
    })
    .catch(() => {
      /* browser preview without Tauri webview */
    });
}

function bindUi() {
  $("btn-test").addEventListener("click", () => void runTest("git"));
  $("btn-add").addEventListener("click", () => addRepoFromForm("git"));
  $("btn-svn-test").addEventListener("click", () => void runTest("svn"));
  $("btn-svn-add").addEventListener("click", () => addRepoFromForm("svn"));
  $("btn-save-close").addEventListener("click", () => void saveAndClose());
  $("btn-cancel").addEventListener("click", () => void closeWindow());
  bindPathDropZones();

  const alwaysOnTopCheckbox = $("always-on-top-checkbox") as HTMLInputElement;
  alwaysOnTopCheckbox.addEventListener("change", () => {
    configDraft.always_on_top = alwaysOnTopCheckbox.checked;
    void applyAlwaysOnTop(alwaysOnTopCheckbox.checked);
  });

  const glassCheckbox = $("glass-checkbox") as HTMLInputElement;
  glassCheckbox.addEventListener("change", () => {
    if (!glassSupported) return;
    configDraft.glass = glassCheckbox.checked;
    renderGlassBlur();
    void applyGlass(glassCheckbox.checked);
  });

  // 슬라이더를 움직이는 동안에도 바로 보이도록 input마다 위젯에 반영한다.
  const glassBlurSlider = $("glass-blur") as HTMLInputElement;
  glassBlurSlider.addEventListener("input", () => {
    const px = Number(glassBlurSlider.value);
    configDraft.glass_blur = px;
    $("glass-blur-value").textContent = `${px}px`;
    void applyGlassBlur(px);
  });

  for (const kind of Object.keys(UI) as Vcs[]) {
    const checkbox = $(UI[kind].toggleId) as HTMLInputElement;
    checkbox.addEventListener("change", () => {
      setEnabled(kind, checkbox.checked);
      renderEnabledToggle(kind);
    });
  }

  const autostartCheckbox = $("autostart-checkbox") as HTMLInputElement;
  autostartCheckbox.addEventListener("change", () => {
    void setAutostart(autostartCheckbox.checked);
  });
}

/**
 * 머리 줄 — OS 제목 표시줄 대신이다(tauri.conf.json decorations: false). 닫기 X·Esc는
 * 취소 버튼과 같은 closeWindow()로 닫아 즉시 반영해 둔 창 플래그·배경 흐림을 되돌리고,
 * 부팅 전에 걸어 두어 설정 로드가 실패해도 닫을 수 있게 한다. 끌기는 data-tauri-drag-region
 * 대신 직접 처리한다. 그 속성은 두 번 누르면 창을 최대화해 설정 창에 맞지 않고, 붙인 요소를
 * 직접 누를 때만 끌려서 제목 위를 따로 챙겨야 한다(Frond titlebar.ts와 같은 방식).
 */
function initTitlebar() {
  $("btn-titlebar-close").addEventListener("click", () => {
    void closeWindow();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void closeWindow();
  });
  document.querySelector(".settings-titlebar")?.addEventListener("mousedown", (event) => {
    const e = event as MouseEvent;
    if (e.button !== 0 || e.detail > 1) return;
    if ((e.target as Element).closest("button, a, input, select")) return;
    e.preventDefault();
    try {
      void getCurrentWindow().startDragging();
    } catch {
      /* browser preview */
    }
  });
}

async function boot() {
  try {
    await refreshView();
    bindUi();
    await listen("settings-open", () => {
      void refreshView();
    });
    await listen("settings-cancelled", () => {
      void revertAlwaysOnTop();
      void revertGlass();
    });
  } catch (e) {
    showBootError(String(e));
  }
}

initTitlebar();
void boot();
