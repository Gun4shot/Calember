import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { Intro, shouldPlayIntro } from "./film/Intro";
import { startScroll } from "./film/clock";
import { loadStory } from "./film/data";
import { Overlay } from "./film/Overlay";
import { useUI } from "./film/store";
import { SCROLL_SCREENS, buildCaptions } from "./film/timeline";

const Scene = lazy(() => import("./film/Scene").then((m) => ({ default: m.Scene })));

function hasWebGL() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

export default function App() {
  const data = useUI((s) => s.data);
  const error = useUI((s) => s.error);
  const setData = useUI((s) => s.setData);
  const setError = useUI((s) => s.setError);
  const webgl = useMemo(hasWebGL, []);
  const [intro, setIntro] = useState(() => webgl && shouldPlayIntro());
  useEffect(() => {
    if (!intro) document.body.dataset.intro = "done"; // no intro: the title ignites straight away
  }, [intro]);

  useEffect(() => {
    loadStory().then(setData, (e: unknown) => setError(String(e)));
    startScroll();
  }, [setData, setError]);

  return (
    <>
      <a className="skip-link" href="#transcript">
        Skip to the story as text
      </a>
      {/* the scroll track that drives the playhead */}
      <div className="scroll-track" style={{ height: `${SCROLL_SCREENS * 100}vh` }} aria-hidden="true" />
      {data && webgl && (
        <Suspense fallback={null}>
          <Scene data={data} />
        </Suspense>
      )}
      {data && <Overlay data={data} />}
      {intro && <Intro onDone={() => setIntro(false)} />}
      {!data && !error && <div className="loading">Loading the fire record…</div>}
      {error && <div className="loading">Could not load the story data. {error}</div>}
      {data && (
        <section id="transcript" className="sr-only" aria-label="The story as text">
          <h2>Calember: the story</h2>
          <ol>
            {buildCaptions(data).map((c) => (
              <li key={c.id}>
                {c.kicker ? `${c.kicker}: ` : ""}
                {c.text} {c.sub ?? ""} {c.tag ? `(${c.tag})` : ""}
              </li>
            ))}
          </ol>
          <p>
            Data: NASA FIRMS (MODIS C6.1, VIIRS 375 m). Imagery: NASA Earth Observatory, Black Marble 2016 and &ldquo;Stubble
            Burning in Punjab, India&rdquo; (VIIRS, 5 Nov 2015, J. Schmaltz, LANCE, NASA GSFC).
          </p>
        </section>
      )}
    </>
  );
}
