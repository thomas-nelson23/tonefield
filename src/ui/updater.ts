import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** What src-tauri/src/update.rs reports about the latest GitHub release. */
interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  notes: string;
  page: string;
  kind: "pacman" | "deb" | "appimage" | "windows" | "macos" | "manual";
  asset_url: string | null;
  asset_name: string | null;
}

/**
 * The bottom bar's Update button. It checks GitHub Releases for a newer
 * version (quietly at launch, and whenever it's clicked), lights up when one
 * is out, and opens a popup to install it and restart. Hidden in a plain
 * browser, where there's nothing to install.
 */
export function setupUpdater(): void {
  const button = document.getElementById("update-button") as HTMLButtonElement;
  const pop = document.getElementById("update-pop")!;
  if (!isTauri()) return;
  button.hidden = false;

  let info: UpdateInfo | null = null;
  let busy = false;

  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = "", cls = "") => {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  };
  const show = (...children: Node[]) => {
    pop.replaceChildren(...children);
    pop.hidden = false;
  };
  const close = () => {
    if (!busy) pop.hidden = true;
  };
  const action = (label: string, run: () => void, primary = false) => {
    const b = el("button", label, primary ? "primary" : "");
    b.type = "button";
    b.addEventListener("click", run);
    return b;
  };
  const row = (...buttons: HTMLElement[]) => {
    const r = el("div", "", "row-buttons");
    r.append(...buttons);
    return r;
  };
  const openPage = () => {
    if (info) invoke("update_open_page", { url: info.page }).catch(() => {});
  };

  const mark = (available: boolean) => {
    button.classList.toggle("on", available);
    button.title = available && info ? `Tonefield ${info.latest} is available` : "Check for updates";
  };

  const showInfo = () => {
    if (!info) return;
    if (!info.available) {
      show(el("p", `Tonefield ${info.current} is the latest version.`), row(action("Close", close)));
      return;
    }
    // GitHub's generated notes are Markdown: drop heading marks, bullet the lists
    const text = info.notes.replace(/^#+\s*/gm, "").replace(/^[*-]\s+/gm, "• ").replace(/\*\*/g, "").trim();
    const notes = el("div", text || "No release notes.", "update-notes");
    const buttons = info.kind === "manual"
      ? [action("Open release page", openPage, true), action("Later", close)]
      : [action("Install and restart", install, true), action("Release page", openPage), action("Later", close)];
    const parts: Node[] = [el("h3", `Tonefield ${info.latest} is out`), el("p", `You have ${info.current}.`, "muted"), notes];
    if (info.kind === "manual") parts.push(el("p", "This copy can't update itself (it isn't an installed package), so grab the new version from the release page.", "muted"));
    if (info.kind === "pacman" || info.kind === "deb") parts.push(el("p", "Your system will ask for your password to install it.", "muted"));
    show(...parts, row(...buttons));
  };

  const check = async (quiet: boolean) => {
    if (busy) return;
    busy = true;
    if (!quiet) show(el("p", "Checking for updates…"));
    try {
      info = await invoke<UpdateInfo>("update_check");
      mark(info.available);
      busy = false;
      if (!quiet) showInfo();
    } catch (e) {
      busy = false;
      if (!quiet) show(el("p", String(e)), row(action("Close", close)));
    }
  };

  const progress = el("div", "", "update-progress");
  const bar = el("span");
  progress.append(bar);
  const progressText = el("p", "", "muted");

  async function install() {
    if (!info?.asset_url || !info.asset_name) return;
    busy = true;
    bar.style.width = "0%";
    progressText.textContent = "Downloading…";
    show(el("h3", `Installing Tonefield ${info.latest}`), progress, progressText);
    const stop = await listen<{ done: number; total: number }>("update-progress", ({ payload }) => {
      const mb = (n: number) => (n / 1048576).toFixed(1);
      bar.style.width = payload.total ? `${(100 * payload.done) / payload.total}%` : "100%";
      progressText.textContent = payload.total
        ? `Downloading… ${mb(payload.done)} of ${mb(payload.total)} MB`
        : `Downloading… ${mb(payload.done)} MB`;
      if (payload.total && payload.done >= payload.total) {
        progressText.textContent = info?.kind === "windows" ? "Starting the installer…"
          : info?.kind === "pacman" || info?.kind === "deb" ? "Installing… enter your password if asked."
          : "Installing…";
      }
    });
    try {
      await invoke("update_install", { kind: info.kind, url: info.asset_url, name: info.asset_name });
      busy = false;
      if (info.kind === "macos") {
        show(el("p", "The new version's disk image is open. Drag Tonefield into Applications, then quit and reopen it."), row(action("Close", close)));
      } else {
        show(
          el("p", `Tonefield ${info.latest} is installed. Restart to use it.`),
          row(action("Restart now", () => invoke("update_restart").catch((e) => show(el("p", String(e)))), true), action("Later", close)),
        );
        info.available = false;
        mark(false);
      }
    } catch (e) {
      busy = false;
      show(el("p", String(e)), row(action("Try again", install, true), action("Close", close)));
    } finally {
      stop();
    }
  }

  button.addEventListener("click", () => {
    button.blur();
    if (!pop.hidden && !busy) close();
    else if (info?.available) showInfo();
    else check(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  // Once per launch, quietly: the button lights up if there's something new
  check(true);
}
