import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/fraunces/400.css";
import "@fontsource/fraunces/400-italic.css";
import "@fontsource/fraunces/600.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./observatory.css";
import "./dossier.css";
import "./lab.css";
import { Observatory } from "./Observatory";

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

if (!hasWebGL()) {
  // no 3D on this device: say so plainly (the Observatory is a 3D app)
  createRoot(document.getElementById("root")!).render(
    <main className="nogl">
      <p className="kicker">Calember Observatory</p>
      <h1>This browser has 3D graphics turned off.</h1>
      <p>
        The Observatory draws the planet with WebGL. Turn on hardware acceleration in the browser settings, or open it in a recent Chrome, Edge, Firefox or
        Safari.
      </p>
      <p>
        <a href="./">Watch the story instead →</a>
      </p>
    </main>,
  );
} else {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Observatory />
    </StrictMode>,
  );
}
