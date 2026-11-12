import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

// ==========================================
// App Constants
// ==========================================
const APP_VERSION = "1.0.2";
const APP_DEV = "YawHackka";
const APP_ORG = "YawStar";
const APP_RELEASE_DATE = "13.Nov.2026";
const APP_GITHUB_LINK = "https://github.com/YawStar/DupliZero";
const APP_GITHUB_NAME = "YawStar/DupliZero";

interface ScanResult {
  volume_label: string;
  base_folder: string;
  total_files: number;
  errors: string[];
}
interface DupEntry {
  volume_label: string;
  base_folder: string;
  rel_path: string;
  size: number;
  file_ext: string;
}

let cachedDups: Record<string, DupEntry[]> | null = null;
let isSearchingDups = false;
let isScanning = false;
let deleteActionCallback: (() => void) | null = null;

window.onload = async () => {
  await invoke("init_db");
  await loadFolders();

  const elVersion = document.getElementById("appVersion");
  const elDev = document.getElementById("appDev");
  const elOrg = document.getElementById("appOrg");
  const elDate = document.getElementById("appDate");
  const elGithub = document.getElementById("appGithub");

  if (elVersion) elVersion.innerText = APP_VERSION;
  if (elDev) elDev.innerText = APP_DEV;
  if (elOrg) elOrg.innerText = APP_ORG;
  if (elDate) elDate.innerText = APP_RELEASE_DATE;

  if (elGithub) {
    elGithub.innerText = APP_GITHUB_NAME;
    elGithub.setAttribute("href", APP_GITHUB_LINK);
  }

  document.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
    });
  });

  const savedTheme = localStorage.getItem("theme");
  if (savedTheme === "light") {
    document.body.classList.add("light-mode");
    updateThemeIcons(true);
  } else {
    updateThemeIcons(false);
  }

  await listen<[number, string]>("scan-progress", (event) => {
    const [count, path] = event.payload;
    const statusDiv = document.getElementById("scanStatus") as HTMLDivElement;
    statusDiv.innerText = `Scanning... ${count.toLocaleString()} files (${path})`;
  });

  await listen<[number, number, string]>("dup-progress", (event) => {
    const [current, total, name] = event.payload;
    const statusDiv = document.getElementById("dupStatus") as HTMLDivElement;
    statusDiv.innerText = `Searching... (${current} / ${total}) — ${name}`;
    const progressBar = document.querySelector(
      "#dupProgressContainer .custom-progress-bar",
    ) as HTMLDivElement;
    if (progressBar && total > 0) {
      progressBar.style.width = `${(current / total) * 100}%`;
    }
  });
};

// --- Page Navigation ---
function showResultPage(): void {
  (document.getElementById("mainPage") as HTMLDivElement).style.display =
    "none";
  (document.getElementById("resultPage") as HTMLDivElement).style.display =
    "flex";
}

function goBack(): void {
  (document.getElementById("resultPage") as HTMLDivElement).style.display =
    "none";
  (document.getElementById("mainPage") as HTMLDivElement).style.display =
    "flex";
}

// Result Page
function viewLastResults(): void {
  if (!cachedDups) {
    showAlert("No results available. Please run 'Find Duplicate' first.");
    return;
  }

  const resDiv = document.getElementById("resultsContent") as HTMLDivElement;
  const keys = Object.keys(cachedDups).sort();
  let totalFiles = 0;
  keys.forEach((k) => (totalFiles += cachedDups![k].length));

  let html = `<p style="font-size: 16px; margin-bottom: 15px;">
      <strong>Total Duplicate Names:</strong> ${keys.length} <br>
      <strong>Total Files Involved:</strong> ${totalFiles}
  </p><hr style="border-color: var(--border); margin-bottom: 20px;">`;

  keys.forEach((name) => {
    const entries = cachedDups![name];
    html += `<div class="dup-group">`;
    html += `<div class="dup-title">📄 ${name} (${entries.length} copies)</div>`;
    entries.forEach((e) => {
      html += `<div class="dup-item">• [${e.volume_label}] ${e.base_folder}\\${e.rel_path} (${formatBytes(e.size)})</div>`;
    });
    html += `</div>`;
  });

  resDiv.innerHTML = html;
  showResultPage();
}

