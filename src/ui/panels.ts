import { paintRange } from "./controls";

/**
 * The titled panels down the right: remember which ones are folded, and keep
 * the buttons in their headers (Reset, Zero) from folding the panel too.
 */
export function setupPanels(): void {
  let closed = new Set<string>();
  try {
    closed = new Set(JSON.parse(localStorage.getItem("ui:closedPanels") ?? "[]") as string[]);
  } catch {
    // Only a convenience.
  }
  for (const panel of document.querySelectorAll<HTMLDetailsElement>("details.panel[data-panel]")) {
    const name = panel.dataset.panel!;
    if (closed.has(name)) panel.open = false;
    panel.addEventListener("toggle", () => {
      if (panel.open) closed.delete(name);
      else closed.add(name);
      try {
        localStorage.setItem("ui:closedPanels", JSON.stringify([...closed]));
      } catch {
        // Only a convenience.
      }
    });
    for (const b of panel.querySelectorAll<HTMLButtonElement>(".panel-head button")) {
      b.addEventListener("click", (e) => {
        e.preventDefault();
        b.blur();
      });
    }
  }
}

/**
 * The bottom bar's Sidebar switch (and the S key) hides the right-hand panels
 * so the canvas gets the whole width. Remembered between launches.
 * Returns the toggle for the keyboard shortcut.
 */
export function setupSidebarToggle(): () => void {
  const app = document.getElementById("app")!;
  const button = document.getElementById("sidebar-toggle")!;
  const set = (hidden: boolean) => {
    app.classList.toggle("sidebar-hidden", hidden);
    button.classList.toggle("on", !hidden);
    button.title = hidden ? "Show the sidebar (S)" : "Hide the sidebar (S)";
    try {
      localStorage.setItem("ui:sidebarHidden", hidden ? "1" : "0");
    } catch {
      // Only a convenience.
    }
  };
  let hidden = false;
  try {
    hidden = localStorage.getItem("ui:sidebarHidden") === "1";
  } catch {
    // Show it.
  }
  set(hidden);
  const toggle = () => set(!app.classList.contains("sidebar-hidden"));
  button.addEventListener("click", () => {
    toggle();
    button.blur();
  });
  return toggle;
}

/**
 * Sliders built outside renderParamControls (sequencer volume, modulation
 * intensity, route amounts) get their track fill kept up to date here.
 */
export function setupRangeFill(): void {
  document.addEventListener("input", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "range") paintRange(e.target);
  });
  for (const r of document.querySelectorAll<HTMLInputElement>('input[type="range"]')) paintRange(r);
}
