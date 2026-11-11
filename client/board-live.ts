import { createContext } from "react";

/** The web live channel owns updates while connected; native hosts keep polling. */
export const BoardLiveContext = createContext(false);