// --- UI Lock/Unlock Helpers ---
function lockAllUI(
  exceptScanCancel: boolean = false,
  exceptFindStop: boolean = false,
): void {
  (document.getElementById("btnBrowse") as HTMLButtonElement).disabled = true;
  (document.getElementById("btnRefreshList") as HTMLButtonElement).disabled =
    true;
  (document.getElementById("btnCleanDatabase") as HTMLButtonElement).disabled =
    true;
  (document.getElementById("folderPath") as HTMLInputElement).disabled = true;
  (document.getElementById("extensions") as HTMLInputElement).disabled = true;

  document.querySelectorAll(".delete-icon").forEach((icon) => {
    (icon as HTMLElement).style.pointerEvents = "none";
    (icon as HTMLElement).style.opacity = "0.3";
  });

  if (!exceptScanCancel) {
    (document.getElementById("btnScan") as HTMLButtonElement).disabled = true;
  }

  if (!exceptFindStop) {
    (document.getElementById("btnFindDup") as HTMLButtonElement).disabled =
      true;
  }

  const btnExport = document.getElementById(
    "btnExport",
  ) as HTMLButtonElement | null;
  if (btnExport) btnExport.disabled = true;

  const btnViewResults = document.getElementById(
    "btnViewResults",
  ) as HTMLButtonElement | null;
  if (btnViewResults) btnViewResults.disabled = true;
}

function unlockAllUI(): void {
  (document.getElementById("btnBrowse") as HTMLButtonElement).disabled = false;
  (document.getElementById("btnScan") as HTMLButtonElement).disabled = false;
  (document.getElementById("btnRefreshList") as HTMLButtonElement).disabled =
    false;
  (document.getElementById("btnCleanDatabase") as HTMLButtonElement).disabled =
    false;
  (document.getElementById("btnFindDup") as HTMLButtonElement).disabled = false;
  (document.getElementById("folderPath") as HTMLInputElement).disabled = false;
  (document.getElementById("extensions") as HTMLInputElement).disabled = false;

  document.querySelectorAll(".delete-icon").forEach((icon) => {
    (icon as HTMLElement).style.pointerEvents = "auto";
    (icon as HTMLElement).style.opacity = "0.7";
  });

  const btnExport = document.getElementById(
    "btnExport",
  ) as HTMLButtonElement | null;
  if (btnExport) btnExport.disabled = false;

  const btnViewResults = document.getElementById(
    "btnViewResults",
  ) as HTMLButtonElement | null;
  if (btnViewResults && cachedDups) {
    btnViewResults.disabled = false;
  }
}

// --- Custom Alert Modal ---
function showAlert(message: string): void {
  const modal = document.getElementById("customAlert") as HTMLDivElement;
  const msgText = document.getElementById(
    "alertMessage",
  ) as HTMLParagraphElement;
  msgText.innerText = message;
  modal.style.display = "flex";
}

function closeAlert(): void {
  (document.getElementById("customAlert") as HTMLDivElement).style.display =
    "none";
}

// --- Theme & UI Features ---
function updateThemeIcons(isLight: boolean): void {
  const sunIcon = document.getElementById("themeIconSun") as HTMLElement;
  const moonIcon = document.getElementById("themeIconMoon") as HTMLElement;
  if (!sunIcon || !moonIcon) return;
  if (isLight) {
    sunIcon.style.display = "none";
    moonIcon.style.display = "block";
  } else {
    sunIcon.style.display = "block";
    moonIcon.style.display = "none";
  }
}

function toggleTheme(): void {
  const body = document.body;
  if (body.classList.contains("light-mode")) {
    body.classList.remove("light-mode");
    updateThemeIcons(false);
    localStorage.setItem("theme", "dark");
  } else {
    body.classList.add("light-mode");
    updateThemeIcons(true);
    localStorage.setItem("theme", "light");
  }
}

function openGithub(): void {
  openUrl(APP_GITHUB_LINK).catch((err) => {
    showAlert("Failed to open link: " + err);
  });
}

function showAbout(): void {
  (document.getElementById("aboutModal") as HTMLDivElement).style.display =
    "flex";
}

function modalAboutCancel(): void {
  (document.getElementById("aboutModal") as HTMLDivElement).style.display =
    "none";
}

