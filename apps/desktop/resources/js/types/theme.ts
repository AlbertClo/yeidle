export const THEME_OPTIONS = [
    {
        value: 'light',
        label: 'Light',
        dark: false,
        preview: ['#ffffff', '#f5f5f5', '#0a0a0a', '#2563eb'],
    },
    {
        value: 'blush',
        label: 'Blush',
        dark: false,
        preview: ['#fff7fb', '#f4d9e6', '#2a1726', '#c2187a'],
    },
    {
        value: 'catppuccin-latte',
        label: 'Catppuccin Latte',
        dark: false,
        preview: ['#eff1f5', '#e6e9ef', '#4c4f69', '#1e66f5'],
    },
    {
        value: 'gruvbox-light',
        label: 'Gruvbox Light',
        dark: false,
        preview: ['#fbf1c7', '#ebdbb2', '#3c3836', '#076678'],
    },
    {
        value: 'solarized-light',
        label: 'Solarized Light',
        dark: false,
        preview: ['#fdf6e3', '#eee8d5', '#657b83', '#268bd2'],
    },
    {
        value: 'paper',
        label: 'Paper',
        dark: false,
        preview: ['#f7f3ea', '#d9dfcf', '#282a26', '#a44a2f'],
    },
    {
        value: 'dark',
        label: 'Dark',
        dark: true,
        preview: ['#0a0a0a', '#262626', '#fafafa', '#93bbfc'],
    },
    {
        value: 'catppuccin-mocha',
        label: 'Catppuccin Mocha',
        dark: true,
        preview: ['#1e1e2e', '#313244', '#cdd6f4', '#89b4fa'],
    },
    {
        value: 'gruvbox-dark',
        label: 'Gruvbox Dark',
        dark: true,
        preview: ['#282828', '#3c3836', '#ebdbb2', '#83a598'],
    },
    {
        value: 'tokyo-night',
        label: 'Tokyo Night',
        dark: true,
        preview: ['#1a1b26', '#24283b', '#c0caf5', '#7aa2f7'],
    },
    {
        value: 'cyberpunk',
        label: 'Cyberpunk',
        dark: true,
        preview: ['#160b2d', '#271344', '#f7f1ff', '#fcee0a'],
    },
    {
        value: 'nord',
        label: 'Nord',
        dark: true,
        preview: ['#2e3440', '#3b4252', '#eceff4', '#88c0d0'],
    },
    {
        value: 'solarized-dark',
        label: 'Solarized Dark',
        dark: true,
        preview: ['#002b36', '#073642', '#839496', '#268bd2'],
    },
    {
        value: 'cobalt2',
        label: 'Cobalt2',
        dark: true,
        preview: ['#193549', '#1f4662', '#ffffff', '#ffc600'],
    },
    {
        value: 'monokai',
        label: 'Monokai',
        dark: true,
        preview: ['#272822', '#34352f', '#f8f8f2', '#a6e22e'],
    },
] as const;

export type Theme = (typeof THEME_OPTIONS)[number]['value'];

export const DEFAULT_APPEARANCE = 'system' as const;

const themeValues = new Set<string>(THEME_OPTIONS.map((theme) => theme.value));
const darkThemeValues = new Set<Theme>(
    THEME_OPTIONS.filter((theme) => theme.dark).map((theme) => theme.value),
);

export function isTheme(value: unknown): value is Theme {
    return typeof value === 'string' && themeValues.has(value);
}

export function isDarkTheme(theme: Theme): boolean {
    return darkThemeValues.has(theme);
}
