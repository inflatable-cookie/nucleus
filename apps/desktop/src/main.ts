import "@poodle/svelte-tokens/styles.css";
import "@poodle/svelte-tokens/theme-dark.css";
import "@poodle/svelte-tokens/density-compact.css";
import "@poodle/svelte-tokens/control-size-sm.css";
import { mount } from "svelte";
import App from "./App.svelte";
import "./styles.css";

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