// --- File Scan Features ---
async function browseFolder(): Promise<void> {
  const selected = await open({ directory: true, multiple: false });
  if (selected && typeof selected === "string") {
    (document.getElementById("folderPath") as HTMLInputElement).value =
      selected;
  }
}

async function toggleScan(): Promise<void> {
  if (isScanning) {
    await cancelScan();
    return;
  }

  const folder = (document.getElementById("folderPath") as HTMLInputElement)
    .value;
  if (!folder) {
    showAlert("Please select a folder first.");
    return;
  }

  const extStr = (document.getElementById("extensions") as HTMLInputElement)
    .value;
  const exts = extStr
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);

  const btnScan = document.getElementById("btnScan") as HTMLButtonElement;
  const btnText = document.getElementById("scanBtnText") as HTMLSpanElement;
  const scanIcon = document.getElementById("scanIcon") as HTMLElement;
  const stopIcon = document.getElementById("scanStopIcon") as HTMLElement;
  const progressContainer = document.getElementById(
    "progressContainer",
  ) as HTMLDivElement;
  const statusDiv = document.getElementById("scanStatus") as HTMLDivElement;
  const scanProgressBar = document.querySelector(
    "#progressContainer .custom-progress-bar",
  ) as HTMLDivElement;

  isScanning = true;
  lockAllUI(false, false);
  btnScan.disabled = false;

  btnText.innerText = "Cancel";
  scanIcon.style.display = "none";
  stopIcon.style.display = "block";
  btnScan.classList.remove("primary");
  btnScan.classList.add("danger");

  progressContainer.style.display = "block";
  statusDiv.innerText = "Scanning...";
  if (scanProgressBar) scanProgressBar.classList.add("is-marquee");

  try {
    const res = await invoke<ScanResult>("scan_folder", {
      folderPath: folder,
      allowedExts: exts,
    });

    progressContainer.style.display = "none";
    statusDiv.innerText = `✅ ${res.volume_label}: ${res.total_files.toLocaleString()} files scanned.`;

    let msg = `✅ Scan Completed!\n\nVolume: ${res.volume_label}\nTotal Files: ${res.total_files.toLocaleString()}\n`;
    if (res.errors.length > 0) msg += `\n⚠️ Errors: ${res.errors.length}`;
    showAlert(msg);
    await loadFolders();

    cachedDups = null;
    const btnView = document.getElementById(
      "btnViewResults",
    ) as HTMLButtonElement | null;
    if (btnView) btnView.disabled = true;
    const resContent = document.getElementById(
      "resultsContent",
    ) as HTMLDivElement | null;
    if (resContent) resContent.innerHTML = "";
  } catch (e) {
    progressContainer.style.display = "none";
    if (String(e).includes("cancelled")) {
      statusDiv.innerText = `❌ Scan cancelled.`;
    } else {
      showAlert("Error: " + e);
      statusDiv.innerText = "";
    }
  } finally {
    isScanning = false;
    btnText.innerText = "Scan Folder";
    scanIcon.style.display = "block";
    stopIcon.style.display = "none";
    btnScan.classList.add("primary");
    btnScan.classList.remove("danger");
    unlockAllUI();
    if (scanProgressBar) scanProgressBar.classList.remove("is-marquee");
  }
}

async function cancelScan(): Promise<void> {
  await invoke("cancel_scan");
  (document.getElementById("scanStatus") as HTMLDivElement).innerText =
    "Cancelling...";
}

