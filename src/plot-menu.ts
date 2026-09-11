import { Menu, type Component } from "obsidian";

export function registerPlotMenu(el: HTMLElement, owner: Component): void {
    owner.registerDomEvent(el, "contextmenu", event => {
        const target = event.target as HTMLElement | null;
        if (target?.tagName !== "IMG" || !target.classList.contains("pymath-plot")) return;
        const url = target.getAttribute("src");
        const name = target.getAttribute("data-pymath-download");
        if (!url?.startsWith("data:image/png;base64,") || !name) return;
        event.preventDefault();
        event.stopPropagation();
        new Menu().addItem(item => item.setTitle("Save PNG").setIcon("download").onClick(() => {
            const link = target.ownerDocument.createElement("a");
            link.href = url;
            link.download = name;
            link.click();
        })).showAtMouseEvent(event);
    });
}
