export interface WorkbenchPanel {
  slot: "side-nav" | "agent-feed" | "experiment" | "results";
  title: string;
  eyebrow: string;
  body: string;
  items: readonly string[];
  footer?: string;
}

export function renderPanel(panel: WorkbenchPanel): string {
  const itemsMarkup =
    panel.items.length > 0
      ? `<ul class="workbench-panel__list">${panel.items
          .map((item) => `<li>${escapeHtml(item)}</li>`)
          .join("")}</ul>`
      : "";
  const footerMarkup = panel.footer
    ? `<footer class="workbench-panel__footer">${escapeHtml(panel.footer)}</footer>`
    : "";

  return [
    `<section class="workbench-panel workbench-panel--${panel.slot}" data-panel="${panel.slot}" aria-labelledby="${panel.slot}-title">`,
    `<header class="workbench-panel__header"><span>${escapeHtml(panel.eyebrow)}</span><h2 id="${panel.slot}-title">${escapeHtml(panel.title)}</h2></header>`,
    `<div class="workbench-panel__body"><p>${escapeHtml(panel.body)}</p>${itemsMarkup}</div>`,
    footerMarkup,
    "</section>"
  ].join("");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