async function loadFolders(): Promise<void> {
  const list = document.getElementById("folderList") as HTMLUListElement;
  list.innerHTML = "";

  try {
    const folders =
      await invoke<[string, string, number, number, number][]>("get_folders");
    folders.forEach(([vol, base, count, size, scanned_at]) => {
      const li = document.createElement("li");

      const dateObj = new Date(scanned_at * 1000);
      const timeStr =
        dateObj.getFullYear() +
        "-" +
        String(dateObj.getMonth() + 1).padStart(2, "0") +
        "-" +
        String(dateObj.getDate()).padStart(2, "0") +
        " " +
        String(dateObj.getHours()).padStart(2, "0") +
        ":" +
        String(dateObj.getMinutes()).padStart(2, "0");

      const label = vol || "No Label";
      const textSpan = document.createElement("span");
      textSpan.innerText = `[${label}] ${base} — files: ${count.toLocaleString()} — size: ${size.toLocaleString()} bytes — scanned: ${timeStr}`;

      const deleteIcon = document.createElement("span");
      deleteIcon.className = "delete-icon";
      deleteIcon.innerText = "✖";
      deleteIcon.title = "Remove";
      deleteIcon.style.color = "var(--danger)";

      deleteIcon.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        showConfirm(
          `Are you sure you want to remove folder ${base} (Volume: ${label}) from the database?`,
          async () => {
            await invoke("clear_db", { volumeLabel: vol, baseFolder: base });
            await loadFolders();
            cachedDups = null;
            const btnView = document.getElementById(
              "btnViewResults",
            ) as HTMLButtonElement | null;
            if (btnView) btnView.disabled = true;
            const resContent = document.getElementById(
              "resultsContent",
            ) as HTMLDivElement | null;
            if (resContent) resContent.innerHTML = "";
          },
        );
      };

      li.onclick = () => {
        Array.from(list.children).forEach((c) =>
          c.classList.remove("selected"),
        );
        li.classList.add("selected");
      };

      li.appendChild(textSpan);
      li.appendChild(deleteIcon);
      list.appendChild(li);
    });
  } catch (e) {
    console.error("Failed to load folders", e);
  }
}

function showConfirm(message: string, onConfirm: () => void): void {
  const modal = document.getElementById("customConfirm") as HTMLDivElement;
  const msgText = document.getElementById(
    "confirmMessage",
  ) as HTMLParagraphElement;
  msgText.innerText = message;
  deleteActionCallback = onConfirm;
  modal.style.display = "flex";
}

function modalConfirm(): void {
  const modal = document.getElementById("customConfirm") as HTMLDivElement;
  modal.style.display = "none";
  if (deleteActionCallback) {
    deleteActionCallback();
    deleteActionCallback = null;
  }
}

function modalCancel(): void {
  const modal = document.getElementById("customConfirm") as HTMLDivElement;
  modal.style.display = "none";
  deleteActionCallback = null;
}

async function clearAll(): Promise<void> {
  showConfirm(
    "Are you sure you want to remove all entries from the database?\n(Original files will not be removed, only the database entries.)",
    async () => {
      await invoke("clear_db", { volumeLabel: null, baseFolder: null });
      await loadFolders();
      cachedDups = null;
      const btnView = document.getElementById(
        "btnViewResults",
      ) as HTMLButtonElement | null;
      if (btnView) btnView.disabled = true;
      const resContent = document.getElementById(
        "resultsContent",
      ) as HTMLDivElement | null;
      if (resContent) resContent.innerHTML = "";
      showAlert("Database cleared successfully. ✅");
    },
  );
}

// --- Duplicate Search Features ---
async function findDuplicates(): Promise<void> {
  const btnFind = document.getElementById("btnFindDup") as HTMLButtonElement;
  const btnText = document.getElementById("findBtnText") as HTMLSpanElement;
  const findIcon = document.getElementById("findIcon") as HTMLElement;
  const stopIcon = document.getElementById("stopIcon") as HTMLElement;

  if (isSearchingDups) {
    await stopDuplicateSearch();
    return;
  }

  const resDiv = document.getElementById("resultsContent") as HTMLDivElement;
  const progressContainer = document.getElementById(
    "dupProgressContainer",
  ) as HTMLDivElement;
  const statusDiv = document.getElementById("dupStatus") as HTMLDivElement;
  const progressBar = document.querySelector(
    "#dupProgressContainer .custom-progress-bar",
  ) as HTMLDivElement;

  isSearchingDups = true;
  lockAllUI(false, true);
  btnFind.disabled = false;

  btnText.innerText = "Stop";
  findIcon.style.display = "none";
  stopIcon.style.display = "block";

  btnFind.classList.remove("primary");
  btnFind.classList.add("danger");

  progressContainer.style.display = "block";
  statusDiv.innerText = "Starting search...";
  resDiv.innerHTML = "";

  if (progressBar) progressBar.style.width = "0%";

  try {
    const dups = await invoke<Record<string, DupEntry[]>>("find_duplicates");
    cachedDups = dups;
    progressContainer.style.display = "none";
    statusDiv.innerText = "";

    const keys = Object.keys(dups).sort();
    if (keys.length === 0) {
      showAlert("No duplicates found.");
      const btnView = document.getElementById(
        "btnViewResults",
      ) as HTMLButtonElement | null;
      if (btnView) btnView.disabled = true;
      return;
    }

    const btnView = document.getElementById(
      "btnViewResults",
    ) as HTMLButtonElement | null;
    if (btnView) btnView.disabled = false;

    viewLastResults();
  } catch (e) {
    progressContainer.style.display = "none";
    if (String(e).includes("cancelled")) {
      statusDiv.innerText = "❌ Search cancelled.";
    } else {
      showAlert("Error: " + e);
    }

    throw e;
  } finally {
    isSearchingDups = false;

    btnText.innerText = "Find Duplicate";
    findIcon.style.display = "block";
    stopIcon.style.display = "none";

    btnFind.classList.add("primary");
    btnFind.classList.remove("danger");

    unlockAllUI();
  }
}

