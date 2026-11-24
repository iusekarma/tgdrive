import { useState } from "react";

// Light, dark, or whatever the system says; remembered in this browser.

export type Theme = "system" | "light" | "dark";

const KEY = "tgdrive.theme";

function saved(): Theme {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

function apply(theme: Theme) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

/** Called before the first render, so the page doesn't flash the other theme. */
export const applySavedTheme = () => apply(saved());

export function useTheme(): [Theme, (theme: Theme) => void] {
  const [theme, setTheme] = useState(saved);
  function change(next: Theme) {
    setTheme(next);
    apply(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }
  return [theme, change];
}
