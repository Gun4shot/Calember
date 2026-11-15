import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/jetbrains-mono/400.css";
import "maplibre-gl/dist/maplibre-gl.css";
import "./app.css";
import { EmberApp } from "./EmberApp";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EmberApp />
  </StrictMode>,
);