async function stopDuplicateSearch(): Promise<void> {
  await invoke("cancel_duplicate_search");
  const statusDiv = document.getElementById("dupStatus") as HTMLDivElement;
  statusDiv.innerText = "Cancelling...";
}

async function exportReport(): Promise<void> {
  if (!cachedDups) {
    showAlert("No duplicates found yet. Please run 'Find Duplicate' first.");
    return;
  }

  const dups = cachedDups;
  const keys = Object.keys(dups).sort();
  if (keys.length === 0) {
    showAlert("No duplicates found.");
    return;
  }

  try {
    const filePath = await save({
      filters: [{ name: "Text File", extensions: ["txt"] }],
      defaultPath: "duplicates_report.txt",
    });
    if (!filePath) return;

    let totalFiles = 0;
    let totalExtraBytes = 0;
    const volumes = new Set<string>();

    keys.forEach((k) => {
      totalFiles += dups[k].length;
      const sizes = dups[k].map((e) => e.size);
      totalExtraBytes += sizes.reduce((a, b) => a + b, 0) - Math.min(...sizes);
      dups[k].forEach((e) => volumes.add(e.volume_label));
    });

    const now = new Date().toLocaleString();
    let content = "";
    content += "============================================================\n";
    content += "  DUPLICATE FILE REPORT\n";
    content += `  Generated: ${now}\n`;
    content += "============================================================\n";
    content += `  Duplicate names      : ${keys.length}\n`;
    content += `  Total files involved : ${totalFiles}\n`;
    content += `  Extra copies         : ${totalFiles - keys.length}\n`;
    content += `  Extra bytes          : ${formatBytes(totalExtraBytes)}\n`;
    content += `  Volumes involved     : ${Array.from(volumes).join(", ")}\n`;
    content +=
      "============================================================\n\n";

    keys.forEach((name, index) => {
      const entries = dups[name];
      content += `[${index + 1}] 📄 ${name}   (${entries.length} copies)\n`;
      entries.forEach((e) => {
        content += `       • [${e.volume_label}] ${e.base_folder}\\${e.rel_path}   (${formatBytes(e.size)})\n`;
      });
      content += "\n";
    });

    await writeTextFile(filePath, content);
    showAlert(`Report saved to:\n${filePath}`);
  } catch (e) {
    showAlert("Export Error: " + e);
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024,
    sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

function clearExtensions(): void {
  const extInput = document.getElementById("extensions") as HTMLInputElement;
  if (extInput) {
    extInput.value = "";
    extInput.focus();
  }
}

function clearfolderPath(): void {
  const folderInput = document.getElementById("folderPath") as HTMLInputElement;
  if (folderInput) {
    folderInput.value = "";
    folderInput.focus();
  }
}

(window as any).toggleTheme = toggleTheme;
(window as any).openGithub = openGithub;
(window as any).showAbout = showAbout;
(window as any).modalAboutCancel = modalAboutCancel;
(window as any).clearExtensions = clearExtensions;
(window as any).clearfolderPath = clearfolderPath;
(window as any).browseFolder = browseFolder;
(window as any).toggleScan = toggleScan;
(window as any).findDuplicates = findDuplicates;
(window as any).exportReport = exportReport;
(window as any).loadFolders = loadFolders;
(window as any).clearAll = clearAll;
(window as any).modalConfirm = modalConfirm;
(window as any).modalCancel = modalCancel;
(window as any).closeAlert = closeAlert;
(window as any).goBack = goBack;
(window as any).viewLastResults = viewLastResults;
