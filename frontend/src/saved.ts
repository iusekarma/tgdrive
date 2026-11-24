import { useState } from "react";

/** An on/off choice, remembered in this browser under `key`. */
export function useSavedFlag(key: string): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  function change(next: boolean) {
    setOn(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      /* private mode: the choice just isn't remembered */
    }
  }
  return [on, change];
}
