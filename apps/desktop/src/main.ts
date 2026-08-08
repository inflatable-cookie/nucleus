import "@inflatable-cookie/poodle-core/tokens/styles.css";
import "@inflatable-cookie/poodle-core/tokens/theme-cobalt.css";
import "@inflatable-cookie/poodle-core/tokens/density-compact.css";
import "@inflatable-cookie/poodle-core/tokens/control-size-sm.css";
import { mount } from "svelte";
import App from "./App.svelte";
import "./styles.css";

const app = mount(App, {
  target: document.getElementById("app")!,
});

export default app;
