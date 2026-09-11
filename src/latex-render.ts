import { globalLatex } from './latex-definitions';

// Run before Obsidian's native math postprocessor; preserve native rendering.
export function prepareGlobalLatex(el: HTMLElement): void {
    for (const math of Array.from(el.querySelectorAll<HTMLElement>('.math:not(.is-loaded)'))) {
        const formula = globalLatex(math.textContent ?? '');
        if (formula) math.textContent = formula;
    }
}
