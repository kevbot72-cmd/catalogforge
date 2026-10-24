import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { createDemoBackend } from "./backend/demo";
import { createTauriBackend, isTauri } from "./backend/tauri";
import { useApp } from "./store/app";
import "./styles.css";

// Desktop builds talk to the Rust engine; in a plain browser the app runs on demo data.
useApp.setState({ backend: isTauri() ? createTauriBackend() : createDemoBackend() });

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
