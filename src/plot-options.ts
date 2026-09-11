import type { PlotLine } from "./types";

export interface PlotOptions {
    xticks?: "auto" | "pi";
    yticks?: "auto" | "pi";
    xrangeScale?: "linear" | "log";
    yrangeScale?: "linear" | "log";
    aspect?: "auto" | "equal";
    yrange?: [number, number];
    title?: string;
    xlabel?: string;
    ylabel?: string;
    grid?: boolean;
    legend?: string;
    size?: [number, number];
}
export const legendPositions = ['auto', 'off', 'top-right', 'top-left', 'bottom-right', 'bottom-left', 'center'];
export const lineStyles = ['solid', 'dashed', 'dotted', 'dashdot'];
export function isPlotDirective(text: string): boolean {
    return /^\s*@(plot|parametric|polar|range|yrange|xscale|yscale|xticks|yticks|aspect|title|xlabel|ylabel|grid|legend|size|color|style|width)(?:\s|$)/u.test(text);
}

export function applyPlotOptions(plot: PlotLine, directives: { text: string; line: number }[]): void {
    const options: PlotOptions = {};
    const seen = new Set<string>();
    for (const { text, line } of directives) {
        try {
            const match = /^@(\w+)\s*(.*)$/u.exec(text)!;
            const key = match[1]!, value = match[2]!.trim();
            if (!value) throw new Error(`Enter a value after @${key}.`);
            if (['color', 'style', 'width'].includes(key)) {
                const style = /^(\d+)\s+(.+)$/u.exec(value);
                const index = style ? Number(style[1]) - 1 : -1;
                const curve = plot.curves?.[index];
                if (!style || !curve) throw new Error(`Use @${key} curve-number value; curve numbers start at 1.`);
                const setting = style[2]!.trim().replace(/^"(.*)"$/u, '$1');
                const unique = `${key}:${index}`;
                if (seen.has(unique)) throw new Error(`@${key} is repeated for curve ${index + 1}.`);
                seen.add(unique);
                if (key === 'color') {
                    if (!/^(?:[a-zA-Z]+|#[\da-fA-F]{3}|#[\da-fA-F]{6}|#[\da-fA-F]{8})$/.test(setting)) throw new Error('Use a color name or a quoted hex color, such as "#ff8800".');
                    curve.color = setting;
                } else if (key === 'style') {
                    if (!lineStyles.includes(setting)) throw new Error('Line style must be solid, dashed, dotted, or dashdot.');
                    curve.style = setting;
                } else {
                    const width = Number(setting);
                    if (!Number.isFinite(width) || width < 0.25 || width > 8) throw new Error('Line width must be between 0.25 and 8 points.');
                    curve.width = width;
                }
                continue;
            }
            if (seen.has(key)) throw new Error(`Use @${key} only once per block.`);
            seen.add(key);
            if (key === 'title' || key === 'xlabel' || key === 'ylabel') options[key] = value;
            else if (key === 'xticks' || key === 'yticks') {
                if (value !== 'auto' && value !== 'pi') throw new Error('Tick format must be auto or pi.');
                options[key] = value;
            }
            else if (key === 'xscale' || key === 'yscale') {
                if (value !== 'linear' && value !== 'log') throw new Error('Axis scale must be linear or log.');
                options[key === 'xscale' ? 'xrangeScale' : 'yrangeScale'] = value;
            } else if (key === 'aspect') {
                if (value !== 'auto' && value !== 'equal') throw new Error('Aspect must be auto or equal.');
                options.aspect = value;
            } else if (key === 'yrange') {
                const parts = value.split(',');
                const values = parts.map(part => Number(part.trim()));
                if (parts.length !== 2 || parts.some(part => !part.trim()) || !values.every(Number.isFinite) || values[0]! >= values[1]!) {
                    throw new Error('Use @yrange minimum, maximum with finite numbers and minimum below maximum.');
                }
                options.yrange = [values[0]!, values[1]!];
            } else if (key === 'grid') {
                if (value !== 'on' && value !== 'off') throw new Error('Use @grid on or @grid off.');
                options.grid = value === 'on';
            } else if (key === 'legend') {
                if (!legendPositions.includes(value)) throw new Error(`Legend must be ${legendPositions.join(', ')}.`);
                options.legend = value;
            } else if (key === 'size') {
                const values = value.split(',').map(part => Number(part.trim()));
                const [width, height] = values;
                if (values.length !== 2 || width === undefined || height === undefined || !Number.isFinite(width) || !Number.isFinite(height) ||
                    width < 2 || width > 16 || height < 2 || height > 12 || width * height > 120) {
                    throw new Error('Use @size width, height in inches: width 2–16, height 2–12, area at most 120.');
                }
                options.size = [width, height];
            }
        } catch (error) {
            throw new Error(`Line ${line}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    plot.options = options;
}
