import { useState, useEffect } from "react";

export function useTick(ms: number | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (ms === null) return;
    const timer = setInterval(() => tick(value => value + 1), ms);
    return () => clearInterval(timer);
  }, [ms]);
}
