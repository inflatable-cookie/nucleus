import "@inflatable-cookie/poodle-svelte-tokens/styles.css";
import "@inflatable-cookie/poodle-svelte-tokens/theme-cobalt.css";
import "@inflatable-cookie/poodle-svelte-tokens/density-compact.css";
import "@inflatable-cookie/poodle-svelte-tokens/control-size-sm.css";
import { mount } from "svelte";
import App from "./App.svelte";
import "./styles.css";

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
