// The real view as the camera breaks through the clouds over Punjab, 5 Nov 2015 (the story's hero day):
//  · NASA Worldview snapshot: Aqua MODIS true colour with MODIS fire marks (orange, in the image); the VIIRS S-NPP
//    fire layer of the same day (red on black) is screened on top and fades in as you scroll
//  · counts: every cleaned MODIS and VIIRS detection inside the Punjab & Haryana outline (story_extras.json)
// The pixel illustration that follows explains why the counts differ.

import { useEffect, useMemo, useRef } from "react";
import type { StoryData } from "./data";
import { fmt, ramp } from "./math";
import { film } from "./store";

/** Visible window on the legacy playhead t: while the camera breaks through the clouds over Punjab. */
export const DAY = [0.286, 0.344] as const;
// Worldview snapshot geometry (EPSG:4326): BBOX 27.6–32.6 N, 73.8–77.7 E at 780 × 1000 px → 200 px per degree
const IMG = { lat1: 32.6, lon0: 73.8, ppd: 200, w: 780, h: 1000 };
// shown crop: central Punjab, where the fires are (550 × 400 px of the snapshot)
const CROP = { lon0: 73.9, lon1: 76.65, lat0: 29.65, lat1: 31.65 };
const cx = (lon: number) => (lon - CROP.lon0) * IMG.ppd;
const cy = (lat: number) => (CROP.lat1 - lat) * IMG.ppd;
const CW = (CROP.lon1 - CROP.lon0) * IMG.ppd;
const CH = (CROP.lat1 - CROP.lat0) * IMG.ppd;

export function PunjabDay({ data }: { data: StoryData }) {
  const day = data.extras.punjab_day;
  const box = useRef<HTMLElement>(null);
  const imgRef = useRef<HTMLDivElement>(null);
  const viirsLayer = useRef<HTMLImageElement>(null);
  const nRefs = useRef<(HTMLSpanElement | null)[]>([]);
  const base = `${import.meta.env.BASE_URL}static/textures/`;

  const outline = useMemo(
    () => day.outline.map((ring) => ring.map(([lon, lat], i) => `${i ? "L" : "M"}${cx(lon).toFixed(1)},${cy(lat).toFixed(1)}`).join("") + "Z").join(""),
    [day],
  );

  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const t = film.t;
      const a = Math.min(ramp(DAY[0], DAY[0] + 0.007, t), 1 - ramp(DAY[1] - 0.007, DAY[1], t));
      if (box.current) {
        box.current.style.opacity = a.toFixed(3);
        box.current.style.visibility = a > 0.002 ? "visible" : "hidden";
        box.current.style.transform = `translate3d(0, ${((1 - a) * 18).toFixed(1)}px, 0)`;
      }
      if (a > 0.002) {
        // first MODIS (already in the image), then the VIIRS layer and its count; a slow push-in throughout
        const km = ramp(DAY[0] + 0.002, DAY[0] + 0.014, t);
        const kv = ramp(DAY[0] + 0.02, DAY[0] + 0.036, t);
        if (viirsLayer.current) viirsLayer.current.style.opacity = kv.toFixed(3);
        if (imgRef.current) imgRef.current.style.transform = `scale(${(1 + 0.08 * ramp(DAY[0], DAY[1], t)).toFixed(3)})`;
        if (nRefs.current[0]) nRefs.current[0].textContent = fmt(day.modis.length * km);
        if (nRefs.current[1]) nRefs.current[1].textContent = fmt(day.viirs.length * kv);
        if (box.current) box.current.dataset.stage = kv > 0.5 ? "viirs" : "modis";
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [day]);

  const ratio = day.viirs.length / Math.max(1, day.modis.length);
  const dateLabel = new Date(`${day.date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  const imgStyle = {
    width: `${(IMG.w / CW) * 100}%`,
    left: `${(-((CROP.lon0 - IMG.lon0) * IMG.ppd) / CW) * 100}%`,
    top: `${(-((IMG.lat1 - CROP.lat1) * IMG.ppd) / CH) * 100}%`,
  };
  return (
    <figure ref={box} className="dayfig" data-stage="modis" style={{ opacity: 0, visibility: "hidden" }} aria-label={`${day.region}, ${dateLabel}: ${day.modis.length} MODIS and ${day.viirs.length} VIIRS fire detections`}>
      <figcaption className="fp-head">
        <span className="fp-kicker">Real image · {dateLabel}</span>
        <b>The same afternoon over {day.region.replace(", India", "")}, seen by both eyes</b>
      </figcaption>
      <div className="day-real" style={{ aspectRatio: `${CW} / ${CH}` }}>
        <div ref={imgRef} className="day-push">
          <img
            src={`${base}punjab_modis_aqua_2015-11-05.jpg`}
            style={imgStyle}
            alt="Aqua MODIS true-colour satellite image of central Punjab on 5 November 2015, smoke haze with orange marks at MODIS fire detections."
            loading="lazy"
            decoding="async"
          />
          <img ref={viirsLayer} className="day-viirs" src={`${base}punjab_viirs_snpp_2015-11-05.jpg`} style={{ ...imgStyle, opacity: 0 }} alt="" aria-hidden="true" loading="lazy" decoding="async" />
          <svg viewBox={`0 0 ${CW} ${CH}`} className="day-outline" aria-hidden="true">
            <path d={outline} />
          </svg>
        </div>
        <span className="day-tag t-modis">orange: MODIS (Aqua)</span>
        <span className="day-tag t-viirs">red: VIIRS (Suomi NPP)</span>
      </div>
      <div className="day-counts">
        {(["MODIS", "VIIRS"] as const).map((s, m) => (
          <div key={s} className={`day-map dm-${m}`}>
            <span className="dm-n" ref={(el) => (nRefs.current[m] = el)}>
              0
            </span>
            <span className="dm-k">{s} detections · whole state</span>
          </div>
        ))}
      </div>
      <p className="dm-note">
        Same fires, same afternoon: VIIRS counted <b>{ratio.toFixed(1)}×</b> as many.
        <span className="photo-credit">NASA Worldview / GIBS · counts: cleaned FIRMS standard data</span>
      </p>
    </figure>
  );
}
